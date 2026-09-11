import { describe, it, expect, afterEach } from "vitest";
import { redisGate } from "./support/redis-gate";

// The attempt-lifecycle money boundary, run as REAL Lua against a REAL Redis
// through SRH — the same @upstash/redis REST path production uses.
//
// THIS SUITE MAY NOT RE-IMPLEMENT A SCRIPT. tests/reserve-id.test.ts used to
// hand-copy RESERVE_LUA into TypeScript and the copy drifted: it collapsed the
// -1/-2 return codes, so `reason: "cost"` was unreachable through it and a
// whole branch of the money boundary was covered by a test that could not fail
// on it. Every assertion here goes through the exported function and reads the
// real keys afterwards.
//
// Needs the local stack: `docker compose -f docker/compose.yml up -d`
// (or CI's redis+srh services, which is why this GATES rather than merely
// running locally). Skips — loudly — when unreachable.
const URL_ = process.env.TEST_UPSTASH_REDIS_REST_URL ?? "http://localhost:8079";
const TOKEN = process.env.TEST_UPSTASH_REDIS_REST_TOKEN ?? "passcontrol_local_dev_token";

async function srhReachable(): Promise<boolean> {
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(["PING"]),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const gate = redisGate({
  reachable: await srhReachable(),
  ci: process.env.CI === "true" || process.env.CI === "1",
  url: URL_,
});
const live = gate.run;
if (gate.fail) {
  // THROWN AT MODULE LOAD, so the lane goes red before a single `describe`
  // registers. A `describe.skipIf` here would report a PASS with skips, which
  // is precisely the outcome the playbook rejects as release evidence.
  throw new Error(gate.fail);
}
if (!live) {
  // eslint-disable-next-line no-console
  console.warn(
    `[holds.redis.test] SKIPPED — no SRH at ${URL_}. ` +
      "Start it with: docker compose -f docker/compose.yml up -d"
  );
}

process.env.UPSTASH_REDIS_REST_URL = URL_;
process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
const {
  openHold,
  settleKnown,
  settleUnknown,
  consumeDispatchPermission,
  releaseUndispatched,
  resolveHold,
  listOpenHolds,
  countOpenHolds,
  raiseSpentFloor,
  readEpoch,
  rebuildBudgetState,
} = await import("../lib/state/holds");
const { redis } = await import("../lib/state/redis");

const usedAgents: string[] = [];
function agent(): string {
  const agentId = `test-${crypto.randomUUID()}`;
  usedAgents.push(agentId);
  return agentId;
}

const num = async (key: string): Promise<number> => Number((await redis().get(key)) ?? 0);

afterEach(async () => {
  const r = redis();
  for (const agid of usedAgents.splice(0)) {
    const holdKeys = await r.keys(`hold:${agid}:*`);
    await r.del(
      `reserved:${agid}`,
      `spent:${agid}`,
      `reserved_cost:${agid}`,
      `spent_cost:${agid}`,
      `holds:${agid}`,
      `epoch:${agid}`,
      ...holdKeys
    );
  }
});

describe.skipIf(!live)("openHold — atomicity, idempotence and caps", () => {
  it("reserves under the cap and returns the running reservation", async () => {
    const agentId = agent();
    const r = await openHold({ agentId, attemptId: "a1", estimate: 40, capTokens: 100 });
    expect(r).toEqual({ ok: true, reserved: 40 });
    expect(await num(`reserved:${agentId}`)).toBe(40);
  });

  // Step 2. The transport-replay property. @upstash/redis defaults to
  // `retries ?? 5`, so an open whose fetch throws AFTER the server executed is
  // replayed by the client — and before this was keyed on the attempt, the
  // replay reserved the estimate a second time.
  it("opening twice with one attemptId reserves ONCE and reports the replay", async () => {
    const agentId = agent();
    const first = await openHold({ agentId, attemptId: "same", estimate: 40, capTokens: 100 });
    const second = await openHold({ agentId, attemptId: "same", estimate: 40, capTokens: 100 });

    expect(first.ok).toBe(true);
    expect(first.replay).toBeUndefined();
    expect(second.ok).toBe(true);
    expect(second.replay).toBe(true);
    expect(await num(`reserved:${agentId}`)).toBe(40);
  });

  // Step 3. A regression pin, and honestly labelled as one: the Lua was already
  // atomic here. It stays because atomicity is the property the whole design
  // rests on, and a future refactor that split the read from the write would
  // pass every other test in this file.
  it("cap 100, two simultaneous opens of 60 — exactly one succeeds", async () => {
    const agentId = agent();
    const [a, b] = await Promise.all([
      openHold({ agentId, attemptId: "c1", estimate: 60, capTokens: 100 }),
      openHold({ agentId, attemptId: "c2", estimate: 60, capTokens: 100 }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(await num(`reserved:${agentId}`)).toBe(60);
  });

  it("a refused open leaves NO reservation and no hold behind", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "h1", estimate: 60, capTokens: 100 });
    const over = await openHold({ agentId, attemptId: "h2", estimate: 41, capTokens: 100 });

    expect(over).toEqual({ ok: false, reason: "tokens" });
    expect(await num(`reserved:${agentId}`)).toBe(60);
    expect(await countOpenHolds(agentId)).toBe(1);
    // …so the remaining 40 is still reservable.
    expect((await openHold({ agentId, attemptId: "h3", estimate: 40, capTokens: 100 })).ok).toBe(true);
  });

  it("refuses on the COST cap distinctly from the token cap", async () => {
    const agentId = agent();
    const r = await openHold({
      agentId,
      attemptId: "x1",
      estimate: 1,
      estimateMicrocents: 5_000,
      capTokens: 1_000_000,
      capMicrocents: 100,
    });
    // The reason has to survive: 402 blocked_budget is answered for both, but
    // the operator's fix differs and the decision trace records which cap bit.
    expect(r).toEqual({ ok: false, reason: "cost" });
    expect(await num(`reserved:${agentId}`)).toBe(0);
    expect(await num(`reserved_cost:${agentId}`)).toBe(0);
  });

  // Step 10, both dimensions.
  it("a ZERO cap refuses unconditionally — including an estimate of zero", async () => {
    const agentId = agent();
    // Pinned by the old suite, and kept: cap 0 is not 'unlimited'.
    expect((await openHold({ agentId, attemptId: "z1", estimate: 1, capTokens: 0 })).ok).toBe(false);
    // NEW. A forwarded call can always spend, so a zero cap cannot admit an
    // attempt merely because its estimate rounded to nothing — and the
    // arithmetic alone would admit it, since 0 > 0 is false.
    expect((await openHold({ agentId, attemptId: "z2", estimate: 0, capTokens: 0 })).ok).toBe(false);
    expect(
      (await openHold({
        agentId,
        attemptId: "z3",
        estimate: 0,
        estimateMicrocents: 0,
        capTokens: null,
        capMicrocents: 0,
      })).ok
    ).toBe(false);
    expect(await countOpenHolds(agentId)).toBe(0);
  });

  // Inherited from tests/reserve.redis.test.ts, which this file supersedes.
  // A cap is a limit the agent may REACH, not one it must stay under — an
  // off-by-one here silently costs every agent its last request.
  it("allows landing exactly ON the cap (reserved + spent == cap)", async () => {
    const agentId = agent();
    expect((await openHold({ agentId, attemptId: "on1", estimate: 100, capTokens: 100 })).ok).toBe(true);
  });

  it("counts already-spent micro-cents against the COST cap independently", async () => {
    const agentId = agent();
    await redis().set(`spent_cost:${agentId}`, 900);
    // The token dimension is wide open; only the cost cap bites. The two caps
    // are checked separately and a refusal names which one.
    expect(
      (await openHold({
        agentId,
        attemptId: "cc1",
        estimate: 1,
        estimateMicrocents: 101,
        capTokens: null,
        capMicrocents: 1_000,
      })).reason
    ).toBe("cost");
    expect(
      (await openHold({
        agentId,
        attemptId: "cc2",
        estimate: 1,
        estimateMicrocents: 100,
        capTokens: null,
        capMicrocents: 1_000,
      })).ok
    ).toBe(true);
  });

  it("rolls BOTH dimensions back together when only the cost cap fails", async () => {
    const agentId = agent();
    expect(
      (await openHold({
        agentId,
        attemptId: "rb1",
        estimate: 10,
        estimateMicrocents: 5_000,
        capTokens: 1_000_000,
        capMicrocents: 100,
      })).ok
    ).toBe(false);
    // The token reservation must not survive a cost refusal, or a cost-capped
    // agent would leak token budget on every call it was refused for.
    expect(await num(`reserved:${agentId}`)).toBe(0);
    expect(await num(`reserved_cost:${agentId}`)).toBe(0);
  });

  it("a null cap is unlimited", async () => {
    const agentId = agent();
    const r = await openHold({ agentId, attemptId: "u1", estimate: 10_000_000, capTokens: null });
    expect(r.ok).toBe(true);
  });

  it("counts already-spent against the cap", async () => {
    const agentId = agent();
    await redis().set(`spent:${agentId}`, 90);
    expect((await openHold({ agentId, attemptId: "s1", estimate: 11, capTokens: 100 })).ok).toBe(false);
    expect((await openHold({ agentId, attemptId: "s2", estimate: 10, capTokens: 100 })).ok).toBe(true);
  });

  // Inherited from tests/reserve-id.test.ts, which this replaces.
  //
  // That file's real insight was that two concurrent requests sharing ONE visa
  // jti are two separate reservations — the id has to be per attempt, or one
  // request's settle releases the other's money. It is kept here and retargeted
  // at the holds index.
  //
  // The rest of that file was a hand-written TypeScript re-implementation of the
  // reserve Lua, and it had already drifted: it collapsed the -1 and -2 return
  // codes into one, so `reason: "cost"` was unreachable through it and an entire
  // branch of the money boundary was covered by a test that could not fail on
  // it. Running the real script removes that hazard rather than repairing it.
  it("two concurrent attempts under ONE visa are two holds, summed once", async () => {
    const agentId = agent();
    await Promise.all([
      openHold({ agentId, attemptId: "req-1", estimate: 30, capTokens: 1_000 }),
      openHold({ agentId, attemptId: "req-2", estimate: 40, capTokens: 1_000 }),
    ]);

    expect(await countOpenHolds(agentId)).toBe(2);
    expect(await num(`reserved:${agentId}`)).toBe(70);

    // And settling one leaves the other's money exactly where it was. This is
    // what a shared id would have broken.
    await settleKnown({ agentId, attemptId: "req-1", tokens: 30, microcents: 0 });
    expect(await num(`reserved:${agentId}`)).toBe(40);
    expect(await countOpenHolds(agentId)).toBe(1);
  });

  // Step 6, and the assertion that pins the DELETED mechanism itself. Marker
  // TTL existed to drive self-heal by expiry, and that mechanism WAS the bug.
  // Without this, nothing stops someone reintroducing a TTL as "hygiene".
  it("AN OPEN HOLD HAS NO TTL — expiry must never be what releases money", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "t1", estimate: 25, capTokens: 1_000 });
    expect(await redis().ttl(`hold:${agentId}:t1`)).toBe(-1);
  });
});

describe.skipIf(!live)("dispatch permission — one attempt, one upstream send", () => {
  it("reports an un-dispatched hold as still releasable", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "dispatch-never", estimate: 10, capTokens: null });

    const [listed] = await listOpenHolds(agentId);
    expect(listed).toMatchObject({ attemptId: "dispatch-never", mayHaveDispatched: false });

    // And the release really is available — the phase is not decoration.
    const release = await releaseUndispatched({ agentId, attemptId: "dispatch-never" });
    expect(release).toMatchObject({ applied: true });
  });

  it("permits exactly one dispatcher after a hold opens", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "dispatch-once", estimate: 10, capTokens: null });

    const [first, second] = await Promise.all([
      consumeDispatchPermission({ agentId, attemptId: "dispatch-once" }),
      consumeDispatchPermission({ agentId, attemptId: "dispatch-once" }),
    ]);

    expect([first.granted, second.granted].filter(Boolean)).toHaveLength(1);
    expect([first.reason, second.reason]).toContain("already_dispatched");
  });

  it("does not release a hold once dispatch may have happened", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "dispatch-retain", estimate: 10, capTokens: null });
    expect(await consumeDispatchPermission({ agentId, attemptId: "dispatch-retain" })).toEqual({
      granted: true,
    });

    const release = await releaseUndispatched({ agentId, attemptId: "dispatch-retain" });
    expect(release).toMatchObject({ applied: false, conflict: true });

    // AND THE OPERATOR CAN SEE WHY BEFORE THEY TRY. `listOpenHolds` reports the
    // phase, so the holds list can say which attempts are still releasable
    // instead of making a human discover it one refused request at a time.
    const [listed] = await listOpenHolds(agentId);
    expect(listed).toMatchObject({ attemptId: "dispatch-retain", mayHaveDispatched: true });
    expect(await num(`reserved:${agentId}`)).toBe(10);
  });
});

describe.skipIf(!live)("terminal certainty is per accounting dimension", () => {
  it("charges complete tokens while retaining an unpriceable money reservation", async () => {
    const agentId = agent();
    await openHold({
      agentId,
      attemptId: "mixed-certainty",
      estimate: 100,
      estimateMicrocents: 900,
      capTokens: null,
      capMicrocents: null,
    });

    const settled = await settleKnown({
      agentId,
      attemptId: "mixed-certainty",
      tokens: 7,
      microcents: 0,
      moneyCertainty: "unknown",
    });

    expect(settled).toMatchObject({ applied: true, appliedTokens: 7, appliedMicrocents: 900 });
    expect(await num(`spent:${agentId}`)).toBe(7);
    expect(await num(`spent_cost:${agentId}`)).toBe(900);
  });
});

describe.skipIf(!live)("settlement — idempotence and the stored estimate", () => {
  // Step 1. The defect: settlement ran as a raw pipeline with no attempt-keyed
  // guard, so a client retry after the server had executed replayed the delta.
  it("settling twice with identical arguments moves the counters ONCE", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "d1", estimate: 100, estimateMicrocents: 900, capTokens: null, capMicrocents: null });

    const first = await settleKnown({ agentId, attemptId: "d1", tokens: 40, microcents: 300 });
    const second = await settleKnown({ agentId, attemptId: "d1", tokens: 40, microcents: 300 });

    expect(first.applied).toBe(true);
    // The replay reports what the FIRST transition applied, so a caller cannot
    // tell the two apart by their answer — only by `applied`.
    expect(second).toEqual({ applied: false, appliedTokens: 40, appliedMicrocents: 300 });
    expect(await num(`spent:${agentId}`)).toBe(40);
    expect(await num(`spent_cost:${agentId}`)).toBe(300);
    expect(await num(`reserved:${agentId}`)).toBe(0);
    expect(await num(`reserved_cost:${agentId}`)).toBe(0);
  });

  // Step 4. The caller passes only OBSERVED figures; the release comes from the
  // stored estimate. Before this, settlement was handed an estimate by the
  // caller and any disagreement drifted `reserved:` permanently.
  it("releases the STORED estimate even when the caller's own figures disagree", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "e1", estimate: 500, capTokens: null });
    expect(await num(`reserved:${agentId}`)).toBe(500);

    // 40 observed against a 500 hold. The release is 500, not 40.
    await settleKnown({ agentId, attemptId: "e1", tokens: 40, microcents: 0 });
    expect(await num(`reserved:${agentId}`)).toBe(0);
    expect(await num(`spent:${agentId}`)).toBe(40);
  });

  // Step 5. The headline reversal. A broken stream used to settle at zero — the
  // full hold refunded for tokens the provider had actually generated.
  it("an unknown ending NEVER refunds: open 1200, observed 40 → spent 1200", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "k1", estimate: 1_200, estimateMicrocents: 8_000, capTokens: null, capMicrocents: null });

    const r = await settleUnknown({ agentId, attemptId: "k1", tokens: 40, microcents: 90 });

    expect(r.appliedTokens).toBe(1_200);
    expect(r.appliedMicrocents).toBe(8_000);
    expect(await num(`reserved:${agentId}`)).toBe(0);
    expect(await num(`spent:${agentId}`)).toBe(1_200);
    expect(await num(`spent_cost:${agentId}`)).toBe(8_000);
  });

  it("an unknown ending keeps the OBSERVED figure when it exceeds the estimate", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "k2", estimate: 100, estimateMicrocents: 10, capTokens: null, capMicrocents: null });
    const r = await settleUnknown({ agentId, attemptId: "k2", tokens: 900, microcents: 77 });
    // max(observed, estimate) in BOTH dimensions independently — a call can
    // under-estimate tokens and over-estimate cost in the same attempt.
    expect(r.appliedTokens).toBe(900);
    expect(r.appliedMicrocents).toBe(77);
    expect(await num(`spent:${agentId}`)).toBe(900);
  });

  it("an undispatched attempt is the one full release", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "n1", estimate: 300, estimateMicrocents: 400, capTokens: null, capMicrocents: null });
    const r = await releaseUndispatched({ agentId, attemptId: "n1" });

    expect(r.appliedTokens).toBe(0);
    expect(await num(`reserved:${agentId}`)).toBe(0);
    expect(await num(`spent:${agentId}`)).toBe(0);
    expect(await countOpenHolds(agentId)).toBe(0);
  });

  // NO HOLD ⇒ NO DELTA, EVER. The old pipeline would happily DECRBY against a
  // reservation that did not exist, driving `reserved:` negative — which is
  // capacity created out of nothing.
  it("settling an attempt that never opened moves NOTHING and reports an anomaly", async () => {
    const agentId = agent();
    await redis().set(`reserved:${agentId}`, 50);
    await redis().set(`spent:${agentId}`, 10);

    const r = await settleKnown({ agentId, attemptId: "ghost", tokens: 999, microcents: 999 });

    expect(r).toEqual({ applied: false, appliedTokens: 0, appliedMicrocents: 0, anomaly: true });
    expect(await num(`reserved:${agentId}`)).toBe(50);
    expect(await num(`spent:${agentId}`)).toBe(10);
  });

  it("a settled hold becomes a legible tombstone rather than vanishing", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "tb", estimate: 10, capTokens: null });
    await settleKnown({ agentId, attemptId: "tb", tokens: 10, microcents: 0 });

    // A TTL, so it does not accumulate forever…
    const ttl = await redis().ttl(`hold:${agentId}:tb`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900);
    // …and it is out of the open index, so an operator is never shown it.
    expect(await countOpenHolds(agentId)).toBe(0);
  });

  it("a mixed sequence of endings leaves the counters exactly balanced", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "m1", estimate: 100, capTokens: null });
    await openHold({ agentId, attemptId: "m2", estimate: 200, capTokens: null });
    await openHold({ agentId, attemptId: "m3", estimate: 300, capTokens: null });
    expect(await num(`reserved:${agentId}`)).toBe(600);

    await settleKnown({ agentId, attemptId: "m1", tokens: 10, microcents: 0 });
    await settleUnknown({ agentId, attemptId: "m2", tokens: 5, microcents: 0 });
    await releaseUndispatched({ agentId, attemptId: "m3" });

    expect(await num(`reserved:${agentId}`)).toBe(0);
    expect(await num(`spent:${agentId}`)).toBe(210); // 10 + max(5,200) + 0
    expect(await countOpenHolds(agentId)).toBe(0);
  });
});

describe.skipIf(!live)("unresolved holds and operator resolution", () => {
  // Step 6. The worker died between reserve and settle. The capacity stays
  // consumed and the record stays open — deliberately, forever, until a human
  // decides. Nothing about time may release it.
  it("an unresolved hold survives indefinitely and stays counted", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "orphan", estimate: 750, estimateMicrocents: 200, capTokens: null, capMicrocents: null });

    expect(await num(`reserved:${agentId}`)).toBe(750);
    expect(await redis().ttl(`hold:${agentId}:orphan`)).toBe(-1);

    const open = await listOpenHolds(agentId);
    expect(open).toHaveLength(1);
    expect(open[0]?.attemptId).toBe("orphan");
    expect(open[0]?.estimateTokens).toBe(750);
    expect(open[0]?.estimateMicrocents).toBe(200);
    expect(open[0]?.createdAtMs).toBeGreaterThan(0);
  });

  // Step 7. Resolution goes through the same compare-and-set as every other
  // transition, so double-refunding is impossible BY CONSTRUCTION rather than
  // by an operator being careful.
  it("operator resolution applies exactly once across two calls", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "r1", estimate: 750, capTokens: null });

    const first = await resolveHold({ agentId, attemptId: "r1", tokens: 400, microcents: 55 });
    const second = await resolveHold({ agentId, attemptId: "r1", tokens: 400, microcents: 55 });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.appliedTokens).toBe(400);
    expect(await num(`spent:${agentId}`)).toBe(400);
    expect(await num(`reserved:${agentId}`)).toBe(0);
    expect(await countOpenHolds(agentId)).toBe(0);
  });

  it("a resolution of 'not spent' releases, and a later one cannot re-open it", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "r2", estimate: 750, capTokens: null });
    await resolveHold({ agentId, attemptId: "r2", tokens: 0, microcents: 0 });
    expect(await num(`spent:${agentId}`)).toBe(0);
    expect(await num(`reserved:${agentId}`)).toBe(0);

    // A second, contradictory decision is refused — the first one stands.
    const again = await resolveHold({ agentId, attemptId: "r2", tokens: 750, microcents: 0 });
    expect(again.applied).toBe(false);
    expect(await num(`spent:${agentId}`)).toBe(0);
  });
});

describe.skipIf(!live)("budget state: first initialisation vs. loss", () => {
  // Step 9.
  it("no epoch anywhere is a FIRST INIT: mints, seeds zero, admits", async () => {
    const agentId = agent();
    await redis().set(`spent:${agentId}`, 5_000); // stale value from nowhere

    // A cap far above the stale value on purpose. The seed is NX, so what is
    // under test is that first-init does not CLOBBER a live counter — and a cap
    // tight enough to refuse the open would never reach that question.
    const r = await openHold({
      agentId,
      attemptId: "f1",
      estimate: 10,
      capTokens: 1_000_000,
      budgetState: { epoch: null, established: false },
    });

    expect(r.ok).toBe(true);
    expect(r.epochToPersist).toBeTruthy();
    // The value handed back MUST be the one Redis actually holds. Reporting the
    // uuid this call happened to generate instead is what bricks an agent: the
    // caller writes it to Postgres, and every later call compares that against
    // the live epoch, mismatches, and refuses forever.
    expect(await readEpoch(agentId)).toBe(r.epochToPersist);
    // NX, so a value that is already there wins — the seed is a floor for a
    // cold agent, not a reset of one that has been running.
    expect(await num(`spent:${agentId}`)).toBe(5_000);
  });

  it("first init on a genuinely cold agent starts enforcement at zero", async () => {
    const agentId = agent();
    const r = await openHold({
      agentId,
      attemptId: "f2",
      estimate: 10,
      capTokens: 1_000,
      budgetState: { epoch: null, established: false },
    });
    expect(r.ok).toBe(true);
    // Deliberate: an agent newly given a budget starts at zero whatever its
    // prior agent_logs history says. Enforcement begins when the budget does.
    expect(await num(`spent:${agentId}`)).toBe(0);
  });

  // Step 8. THE REPLACEMENT FOR seedSpent. That function NX-seeded from the
  // visa's `st` claim — minted from agents.spent_tokens, a best-effort mirror
  // lib/log.ts drops silently on RPC failure — so after a flush it
  // re-initialised from an older, LOWER number and granted back the difference.
  it("Postgres says established but Redis has no epoch → refuses, counters untouched", async () => {
    const agentId = agent();
    await redis().set(`spent:${agentId}`, 900);
    await redis().set(`reserved:${agentId}`, 0);

    const r = await openHold({
      agentId,
      attemptId: "l1",
      estimate: 10,
      capTokens: 1_000,
      budgetState: { epoch: "epoch-from-postgres", established: true },
    });

    // NOT a cap denial. `state` must reach the proxy as 503, never as the 402
    // an agent reads as "I am out of budget" and stops retrying for.
    expect(r).toEqual({ ok: false, reason: "state" });
    expect(await num(`reserved:${agentId}`)).toBe(0);
    expect(await num(`spent:${agentId}`)).toBe(900);
    expect(await countOpenHolds(agentId)).toBe(0);
  });

  it("an epoch that disagrees with Postgres refuses the same way", async () => {
    const agentId = agent();
    await redis().set(`epoch:${agentId}`, "some-other-epoch");
    const r = await openHold({
      agentId,
      attemptId: "l2",
      estimate: 10,
      capTokens: 1_000,
      budgetState: { epoch: "epoch-from-postgres", established: true },
    });
    expect(r).toEqual({ ok: false, reason: "state" });
  });

  it("a matching epoch takes the normal path", async () => {
    const agentId = agent();
    await redis().set(`epoch:${agentId}`, "agreed");
    // The tag and the four counters are what an established agent actually
    // carries; hand-building only the epoch now describes state that no code
    // path can produce, and is refused as pre-format legacy.
    await redis().set(`acctfmt:${agentId}`, "1");
    for (const c of ["spent", "spent_cost", "reserved", "reserved_cost"]) {
      await redis().set(`${c}:${agentId}`, 0, { nx: true });
    }
    const r = await openHold({
      agentId,
      attemptId: "l3",
      estimate: 10,
      capTokens: 1_000,
      budgetState: { epoch: "agreed", established: true },
    });
    expect(r.ok).toBe(true);
    // Nothing owed to Postgres: it already knows.
    expect(r.epochToPersist).toBeUndefined();
    expect(await num(`reserved:${agentId}`)).toBe(10);
  });

  // ── A DELIBERATE DEVIATION FROM THE PLANNED STATE TABLE, PINNED HERE ───────
  //
  // The plan's table reads "epoch present and ≠ Postgres ⇒ refuse", for ANY
  // value of the Postgres column. Taken literally that bricks an agent for a
  // full cache window: first-init mints the epoch in Redis, but the agent-policy
  // cache the check reads from still carries `established: false` for up to 60
  // seconds afterwards — so every call in that window would see a present epoch
  // disagreeing with a Postgres value of null, and refuse.
  //
  // So the check enforces only when Postgres says state WAS established. When it
  // says otherwise there is, by definition, nothing yet worth protecting: the
  // window is the one in which the agent has spent approximately nothing, and it
  // closes as soon as the establish write lands and the policy cache is purged.
  // That purge is not optional — without it this window is one full cache TTL
  // from whenever the entry was written, rather than from first-init.
  //
  // ONE CHANGE TO THIS TEST, MADE FOR S3-06 AND WORTH STATING. It used to build
  // the state by hand — `SET epoch:<agid>` and nothing else — and that is a
  // state production cannot produce: first-init mints the epoch, seeds all four
  // counters and writes the format tag inside ONE script, so an epoch never
  // exists alone. The only way to reach "epoch, no counters" is eviction, which
  // is loss, and the branch now refuses it. The window this test pins is real;
  // the shortcut used to enter it was not, so it now enters through a genuine
  // first call. Every assertion below is the original one.
  it("Postgres not established + a live epoch present ADMITS, and does not refuse", async () => {
    const agentId = agent();
    const init = await openHold({
      agentId,
      attemptId: "w0",
      estimate: 10,
      capTokens: 1_000,
      budgetState: { epoch: null, established: false },
    });
    expect(init.ok).toBe(true);
    const minted = init.epochToPersist as string;
    await settleKnown({ agentId, attemptId: "w0", tokens: 10, microcents: 0 });

    const r = await openHold({
      agentId,
      attemptId: "w1",
      estimate: 10,
      capTokens: 1_000,
      // A stale cache entry, written before the establish write landed.
      budgetState: { epoch: null, established: false },
    });

    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    // The existing epoch is left exactly as it was — a re-mint here would make
    // the value Postgres is about to record disagree with the live one forever.
    expect(await readEpoch(agentId)).toBe(minted);
    // AND the caller is told to persist THAT value, not a fresh one. This is the
    // assertion that would have caught the brick: before it, openHold reported a
    // newly generated uuid that had never been written to Redis at all.
    expect(r.epochToPersist).toBe(minted);
    expect(await num(`reserved:${agentId}`)).toBe(10);
  });

  // The end-to-end shape of the defect the field name now guards against. This
  // is the sequence a real agent performs on the first budgeted call of its life,
  // including the retry that used to poison it.
  it("first-init → persist → next call: the agent is admitted, not bricked", async () => {
    const agentId = agent();

    // 1. First ever budgeted call. Postgres knows nothing.
    const first = await openHold({
      agentId,
      attemptId: "b1",
      estimate: 10,
      capTokens: 1_000,
      budgetState: { epoch: null, established: false },
    });
    expect(first.ok).toBe(true);
    const minted = first.epochToPersist;
    expect(minted).toBeTruthy();

    // 2. A second call arrives before the Postgres write has been read back —
    //    the establish write landed but the policy cache is still 60s stale.
    //    It must report the SAME epoch, or step 3 refuses forever.
    const second = await openHold({
      agentId,
      attemptId: "b2",
      estimate: 10,
      capTokens: 1_000,
      budgetState: { epoch: null, established: false },
    });
    expect(second.ok).toBe(true);
    expect(second.epochToPersist).toBe(minted);

    // 3. The cache refreshes and Postgres now says established, carrying the
    //    epoch that was persisted. The agent keeps working.
    const third = await openHold({
      agentId,
      attemptId: "b3",
      estimate: 10,
      capTokens: 1_000,
      budgetState: { epoch: minted ?? null, established: true },
    });
    expect(third).toMatchObject({ ok: true });
    expect(third.reason).toBeUndefined();
  });

  it("an UNBUDGETED agent is never subject to the state check", async () => {
    const agentId = agent();
    // No budgetState at all — the proxy omits it when both caps are null, which
    // is where seedSpent used to be skipped for the same reason.
    const r = await openHold({ agentId, attemptId: "nb", estimate: 10, capTokens: null });
    expect(r.ok).toBe(true);
    expect(await readEpoch(agentId)).toBeNull();
  });
});

describe.skipIf(!live)("raiseSpentFloor — the cron's monotone raise", () => {
  // Step 11's Redis half. The cron used to `SET` spent: from a lagged RPC
  // total, erasing every settlement that landed inside the lag window.
  it("never lowers a counter that is already higher", async () => {
    const agentId = agent();
    await redis().set(`spent:${agentId}`, 120);
    await redis().set(`spent_cost:${agentId}`, 900);

    const r = await raiseSpentFloor({ agentId, tokens: 100, microcents: 100 });

    expect(r.raised).toBe(false);
    expect(await num(`spent:${agentId}`)).toBe(120);
    expect(await num(`spent_cost:${agentId}`)).toBe(900);
  });

  it("raises a counter that is behind, per dimension", async () => {
    const agentId = agent();
    await redis().set(`spent:${agentId}`, 10);
    await redis().set(`spent_cost:${agentId}`, 900);

    const r = await raiseSpentFloor({ agentId, tokens: 100, microcents: 100 });

    expect(r.raised).toBe(true);
    expect(await num(`spent:${agentId}`)).toBe(100);
    // The cost dimension was ahead and is left alone — the two move
    // independently, so a raise cannot drag one down while lifting the other.
    expect(await num(`spent_cost:${agentId}`)).toBe(900);
  });

  /**
   * REVERSED DELIBERATELY. This test used to assert the opposite — that a floor
   * SEEDS a counter that does not exist — and that behaviour is what contract
   * item 11 forbids: the floor's input is a lagged, incomplete agent_logs
   * total, so creating a counter from it establishes lost accounting from an
   * incomplete audit sum, on a cron, unnoticed.
   *
   * Nothing legitimate depended on the old behaviour. Every budgeted agent now
   * has all four counters seeded at mint, so a missing one means loss, not
   * newness; and an agent with no counters at all is unbudgeted, where a spend
   * floor means nothing.
   */
  it("does not create a counter that does not exist", async () => {
    const agentId = agent();
    const r = await raiseSpentFloor({ agentId, tokens: 42, microcents: 7 });
    expect(r.raised).toBe(false);
    expect(await redis().exists(`spent:${agentId}`)).toBe(0);
    expect(await redis().exists(`spent_cost:${agentId}`)).toBe(0);
  });
});

describe.skipIf(!live)("what an abandoned hold tells its operator", () => {
  // An attempt that never settled wrote no agent_logs row, so it has no
  // receipt, and its attempt id appears nowhere else in the product. Provider,
  // model and started-at are the entire basis on which a human matches it to a
  // line on the provider's billing page and decides whether it was charged.
  it("carries the provider and model through to the hold list", async () => {
    const agentId = agent();
    await openHold({
      agentId,
      attemptId: "ident1",
      estimate: 80,
      capTokens: null,
      provider: "anthropic",
      model: "claude-opus-5",
    });
    const [hold] = await listOpenHolds(agentId);
    expect(hold).toMatchObject({
      attemptId: "ident1",
      provider: "anthropic",
      model: "claude-opus-5",
      estimateTokens: 80,
    });
    expect(hold!.createdAtMs).toBeGreaterThan(0);
  });

  // Nothing in a transition reads them, so an omitted pair must not change a
  // single figure — it costs the operator identification, not correctness.
  it("opens and settles identically when neither is supplied", async () => {
    const agentId = agent();
    const opened = await openHold({ agentId, attemptId: "ident2", estimate: 80, capTokens: 100 });
    expect(opened).toEqual({ ok: true, reserved: 80 });
    const [hold] = await listOpenHolds(agentId);
    expect(hold).toMatchObject({ provider: "", model: "" });
    expect((await settleKnown({ agentId, attemptId: "ident2", tokens: 5, microcents: 0 })).applied).toBe(true);
    expect(await num(`spent:${agentId}`)).toBe(5);
    expect(await num(`reserved:${agentId}`)).toBe(0);
  });
});

describe.skipIf(!live)("rebuildBudgetState — the one sanctioned lowering", () => {
  it("rebases spent from the caller and reserved from the open holds", async () => {
    const agentId = agent();
    await redis().set(`spent:${agentId}`, 99_999);
    await openHold({ agentId, attemptId: "rb1", estimate: 100, estimateMicrocents: 10, capTokens: null, capMicrocents: null });
    await openHold({ agentId, attemptId: "rb2", estimate: 250, estimateMicrocents: 20, capTokens: null, capMicrocents: null });
    await openHold({ agentId, attemptId: "rb3", estimate: 400, estimateMicrocents: 30, capTokens: null, capMicrocents: null });
    await settleKnown({ agentId, attemptId: "rb3", tokens: 1, microcents: 1 });

    const out = await rebuildBudgetState({
      agentId,
      epoch: "fresh-epoch",
      spentTokens: 500,
      spentMicrocents: 60,
    });

    // reserved comes from the holds still OPEN — the settled one is excluded.
    // The counter already held that figure, having been maintained by the
    // transitions themselves, so the rebuild agrees with it rather than
    // rewriting it: `seededReserved` is false and the two sums match.
    expect(out).toEqual({
      reservedTokens: 350,
      reservedMicrocents: 30,
      computedReservedTokens: 350,
      computedReservedMicrocents: 30,
      openHolds: 2,
      seededReserved: false,
      truncated: false,
    });
    expect(await num(`reserved:${agentId}`)).toBe(350);
    expect(await num(`reserved_cost:${agentId}`)).toBe(30);
    // The lowering this route exists for. 99_999 down to 500, in one write.
    expect(await num(`spent:${agentId}`)).toBe(500);
    expect(await readEpoch(agentId)).toBe("fresh-epoch");
  });

  // THE REGRESSION THAT MATTERS. The first version of rebuildBudgetState read
  // the holds, summed them, and SET `reserved:` to the total — the same
  // read-then-write shape the plan deleted from lib/reconcile.ts. A hold opening
  // between the read and the write had its INCRBY overwritten, and its later
  // settle then decremented from a counter that no longer knew about it,
  // driving `reserved:` NEGATIVE and handing out capacity.
  //
  // Simulated by opening the hold before the rebuild and passing a computed sum
  // that predates it: with a SET, `reserved:` would land on the stale 0.
  it("cannot lower reserved beneath a hold that opened during the rebuild", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "race1", estimate: 300, capTokens: null });
    expect(await num(`reserved:${agentId}`)).toBe(300);

    await rebuildBudgetState({ agentId, epoch: "e-race", spentTokens: 0, spentMicrocents: 0 });
    // Untouched: the transitions own this counter, and they had it right.
    expect(await num(`reserved:${agentId}`)).toBe(300);

    // And the settle still lands on a counter that knows about the hold, rather
    // than taking a zeroed one below zero.
    await settleKnown({ agentId, attemptId: "race1", tokens: 10, microcents: 0 });
    expect(await num(`reserved:${agentId}`)).toBe(0);
    expect(await num(`spent:${agentId}`)).toBe(10);
  });

  // The one case a rebuild can actually improve: the counter was lost outright
  // while the hold records survived. Absent, not zero — INCRBY creates the key,
  // so an absent key proves no transition has touched it.
  it("seeds reserved only when the counter was genuinely lost", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "lost1", estimate: 120, estimateMicrocents: 9, capTokens: null, capMicrocents: null });
    await redis().del(`reserved:${agentId}`, `reserved_cost:${agentId}`);

    const out = await rebuildBudgetState({ agentId, epoch: "e-lost", spentTokens: 0, spentMicrocents: 0 });
    expect(out.seededReserved).toBe(true);
    expect(await num(`reserved:${agentId}`)).toBe(120);
    expect(await num(`reserved_cost:${agentId}`)).toBe(9);
    expect(out.computedReservedTokens).toBe(120);
  });

  // Re-running is the operator's normal move — they reach for a rebuild when
  // they have stopped trusting anything, including the first rebuild.
  it("is safe to re-run", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "twice1", estimate: 60, capTokens: null });
    const first = await rebuildBudgetState({ agentId, epoch: "e-a", spentTokens: 77, spentMicrocents: 5 });
    const second = await rebuildBudgetState({ agentId, epoch: "e-b", spentTokens: 77, spentMicrocents: 5 });
    expect(second.reservedTokens).toBe(first.reservedTokens);
    expect(await num(`spent:${agentId}`)).toBe(77);
    expect(await readEpoch(agentId)).toBe("e-b");
  });

  it("a rebuilt agent is admitted again, at the rebuilt figures", async () => {
    const agentId = agent();
    // State loss: Postgres established, Redis empty.
    const refused = await openHold({
      agentId,
      attemptId: "rb4",
      estimate: 10,
      capTokens: 1_000,
      budgetState: { epoch: "e1", established: true },
    });
    expect(refused.reason).toBe("state");

    await rebuildBudgetState({ agentId, epoch: "e1", spentTokens: 995, spentMicrocents: 0 });

    // Admitted now, and the rebuilt spend is enforced: 995 + 10 fits under
    // 1000, 995 + 6 more does not.
    expect((await openHold({ agentId, attemptId: "rb5", estimate: 5, capTokens: 1_000, budgetState: { epoch: "e1", established: true } })).ok).toBe(true);
    expect((await openHold({ agentId, attemptId: "rb6", estimate: 5, capTokens: 1_000, budgetState: { epoch: "e1", established: true } })).ok).toBe(false);
  });
});

/**
 * CONTRACT ITEM 2 — a counter that is GONE is not a counter that reads zero.
 *
 * The epoch check catches a total Redis loss: the key vanishes, Postgres still
 * says established, and admission refuses. It cannot catch a PARTIAL loss.
 * Eviction under a maxmemory policy takes keys individually, and every counter
 * read in OPEN_LUA was written `tonumber(redis.call('GET', k) or '0')` — so an
 * evicted `spent:` silently became a spend of zero and handed the agent its
 * entire budget back, with the epoch intact and nothing to notice.
 *
 * Presence alone cannot decide this, which is the trap: `reserved:` is created
 * by INCRBY on the first successful open, so an agent that minted and was then
 * refused by its cap legitimately has no `reserved:` key at all. Refusing that
 * agent would brick it permanently. The format tag is what makes the check
 * decidable — it says "this agent's state was written by a version that seeds
 * all four", and only then does a missing counter mean loss.
 */
describe.skipIf(!live)("a missing counter is loss, not a zero balance", () => {
  async function minted(capTokens: number | null = 1_000) {
    const agentId = agent();
    const first = await openHold({
      agentId,
      attemptId: "mint",
      estimate: 10,
      capTokens,
      budgetState: { epoch: null, established: false },
    });
    // Settled so the agent starts these cases clean; an open mint hold would
    // make every open-count assertion below read one higher for a reason that
    // has nothing to do with what is under test.
    if (first.ok) await settleKnown({ agentId, attemptId: "mint", tokens: 10, microcents: 0 });
    return { agentId, epoch: first.epochToPersist ?? null, first };
  }

  it("seeds all four counters at mint", async () => {
    const { agentId } = await minted();
    for (const key of ["spent", "spent_cost", "reserved", "reserved_cost"]) {
      expect(await redis().exists(`${key}:${agentId}`), `${key} was not seeded`).toBe(1);
    }
  });

  /**
   * THE BRICK THIS CHECK COULD EASILY HAVE CAUSED, pinned so it cannot come
   * back. A first call refused by a zero cap still mints the epoch and still
   * establishes the agent in Postgres — but it never reaches the INCRBY, so
   * without seeding, `reserved:` would not exist. Every later call would then
   * see an established agent with a missing counter and refuse 503 forever, on
   * an agent that has never spent anything.
   */
  it("an agent whose first call was refused by its cap still works when the cap is raised", async () => {
    const agentId = agent();
    const refused = await openHold({
      agentId,
      attemptId: "capped",
      estimate: 10,
      capTokens: 0,
      budgetState: { epoch: null, established: false },
    });
    expect(refused.ok).toBe(false);
    const epoch = refused.epochToPersist;
    expect(epoch, "a refused first call still mints and must report its epoch").toBeTruthy();

    const later = await openHold({
      agentId,
      attemptId: "uncapped",
      estimate: 10,
      capTokens: 1_000,
      budgetState: { epoch: epoch ?? null, established: true },
    });
    expect(later.ok).toBe(true);
  });

  it.each(["spent", "spent_cost", "reserved", "reserved_cost"])(
    "refuses admission when %s has been lost",
    async (key) => {
      const { agentId, epoch } = await minted();
      const spentBefore = await num(`spent:${agentId}`);
      await redis().del(`${key}:${agentId}`);

      const r = await openHold({
        agentId,
        attemptId: `lost-${key}`,
        estimate: 10,
        capTokens: 1_000,
        budgetState: { epoch, established: true },
      });

      // `state`, never a cap denial: this is an operator-recoverable fault and
      // the agent must not be told it is out of money.
      expect(r).toEqual({ ok: false, reason: "state" });
      expect(await countOpenHolds(agentId)).toBe(0);
      if (key !== "spent") expect(await num(`spent:${agentId}`)).toBe(spentBefore);
    }
  );

  it("refuses an established agent whose state predates the accounting format", async () => {
    const { agentId, epoch } = await minted();
    // Exactly the shape a pre-change deployment left behind: a coherent epoch
    // and four counters, written by a version that did not seed or tag them.
    await redis().del(`acctfmt:${agentId}`);

    const r = await openHold({
      agentId,
      attemptId: "untagged",
      estimate: 10,
      capTokens: 1_000,
      budgetState: { epoch, established: true },
    });
    expect(r).toEqual({ ok: false, reason: "state" });
  });

  /**
   * ITEM 11's PROHIBITION, ENFORCED WHERE IT CAN ACTUALLY BE BROKEN. The floor
   * is a server-side max, which reads a missing key as 0 — so `max(0, floor)`
   * would WRITE the floor and thereby establish a lost counter from a lagged,
   * incomplete `agent_logs` total. That is "never initialize from an incomplete
   * audit sum", arriving through the one path allowed to touch spend.
   */
  it("the reconcile floor cannot resurrect a counter that is gone", async () => {
    const { agentId } = await minted();
    await redis().del(`spent:${agentId}`);

    const r = await raiseSpentFloor({ agentId, tokens: 5_000, microcents: 6_000 });

    expect(r.raised).toBe(false);
    expect(await redis().exists(`spent:${agentId}`)).toBe(0);
  });

  it("still raises a floor on an intact agent", async () => {
    const { agentId } = await minted();
    const r = await raiseSpentFloor({ agentId, tokens: 5_000, microcents: 6_000 });
    expect(r.raised).toBe(true);
    expect(await num(`spent:${agentId}`)).toBe(5_000);
  });
});

/**
 * CONTRACT ITEMS 3 AND 8 — a transition belongs to the generation it opened in.
 *
 * Every hold binds an attempt to an agent, an estimate and a dispatch target,
 * but not to the accounting generation it was opened under. SETTLE_LUA took six
 * keys and none of them was the epoch, so it could not tell a settle from the
 * current generation from one that had been in flight across a rebuild.
 *
 * That is the gap the operator recovery path opens by design: `rebuild` writes a
 * NEW epoch and recomputes the counters. A worker that opened its hold before
 * the rebuild and settles after it would then apply a debit computed against
 * counters that no longer exist — or, worse, release a reservation the rebuild
 * has already accounted for, handing back capacity twice.
 */
describe.skipIf(!live)("a transition cannot cross a generation boundary", () => {
  async function established() {
    const agentId = agent();
    const first = await openHold({
      agentId,
      attemptId: "gen-seed",
      estimate: 10,
      capTokens: 10_000,
      budgetState: { epoch: null, established: false },
    });
    await settleKnown({ agentId, attemptId: "gen-seed", tokens: 10, microcents: 0 });
    return { agentId, epoch: first.epochToPersist! };
  }

  it("stamps the generation onto the hold when it opens", async () => {
    const { agentId, epoch } = await established();
    await openHold({
      agentId,
      attemptId: "gen-1",
      estimate: 50,
      capTokens: 10_000,
      budgetState: { epoch, established: true },
    });
    const stamped = await redis().hget<string>(`hold:${agentId}:gen-1`, "ep");
    expect(stamped).toBe(epoch);
  });

  it("refuses a settle from a generation that has been replaced", async () => {
    const { agentId, epoch } = await established();
    await openHold({
      agentId,
      attemptId: "gen-stale",
      estimate: 50,
      capTokens: 10_000,
      budgetState: { epoch, established: true },
    });

    // The operator recovers the agent: a new generation, counters recomputed.
    await rebuildBudgetState({
      agentId,
      epoch: "generation-two",
      spentTokens: 999,
      spentMicrocents: 0,
    });
    const spentAfterRebuild = await num(`spent:${agentId}`);

    // The old worker finally finishes and settles against the generation it
    // opened in. It must move nothing.
    const stale = await settleKnown({
      agentId,
      attemptId: "gen-stale",
      tokens: 40,
      microcents: 7,
    });

    expect(stale).toMatchObject({ applied: false, conflict: true });
    expect(await num(`spent:${agentId}`)).toBe(spentAfterRebuild);
  });

  it("a hold opened in the current generation settles normally", async () => {
    const { agentId, epoch } = await established();
    await openHold({
      agentId,
      attemptId: "gen-ok",
      estimate: 50,
      capTokens: 10_000,
      budgetState: { epoch, established: true },
    });
    const r = await settleKnown({ agentId, attemptId: "gen-ok", tokens: 40, microcents: 7 });
    expect(r).toMatchObject({ applied: true, appliedTokens: 40 });
  });

  it("an unbudgeted agent's holds are not fenced, and still settle", async () => {
    // No budgetState at all: there is no generation to bind to, and refusing
    // these would strand money in holds that can never close.
    const agentId = agent();
    await openHold({ agentId, attemptId: "nogen", estimate: 10, capTokens: null });
    const r = await settleKnown({ agentId, attemptId: "nogen", tokens: 10, microcents: 0 });
    expect(r).toMatchObject({ applied: true });
  });
});

/**
 * CONTRACT ITEM 8 — THE ACCEPTED REPLAY HORIZON, stated and tested rather than
 * argued.
 *
 * Terminal holds carry a 900-second tombstone so a duplicate settle returns the
 * first result instead of finding nothing. Past that window the record is gone,
 * and the contract requires that its disappearance never become permission to
 * run the attempt again.
 *
 * The argument that it cannot is short, and it was until now only an argument:
 * attempt ids are SERVER-OWNED and minted fresh per upstream attempt
 * (crypto.randomUUID in the proxy's runAttempt), so no client can present an
 * old one, and an internal retry lives far inside 900s. What follows pins the
 * behaviour the argument relies on, so a future change that lets an attempt id
 * in from outside fails here rather than silently widening the horizon.
 */
describe.skipIf(!live)("an expired terminal marker is not permission to run again", () => {
  it("a settle after the tombstone is gone moves nothing and says so", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "gone", estimate: 100, capTokens: null });
    await settleKnown({ agentId, attemptId: "gone", tokens: 100, microcents: 0 });
    const spentAfterFirst = await num(`spent:${agentId}`);

    // What expiry looks like, without waiting 900 seconds for it.
    await redis().del(`hold:${agentId}:gone`);

    const again = await settleKnown({ agentId, attemptId: "gone", tokens: 100, microcents: 0 });

    // `anomaly`, not a second debit and not a refund. The script refuses to
    // guess what an attempt it has no record of reserved.
    expect(again).toMatchObject({ applied: false, anomaly: true });
    expect(await num(`spent:${agentId}`)).toBe(spentAfterFirst);
  });

  it("dispatch permission cannot be claimed once the record is gone", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "gone2", estimate: 100, capTokens: null });
    await settleKnown({ agentId, attemptId: "gone2", tokens: 100, microcents: 0 });
    await redis().del(`hold:${agentId}:gone2`);

    // THE PROPERTY THAT MATTERS. An expired marker must not read as a fresh
    // pre-dispatch hold, because that is exactly the shape a replayed old
    // attempt would arrive in, and granting it would authorise a second send of
    // a request that already happened.
    expect(await consumeDispatchPermission({ agentId, attemptId: "gone2" })).toEqual({
      granted: false,
      reason: "missing",
    });
  });

  it("a terminal hold still inside the window refuses dispatch too", async () => {
    const agentId = agent();
    await openHold({ agentId, attemptId: "closed", estimate: 100, capTokens: null });
    await settleKnown({ agentId, attemptId: "closed", tokens: 100, microcents: 0 });

    expect(await consumeDispatchPermission({ agentId, attemptId: "closed" })).toEqual({
      granted: false,
      reason: "terminal",
    });
  });
});

// Session 02: admission's missing-counter guard must survive a late settlement.
describe.skipIf(!live)("Session 02 — partial state loss followed by settlement", () => {
  it.each(["spent", "spent_cost"])(
    "does not reopen admission after settlement recreates a lost %s counter",
    async (lostCounter) => {
      const agentId = agent();
      const first = await openHold({
        agentId, attemptId: "prior", estimate: 80, estimateMicrocents: 80,
        capTokens: 100, capMicrocents: 100,
        budgetState: { epoch: null, established: false },
      });
      expect(first.ok).toBe(true);
      expect(first.epochToPersist).toBeTruthy();
      const budgetState = { epoch: first.epochToPersist!, established: true };
      await consumeDispatchPermission({ agentId, attemptId: "prior" });
      await settleKnown({ agentId, attemptId: "prior", tokens: 80, microcents: 80 });
      expect(await num(`spent:${agentId}`)).toBe(80);
      expect(await num(`spent_cost:${agentId}`)).toBe(80);

      expect((await openHold({
        agentId, attemptId: "in-flight", estimate: 10, estimateMicrocents: 10,
        capTokens: 100, capMicrocents: 100, budgetState,
      })).ok).toBe(true);
      expect((await consumeDispatchPermission({ agentId, attemptId: "in-flight" })).granted).toBe(true);
      await redis().del(`${lostCounter}:${agentId}`);
      const next = {
        agentId, attemptId: "after-loss", estimate: lostCounter === "spent" ? 20 : 0,
        estimateMicrocents: lostCounter === "spent_cost" ? 20 : 0,
        capTokens: 100, capMicrocents: 100, budgetState,
      };
      expect(await openHold(next)).toMatchObject({ ok: false, reason: "state" });

      await settleKnown({ agentId, attemptId: "in-flight", tokens: 10, microcents: 10 });
      const balance = await num(`${lostCounter}:${agentId}`);
      const admission = await openHold(next);
      // Either retain the true 90 debit or keep the damaged generation blocked.
      // Current code reports balance=10 and admits another 20 against a cap of 100.
      expect(admission.ok, `lost ${lostCounter}; post-settlement balance=${balance}`).toBe(false);
    },
  );
});

// The other half of the same guard. Codex's cases above cover the two SPEND
// counters; these cover the two RESERVATION counters, where the old behaviour
// was strictly worse: DECRBY on a missing key creates it NEGATIVE, so the
// resurrected value is not merely a forgotten debit but standing extra headroom
// that every later call gets to spend against.
describe.skipIf(!live)("Session 02 — reservation-counter loss followed by settlement", () => {
  it.each(["reserved", "reserved_cost"])(
    "does not reopen admission after settlement recreates a lost %s counter",
    async (lostCounter) => {
      const agentId = agent();
      const first = await openHold({
        agentId, attemptId: "prior", estimate: 80, estimateMicrocents: 80,
        capTokens: 100, capMicrocents: 100,
        budgetState: { epoch: null, established: false },
      });
      expect(first.ok).toBe(true);
      const budgetState = { epoch: first.epochToPersist!, established: true };
      await consumeDispatchPermission({ agentId, attemptId: "prior" });
      await settleKnown({ agentId, attemptId: "prior", tokens: 80, microcents: 80 });

      expect((await openHold({
        agentId, attemptId: "in-flight", estimate: 10, estimateMicrocents: 10,
        capTokens: 100, capMicrocents: 100, budgetState,
      })).ok).toBe(true);
      expect((await consumeDispatchPermission({ agentId, attemptId: "in-flight" })).granted).toBe(true);
      await redis().del(`${lostCounter}:${agentId}`);

      const settled = await settleKnown({ agentId, attemptId: "in-flight", tokens: 10, microcents: 10 });
      // Reported, not swallowed: the operator surfaces need to tell "your
      // counters are gone, rebuild" apart from a replay, and the audit row
      // needs the real charge or the rebuild that reads it comes back short.
      expect(settled).toMatchObject({ applied: false, degraded: true, appliedTokens: 10 });
      // The counter is still ABSENT. Recreating it — at zero, or at minus the
      // estimate — is the whole defect.
      expect(await redis().exists(`${lostCounter}:${agentId}`)).toBe(0);
      expect(await openHold({
        agentId, attemptId: "after-loss", estimate: 5, estimateMicrocents: 5,
        capTokens: 100, capMicrocents: 100, budgetState,
      })).toMatchObject({ ok: false, reason: "state" });
    },
  );

  // The guard keys off the hold's generation stamp, and two populations carry
  // one legitimately while their counters are brand new. Session 01 already
  // bricked an agent once by enforcing a presence rule against a shape that had
  // not been seeded yet; this is that shape.
  it("a freshly minted agent settles normally — the guard does not fire on it", async () => {
    const agentId = agent();
    const first = await openHold({
      agentId, attemptId: "m1", estimate: 30, estimateMicrocents: 30,
      capTokens: 100, capMicrocents: 100,
      budgetState: { epoch: null, established: false },
    });
    expect(first.ok).toBe(true);
    await consumeDispatchPermission({ agentId, attemptId: "m1" });
    const settled = await settleKnown({ agentId, attemptId: "m1", tokens: 30, microcents: 30 });
    expect(settled).toMatchObject({ applied: true, appliedTokens: 30 });
    expect(settled.degraded).toBeUndefined();
    expect(await num(`spent:${agentId}`)).toBe(30);
    expect(await num(`reserved:${agentId}`)).toBe(0);
  });

  // An unbudgeted agent is never seeded any counter and carries no stamp, so
  // enforcing presence on it would refuse every settle it ever makes.
  it("an unbudgeted agent still settles, creating its counters as before", async () => {
    const agentId = agent();
    expect((await openHold({ agentId, attemptId: "u1", estimate: 40, capTokens: null })).ok).toBe(true);
    const settled = await settleKnown({ agentId, attemptId: "u1", tokens: 40, microcents: 0 });
    expect(settled).toMatchObject({ applied: true, appliedTokens: 40 });
    expect(await num(`spent:${agentId}`)).toBe(40);
  });
});

// The ledger write that follows a degraded settle is the only record of that
// charge. If it fails, the operator's way out is to run the same resolve again
// — which only works if a replay says "still degraded" rather than "already
// handled". This is that property.
describe.skipIf(!live)("Session 02 — a degraded settle stays degraded on replay", () => {
  it("reports degraded again, with the same figures, so the ledger write is retryable", async () => {
    const agentId = agent();
    const first = await openHold({
      agentId, attemptId: "r1", estimate: 50, estimateMicrocents: 50,
      capTokens: 100, capMicrocents: 100,
      budgetState: { epoch: null, established: false },
    });
    const budgetState = { epoch: first.epochToPersist!, established: true };
    await consumeDispatchPermission({ agentId, attemptId: "r1" });
    await redis().del(`spent:${agentId}`);

    const once = await settleKnown({ agentId, attemptId: "r1", tokens: 7, microcents: 8 });
    expect(once).toMatchObject({ applied: false, degraded: true, appliedTokens: 7, appliedMicrocents: 8 });

    const twice = await settleKnown({ agentId, attemptId: "r1", tokens: 7, microcents: 8 });
    expect(twice).toMatchObject({ applied: false, degraded: true, appliedTokens: 7, appliedMicrocents: 8 });
    // Still no resurrection on the second pass either.
    expect(await redis().exists(`spent:${agentId}`)).toBe(0);
    expect((await openHold({
      agentId, attemptId: "r2", estimate: 1, capTokens: 100, capMicrocents: 100, budgetState,
    })).ok).toBe(false);
  });
});

// Session 02 part 4: the proxy can log observed usage after a settlement
// transport failure BEFORE execution. That leaves this dispatched hold open.
describe.skipIf(!live)("Session 02 — operator overstatement reachability", () => {
  it("accepts an overstatement after counters are lost and pins it on replay", async () => {
    const agentId = agent();
    const attemptId = crypto.randomUUID();
    await openHold({
      agentId, attemptId, estimate: 20000, estimateMicrocents: 3000000,
      capTokens: 1000000, capMicrocents: 100000000,
      budgetState: { epoch: null, established: false },
    });
    await consumeDispatchPermission({ agentId, attemptId });
    // No settle command executed. The independently recorded provider usage
    // was 19412 / 2156000; an operator subsequently types ten times that.
    expect(await countOpenHolds(agentId)).toBe(1);
    await redis().del(`spent:${agentId}`);
    expect(await resolveHold({ agentId, attemptId, tokens: 194120, microcents: 21560000 }))
      .toMatchObject({ degraded: true, appliedTokens: 194120, appliedMicrocents: 21560000 });
    expect(await resolveHold({ agentId, attemptId, tokens: 19412, microcents: 2156000 }))
      .toMatchObject({ degraded: true, appliedTokens: 194120, appliedMicrocents: 21560000 });
  });
});

/**
 * S3-06. The establishment bit rides in the agent-policy CACHE, and a cache can
 * be stale — its purge is a `waitUntil` whose result the route ignores.
 *
 * The `established: true` branch checks the format tag and all four counters
 * before admitting, because an epoch agreeing proves the generation and not the
 * counters. The `established: false` branch, reached with an epoch already live,
 * did neither: it reported the live epoch and carried on. So one stale boolean
 * turned partial Redis loss from a refusal into a silent re-seed, and an agent
 * that had spent its cap got the difference back as spendable capacity.
 *
 * The state is reachable without any race at all — the first call's policy purge
 * simply failing is enough — and S3-01's stale-fill window made it reachable
 * even after a purge that succeeded.
 */
describe.skipIf(!live)("a stale 'not established' bit is not a licence to re-seed", () => {
  async function spending(): Promise<{ agentId: string; epoch: string }> {
    const agentId = agent();
    const first = await openHold({
      agentId,
      attemptId: "mint",
      estimate: 10,
      capTokens: 1_000,
      budgetState: { epoch: null, established: false },
    });
    expect(first.ok).toBe(true);
    await settleKnown({ agentId, attemptId: "mint", tokens: 10, microcents: 0 });
    const epoch = first.epochToPersist;
    expect(epoch).toBeTruthy();
    // History: this agent has spent nearly its whole cap.
    await redis().set(`spent:${agentId}`, 900);
    return { agentId, epoch: epoch as string };
  }

  it.each(["spent", "spent_cost", "reserved", "reserved_cost"])(
    "refuses when %s is lost and an epoch is already live, whatever the cache bit says",
    async (key) => {
      const { agentId } = await spending();
      await redis().del(`${key}:${agentId}`);

      const out = await openHold({
        agentId,
        attemptId: `stale-${key}`,
        estimate: 200,
        capTokens: 1_000,
        // The stale cache value. Postgres knows better by now; this does not.
        budgetState: { epoch: null, established: false },
      });

      expect(out.ok).toBe(false);
      expect(out.ok === false && out.reason).toBe("state");
    }
  );

  it("does not treat a missing spend counter as a zero balance", async () => {
    const { agentId } = await spending();
    await redis().del(`spent:${agentId}`);

    await openHold({
      agentId,
      attemptId: "stale-refund",
      estimate: 200,
      capTokens: 1_000,
      budgetState: { epoch: null, established: false },
    });

    // The refusal has to happen BEFORE any arithmetic. A rejected admission that
    // still recreated the counter would hand back the 900 it could not read.
    expect(await redis().exists(`spent:${agentId}`)).toBe(0);
    expect(await num(`reserved:${agentId}`)).toBe(0);
  });

  it("refuses the same loss when the cache bit is current, exactly as before", async () => {
    // The control. This branch already refused, and the fix must not have
    // changed it — if both sides now refuse for the same reason, the test above
    // is proving nothing about the branch it names.
    const { agentId, epoch } = await spending();
    await redis().del(`spent:${agentId}`);

    const out = await openHold({
      agentId,
      attemptId: "current",
      estimate: 200,
      capTokens: 1_000,
      budgetState: { epoch, established: true },
    });
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.reason).toBe("state");
  });

  it("still initialises a genuinely new agent, which is what the branch is for", async () => {
    // No epoch, no counters, `established: false` — the honest version of the
    // state the stale bit imitates. Hardening the branch must not brick a first
    // call, which is the only thing it legitimately serves.
    const agentId = agent();
    const out = await openHold({
      agentId,
      attemptId: "genuine-first",
      estimate: 10,
      capTokens: 1_000,
      budgetState: { epoch: null, established: false },
    });

    expect(out.ok).toBe(true);
    expect(out.epochToPersist).toBeTruthy();
    for (const key of ["spent", "spent_cost", "reserved", "reserved_cost"]) {
      expect(await redis().exists(`${key}:${agentId}`), `${key} was not seeded`).toBe(1);
    }
  });

  it("still adopts a live epoch when Postgres has not read the mint back yet", async () => {
    // The other legitimate visitor to this branch: the mint landed, the Postgres
    // write did not. Counters and format ARE present, so it must still pass —
    // the check being added is a presence check, not a ban on the branch.
    const agentId = agent();
    const first = await openHold({
      agentId,
      attemptId: "mint",
      estimate: 10,
      capTokens: 1_000,
      budgetState: { epoch: null, established: false },
    });
    expect(first.ok).toBe(true);

    const second = await openHold({
      agentId,
      attemptId: "again",
      estimate: 10,
      capTokens: 1_000,
      budgetState: { epoch: null, established: false },
    });
    expect(second.ok).toBe(true);
    // Reports what EXISTS, never a second mint.
    expect(second.epochToPersist).toBe(first.epochToPersist);
  });
});
