import { describe, it, expect, afterEach } from "vitest";
import { redisGate } from "./support/redis-gate";

// K1 — the periodic spend limit, as REAL Lua on a REAL Redis through SRH.
//
// Period usage is DERIVED: the one cumulative `spent_cost:` counter minus a
// snapshot of it taken when the period began (`pbase:`), plus reservations in
// flight. These tests pin the rules that make that derivation safe (N1–N6):
// the limit is checked in the same eval that reserves; the
// snapshot only moves forward; a settle after a boundary counts toward the new
// period; a missing snapshot is never zero usage; removal deletes it; a rebuild
// rewrites it from the ledger. Every assertion goes through the exported
// functions and reads the real keys afterwards — no script is re-implemented.
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
if (gate.fail) throw new Error(gate.fail);
if (!live) {
  // eslint-disable-next-line no-console
  console.warn(`[holds-period.redis.test] SKIPPED — no SRH at ${URL_}.`);
}

process.env.UPSTASH_REDIS_REST_URL = URL_;
process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
const {
  openHold,
  settleKnown,
  settleUnknown,
  raiseSpentFloor,
  rebuildBudgetState,
  readPeriodUsageMany,
  periodKeys,
  secondsUntilPeriodEnd,
  periodStart,
} = await import("../lib/state/holds");
type PeriodLimit = import("../lib/state/holds").PeriodLimit;
const { redis } = await import("../lib/state/redis");

// Two minutes either side of a UTC midnight, and a moment in the next month.
const D = Date.parse("2026-09-30T23:58:00.000Z");
const D1 = Date.parse("2026-10-01T00:02:00.000Z");
const D1_LATER = Date.parse("2026-10-01T09:00:00.000Z");

const usedAgents: string[] = [];
function agent(): string {
  const agentId = `test-${crypto.randomUUID()}`;
  usedAgents.push(agentId);
  return agentId;
}
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
      `acctfmt:${agid}`,
      `pbase:${agid}`,
      ...holdKeys
    );
  }
});

const num = async (key: string): Promise<number> => Number((await redis().get(key)) ?? 0);
const snapshot = async (agentId: string) =>
  (await redis().hgetall<Record<string, string>>(`pbase:${agentId}`)) ?? null;

const perDay = (capMicrocents: number): PeriodLimit => ({ mode: "set", kind: "day", capMicrocents });

/**
 * A budgeted agent with a daily limit, established the way the proxy does it:
 * the first open mints the generation and asks for a period seed; the retry
 * supplies the ledger's figure. Returns the epoch every later call presents.
 */
async function establish(agentId: string, capMicrocents: number, seed = 0, nowMs = D): Promise<string> {
  const first = await openHold({
    agentId,
    attemptId: `init-${crypto.randomUUID()}`,
    estimate: 0,
    estimateMicrocents: 0,
    capTokens: null,
    capMicrocents: null,
    budgetState: { epoch: null, established: false },
    periodLimit: perDay(capMicrocents),
    nowMs,
  });
  expect(first).toMatchObject({ ok: false, needsPeriodSeed: true });
  expect(first.epochToPersist).toBeTruthy();
  const epoch = first.epochToPersist!;
  const seedAttempt = `seed-${crypto.randomUUID()}`;
  const seeded = await openHold({
    agentId,
    attemptId: seedAttempt,
    estimate: 0,
    estimateMicrocents: 0,
    capTokens: null,
    capMicrocents: null,
    budgetState: { epoch, established: true },
    periodLimit: perDay(capMicrocents),
    periodSeedMicrocents: seed,
    nowMs,
  });
  // A zero-cost open with a zero cap is refused; everything else is admitted.
  if (capMicrocents > 0) {
    expect(seeded.ok).toBe(true);
    await settleKnown({ agentId, attemptId: seedAttempt, tokens: 0, microcents: 0, nowMs });
  }
  return epoch;
}

function open(
  agentId: string,
  epoch: string,
  costMicrocents: number,
  opts: { nowMs?: number; period?: PeriodLimit; attemptId?: string; seed?: number } = {}
) {
  return openHold({
    agentId,
    attemptId: opts.attemptId ?? crypto.randomUUID(),
    estimate: 1,
    estimateMicrocents: costMicrocents,
    capTokens: null,
    capMicrocents: null,
    budgetState: { epoch, established: true },
    periodLimit: opts.period ?? perDay(1000),
    ...(opts.seed === undefined ? {} : { periodSeedMicrocents: opts.seed }),
    nowMs: opts.nowMs ?? D,
  });
}

describe.skipIf(!live)("period helpers", () => {
  it("names UTC periods and counts down to the next boundary", () => {
    expect(periodKeys(D)).toEqual({ day: "d:2026-09-30", month: "m:2026-09" });
    expect(periodKeys(D1)).toEqual({ day: "d:2026-10-01", month: "m:2026-10" });
    expect(secondsUntilPeriodEnd("day", D)).toBe(120);
    expect(secondsUntilPeriodEnd("month", D)).toBe(120);
    expect(secondsUntilPeriodEnd("day", D1)).toBe(24 * 3600 - 120);
    expect(periodStart("day", D1_LATER).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(periodStart("month", D1_LATER).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe.skipIf(!live)("N4 — no snapshot is never zero usage", () => {
  it("asks for a seed, reserves nothing, and still hands back a freshly minted epoch", async () => {
    const agentId = agent();
    const r = await openHold({
      agentId,
      attemptId: "first",
      estimate: 10,
      estimateMicrocents: 500,
      capTokens: null,
      capMicrocents: null,
      budgetState: { epoch: null, established: false },
      periodLimit: perDay(1000),
      nowMs: D,
    });
    expect(r).toMatchObject({ ok: false, needsPeriodSeed: true });
    expect(r.epochToPersist).toBeTruthy();
    expect(await num(`reserved_cost:${agentId}`)).toBe(0);
    expect(await redis().exists(`hold:${agentId}:first`)).toBe(0);
    expect(await snapshot(agentId)).toBeNull();
  });

  it("counts the ledger's spend so far this period once seeded", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000, 900);
    expect((await open(agentId, epoch, 200)).reason).toBe("period");
    expect((await open(agentId, epoch, 100)).ok).toBe(true);
  });

  it("uses the first seed when two first calls race, and ignores the second", async () => {
    const agentId = agent();
    const first = await openHold({
      agentId,
      attemptId: "a",
      estimate: 0,
      capTokens: null,
      capMicrocents: null,
      budgetState: { epoch: null, established: false },
      periodLimit: perDay(1000),
      nowMs: D,
    });
    const epoch = first.epochToPersist!;
    const [one, two] = await Promise.all([
      open(agentId, epoch, 0, { seed: 300 }),
      open(agentId, epoch, 0, { seed: 700 }),
    ]);
    expect(one.ok && two.ok).toBe(true);
    // Whichever landed first set the snapshot; the other found it valid.
    const bc = Number((await snapshot(agentId))!.bc);
    expect([-300, -700]).toContain(bc);
  });

  it("treats a snapshot from another generation as absent", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    await redis().hset(`pbase:${agentId}`, { ep: "some-older-generation" });
    expect(await open(agentId, epoch, 10)).toMatchObject({ ok: false, needsPeriodSeed: true });
  });

  it("treats a day snapshot as absent once the limit is monthly", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    const monthly: PeriodLimit = { mode: "set", kind: "month", capMicrocents: 1000 };
    expect(await open(agentId, epoch, 10, { period: monthly })).toMatchObject({ needsPeriodSeed: true });
    expect((await open(agentId, epoch, 10, { period: monthly, seed: 250 })).ok).toBe(true);
    expect((await snapshot(agentId))!.pk).toBe("m:2026-09");
  });
});

describe.skipIf(!live)("N1 — the limit is enforced in the eval that reserves", () => {
  it("admits up to the limit, lands exactly on it, and refuses past it", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    const a = await open(agentId, epoch, 600, { attemptId: "a" });
    expect(a.ok).toBe(true);
    await settleKnown({ agentId, attemptId: "a", tokens: 1, microcents: 600, nowMs: D });
    expect(await open(agentId, epoch, 500)).toMatchObject({ ok: false, reason: "period" });
    // A refusal reserves nothing.
    expect(await num(`reserved_cost:${agentId}`)).toBe(0);
    expect((await open(agentId, epoch, 400)).ok).toBe(true);
  });

  it("counts reservations still in flight", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    expect((await open(agentId, epoch, 700)).ok).toBe(true);
    expect(await open(agentId, epoch, 400)).toMatchObject({ reason: "period" });
  });

  it("a limit of zero refuses unconditionally, even a zero estimate", async () => {
    const agentId = agent();
    const first = await openHold({
      agentId,
      attemptId: "z0",
      estimate: 0,
      capTokens: null,
      capMicrocents: null,
      budgetState: { epoch: null, established: false },
      periodLimit: perDay(0),
      nowMs: D,
    });
    const epoch = first.epochToPersist!;
    expect(await open(agentId, epoch, 0, { period: perDay(0), seed: 0 })).toMatchObject({ reason: "period" });
  });

  it("admits exactly as many concurrent opens as fit", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    const results = await Promise.all(Array.from({ length: 10 }, () => open(agentId, epoch, 150)));
    expect(results.filter((r) => r.ok)).toHaveLength(6);
    expect(results.filter((r) => r.reason === "period")).toHaveLength(4);
    expect(await num(`reserved_cost:${agentId}`)).toBe(900);
  });

  it("tells a call both would refuse about the cumulative cap first", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 100);
    const r = await openHold({
      agentId,
      attemptId: "both",
      estimate: 1,
      estimateMicrocents: 500,
      capTokens: null,
      capMicrocents: 200,
      budgetState: { epoch, established: true },
      periodLimit: perDay(100),
      nowMs: D,
    });
    expect(r.reason).toBe("cost");
  });

  it("refuses rather than runs unfenced when no generation was supplied", async () => {
    const agentId = agent();
    const r = await openHold({
      agentId,
      attemptId: "unfenced",
      estimate: 1,
      estimateMicrocents: 1,
      capTokens: null,
      periodLimit: perDay(1000),
      nowMs: D,
    });
    expect(r).toMatchObject({ ok: false, reason: "state" });
  });
});

describe.skipIf(!live)("rollover", () => {
  it("a new period starts from zero on its first open", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    await open(agentId, epoch, 900, { attemptId: "d" });
    await settleKnown({ agentId, attemptId: "d", tokens: 1, microcents: 900, nowMs: D });
    expect(await open(agentId, epoch, 900)).toMatchObject({ reason: "period" });
    const next = await open(agentId, epoch, 900, { nowMs: D1, attemptId: "d1" });
    expect(next.ok).toBe(true);
    expect((await snapshot(agentId))!.pk).toBe("d:2026-10-01");
  });

  it("N3 — a settle after the boundary counts toward the NEW period, rolled before its delta", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    await open(agentId, epoch, 400, { attemptId: "earlier" });
    await settleKnown({ agentId, attemptId: "earlier", tokens: 1, microcents: 400, nowMs: D });
    // Opened before midnight, finished after it.
    expect((await open(agentId, epoch, 500, { attemptId: "straddle" })).ok).toBe(true);
    await settleKnown({ agentId, attemptId: "straddle", tokens: 1, microcents: 500, nowMs: D1 });
    const snap = await snapshot(agentId);
    expect(snap!.pk).toBe("d:2026-10-01");
    // The snapshot was taken BEFORE this settle's 500 landed: spent was 400.
    expect(Number(snap!.bc)).toBe(400);
    expect(await open(agentId, epoch, 600, { nowMs: D1 })).toMatchObject({ reason: "period" });
    expect((await open(agentId, epoch, 500, { nowMs: D1 })).ok).toBe(true);
  });

  it("a replayed settle does not roll or move anything a second time", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    await open(agentId, epoch, 300, { attemptId: "r" });
    await settleKnown({ agentId, attemptId: "r", tokens: 1, microcents: 300, nowMs: D });
    const before = await snapshot(agentId);
    const replay = await settleKnown({ agentId, attemptId: "r", tokens: 1, microcents: 300, nowMs: D1 });
    expect(replay.applied).toBe(false);
    expect(await snapshot(agentId)).toEqual(before);
    expect(await num(`spent_cost:${agentId}`)).toBe(300);
  });

  it("N2 — a caller whose clock is behind never moves the period back", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    await open(agentId, epoch, 800, { attemptId: "late", nowMs: D1 });
    await settleKnown({ agentId, attemptId: "late", tokens: 1, microcents: 800, nowMs: D1 });
    // Judged against the newer period's usage (800), not a reset "yesterday".
    const behind = await open(agentId, epoch, 300, { nowMs: D });
    expect(behind.reason).toBe("period");
    expect((await snapshot(agentId))!.pk).toBe("d:2026-10-01");
    await settleUnknown({ agentId, attemptId: "late", tokens: 0, microcents: 0, nowMs: D });
    expect((await snapshot(agentId))!.pk).toBe("d:2026-10-01");
  });

  it("an attempt nobody ever settled keeps counting against every later period", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    expect((await open(agentId, epoch, 700, { attemptId: "stranded" })).ok).toBe(true);
    expect(await open(agentId, epoch, 400, { nowMs: D1_LATER })).toMatchObject({ reason: "period" });
    const usage = (await readPeriodUsageMany([{ id: agentId, kind: "day" }], D1_LATER)).get(agentId);
    expect(usage).toMatchObject({ state: "tracked", usedMicrocents: 0, heldMicrocents: 700, openHolds: 1 });
  });

  it("the reconcile floor never rolls the period", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    await open(agentId, epoch, 100, { attemptId: "f" });
    await settleKnown({ agentId, attemptId: "f", tokens: 1, microcents: 100, nowMs: D });
    await raiseSpentFloor({ agentId, tokens: 0, microcents: 350 });
    expect((await snapshot(agentId))!.pk).toBe("d:2026-09-30");
    // The recovered spend lands in the period the snapshot holds.
    expect(await open(agentId, epoch, 700)).toMatchObject({ reason: "period" });
  });

  // The cron runs at 00:00 UTC and recovers rows written BEFORE its cutoff. If
  // the snapshot already rolled to the new day, that recovered spend belongs to
  // the old one and must not count against the new day.
  it("spend the reconcile recovers from before a rolled snapshot's period does not count in it", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    await open(agentId, epoch, 100, { attemptId: "new-day", nowMs: D1 });
    await settleKnown({ agentId, attemptId: "new-day", tokens: 1, microcents: 100, nowMs: D1 });
    expect((await snapshot(agentId))!.pk).toBe("d:2026-10-01");
    // Ledger says 900 more was spent before midnight that Redis never counted.
    await raiseSpentFloor({ agentId, tokens: 0, microcents: 1000, cutoffMs: D });
    expect(await num(`spent_cost:${agentId}`)).toBe(1000);
    const usage = (await readPeriodUsageMany([{ id: agentId, kind: "day" }], D1)).get(agentId);
    expect(usage?.usedMicrocents).toBe(100);
    expect((await open(agentId, epoch, 900, { nowMs: D1 })).ok).toBe(true);
  });

  it("recovered spend from the snapshot's own period still counts in it", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    await open(agentId, epoch, 100, { attemptId: "same", nowMs: D });
    await settleKnown({ agentId, attemptId: "same", tokens: 1, microcents: 100, nowMs: D });
    await raiseSpentFloor({ agentId, tokens: 0, microcents: 600, cutoffMs: D });
    const usage = (await readPeriodUsageMany([{ id: agentId, kind: "day" }], D)).get(agentId);
    expect(usage?.usedMicrocents).toBe(600);
  });

  it("a raise with no snapshot leaves the period state absent", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    await open(agentId, epoch, 0, { period: { mode: "none" } });
    await raiseSpentFloor({ agentId, tokens: 0, microcents: 500, cutoffMs: D });
    expect(await snapshot(agentId)).toBeNull();
    expect(await num(`spent_cost:${agentId}`)).toBe(500);
  });

  it("a degraded settle, which moves no counter, does not roll either", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    await open(agentId, epoch, 100, { attemptId: "dg" });
    await redis().del(`spent_cost:${agentId}`);
    const r = await settleKnown({ agentId, attemptId: "dg", tokens: 1, microcents: 100, nowMs: D1 });
    expect(r.degraded).toBe(true);
    expect((await snapshot(agentId))!.pk).toBe("d:2026-09-30");
  });
});

describe.skipIf(!live)("N5 — removed and unknown limits", () => {
  it("removing the limit deletes the snapshot", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    expect((await open(agentId, epoch, 5000, { period: { mode: "none" } })).ok).toBe(true);
    expect(await snapshot(agentId)).toBeNull();
  });

  it("an unknown limit enforces the last one this generation enforced", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    await open(agentId, epoch, 900, { attemptId: "u" });
    await settleKnown({ agentId, attemptId: "u", tokens: 1, microcents: 900, nowMs: D });
    expect(await open(agentId, epoch, 200, { period: { mode: "unknown" } })).toMatchObject({ reason: "period" });
    expect((await open(agentId, epoch, 50, { period: { mode: "unknown" } })).ok).toBe(true);
  });

  it("an unknown limit with no snapshot enforces nothing extra", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    await open(agentId, epoch, 0, { period: { mode: "none" } });
    expect((await open(agentId, epoch, 5000, { period: { mode: "unknown" } })).ok).toBe(true);
  });

  it("a caller that predates periods never reads or writes the snapshot", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    const before = await snapshot(agentId);
    const r = await openHold({
      agentId,
      attemptId: "legacy",
      estimate: 1,
      estimateMicrocents: 5000,
      capTokens: null,
      capMicrocents: null,
      budgetState: { epoch, established: true },
      nowMs: D1,
    });
    expect(r.ok).toBe(true);
    expect(await snapshot(agentId)).toEqual(before);
  });
});

describe.skipIf(!live)("N6 — a rebuild rewrites the snapshot from the ledger", () => {
  it("writes the new generation's snapshot so the period is not handed back", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    await open(agentId, epoch, 800, { attemptId: "b" });
    await settleKnown({ agentId, attemptId: "b", tokens: 1, microcents: 800, nowMs: D });

    const newEpoch = crypto.randomUUID();
    // The ledger says 5000 in total, 800 of it today.
    await rebuildBudgetState({
      agentId,
      epoch: newEpoch,
      spentTokens: 10,
      spentMicrocents: 5000,
      period: { kind: "day", capMicrocents: 1000, spentMicrocents: 800 },
      nowMs: D,
    });
    const snap = await snapshot(agentId);
    // The client hands numeric strings back as numbers; the values are what count.
    expect(snap).toMatchObject({ ep: newEpoch, pk: "d:2026-09-30" });
    expect(Number(snap!.bc)).toBe(4200);
    expect(Number(snap!.cap)).toBe(1000);
    expect(await open(agentId, newEpoch, 300)).toMatchObject({ reason: "period" });
    expect((await open(agentId, newEpoch, 200)).ok).toBe(true);
  });

  it("deletes the snapshot when the agent has no periodic limit", async () => {
    const agentId = agent();
    await establish(agentId, 1000);
    await rebuildBudgetState({ agentId, epoch: crypto.randomUUID(), spentTokens: 0, spentMicrocents: 0, nowMs: D });
    expect(await snapshot(agentId)).toBeNull();
  });

  it("a hold from the replaced generation cannot roll the new snapshot", async () => {
    const agentId = agent();
    const epoch = await establish(agentId, 1000);
    await open(agentId, epoch, 100, { attemptId: "old" });
    const newEpoch = crypto.randomUUID();
    await rebuildBudgetState({
      agentId,
      epoch: newEpoch,
      spentTokens: 0,
      spentMicrocents: 0,
      period: { kind: "day", capMicrocents: 1000, spentMicrocents: 0 },
      nowMs: D,
    });
    const r = await settleKnown({ agentId, attemptId: "old", tokens: 1, microcents: 100, nowMs: D1 });
    expect(r.conflict).toBe(true);
    expect((await snapshot(agentId))!.pk).toBe("d:2026-09-30");
  });
});

describe.skipIf(!live)("presentation read", () => {
  it("reports tracked usage, an earlier period as zero, and an absent snapshot as not started", async () => {
    const tracked = agent();
    const epoch = await establish(tracked, 1000);
    await open(tracked, epoch, 250, { attemptId: "p" });
    await settleKnown({ agentId: tracked, attemptId: "p", tokens: 1, microcents: 250, nowMs: D });
    const fresh = agent();

    const today = await readPeriodUsageMany(
      [
        { id: tracked, kind: "day" },
        { id: fresh, kind: "day" },
      ],
      D
    );
    expect(today.get(tracked)).toMatchObject({ state: "tracked", usedMicrocents: 250, heldMicrocents: 0 });
    expect(today.get(fresh)).toMatchObject({ state: "not_started", usedMicrocents: 0 });
    const tomorrow = await readPeriodUsageMany([{ id: tracked, kind: "day" }], D1);
    expect(tomorrow.get(tracked)).toMatchObject({ state: "tracked", usedMicrocents: 0 });
  });
});
