import { describe, it, expect, afterEach } from "vitest";
import { redisGate } from "./support/redis-gate";

// C(b) — a dollar cap per sub-agent per session, as REAL Lua on a REAL Redis through
// SRH (owner, 2026-10-10: "Build them now"; design in plans/delegation-design.md §7).
//
// One sub-ledger per (agent, declared session, declared sub-agent): a hash holding
// `r` (reserved µ¢) and `s` (spent µ¢). It is checked and moved in the SAME eval as
// the agent's own hold, all-or-nothing, so parallel calls from one sub-agent cannot
// together pass its cap. The hold stamps the ledger key, and settle moves exactly
// that key, whatever the caller says later.
//
// A missing ledger reads as zero, ON PURPOSE and unlike the agent's own counters:
// the ids are declared by the client, so a fresh ledger is always one new id away.
// This is a guard rail against a misbehaving model, not a security boundary; the
// agent's own limits stay the hard ones. Settle never recreates a missing ledger.
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
  console.warn(`[holds-subagent.redis.test] SKIPPED — no SRH at ${URL_}.`);
}

process.env.UPSTASH_REDIS_REST_URL = URL_;
process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
const { openHold, settleKnown, settleUnknown, releaseUndispatched, subLedgerKey, SUBAGENT_LEDGER_TTL_S } = await import(
  "../lib/state/holds"
);
const { redis } = await import("../lib/state/redis");

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const used: string[] = [];
function agent(): string {
  const id = `test-${crypto.randomUUID()}`;
  used.push(id);
  return id;
}
afterEach(async () => {
  const r = redis();
  for (const agid of used.splice(0)) {
    const keys = [
      ...(await r.keys(`hold:${agid}:*`)),
      ...(await r.keys(`sl:${agid}:*`)),
      ...(await r.keys(`slnew:${agid}:*`)),
    ];
    await r.del(`reserved:${agid}`, `spent:${agid}`, `reserved_cost:${agid}`, `spent_cost:${agid}`, `holds:${agid}`,
      `epoch:${agid}`, `acctfmt:${agid}`, `pbase:${agid}`, ...keys);
  }
});

/** A budgeted agent with no cap of its own, established the way the proxy does it. */
async function establish(agentId: string): Promise<string> {
  const first = await openHold({
    agentId, attemptId: `init-${crypto.randomUUID()}`, estimate: 0, estimateMicrocents: 0,
    capTokens: null, capMicrocents: null, budgetState: { epoch: null, established: false }, nowMs: NOW,
  });
  expect(first.ok).toBe(true);
  return first.epochToPersist!;
}

const SES = "sess-1";
const SUB = "sub-a";
function open(agentId: string, epoch: string, cost: number, cap: number, opts: { agent?: string; session?: string; attemptId?: string; ledgersPerHour?: number } = {}) {
  return openHold({
    agentId,
    attemptId: opts.attemptId ?? crypto.randomUUID(),
    estimate: 1,
    estimateMicrocents: cost,
    capTokens: null,
    capMicrocents: null,
    budgetState: { epoch, established: true },
    subLedger: { session: opts.session ?? SES, agent: opts.agent ?? SUB, capMicrocents: cap, ...(opts.ledgersPerHour ? { newPerHour: opts.ledgersPerHour } : {}) },
    nowMs: NOW,
  });
}
// The Upstash client turns numeric fields into numbers; compare as the strings Redis holds.
const ledger = async (agentId: string, session = SES, sub = SUB) => {
  const h = await redis().hgetall<Record<string, unknown>>(subLedgerKey(agentId, session, sub));
  return h ? Object.fromEntries(Object.entries(h).map(([k, v]) => [k, String(v)])) : null;
};
const num = async (key: string) => Number((await redis().get(key)) ?? 0);

describe.skipIf(!live)("C(b) sub-ledger: open", () => {
  it("admits a call under the cap, reserves it on the ledger and stamps the ledger on the hold", async () => {
    const a = agent();
    const epoch = await establish(a);
    const r = await open(a, epoch, 400, 1000, { attemptId: "att-1" });
    expect(r.ok).toBe(true);
    expect(await ledger(a)).toMatchObject({ r: "400" });
    expect(await redis().hget(`hold:${a}:att-1`, "sl")).toBe(subLedgerKey(a, SES, SUB));
    const ttl = await redis().ttl(subLedgerKey(a, SES, SUB));
    expect(ttl).toBeGreaterThan(SUBAGENT_LEDGER_TTL_S - 10);
  });

  it("refuses a call that would pass the cap, and moves NO counter", async () => {
    const a = agent();
    const epoch = await establish(a);
    expect((await open(a, epoch, 700, 1000)).ok).toBe(true);
    const before = await num(`reserved_cost:${a}`);
    const r = await open(a, epoch, 400, 1000);
    expect(r).toMatchObject({ ok: false, reason: "subagent" });
    expect(await num(`reserved_cost:${a}`)).toBe(before);
    expect(await ledger(a)).toMatchObject({ r: "700" });
  });

  it("refuses everything at a cap of zero, even a free call", async () => {
    const a = agent();
    const epoch = await establish(a);
    expect(await open(a, epoch, 0, 0)).toMatchObject({ ok: false, reason: "subagent" });
  });

  it("admits exactly one of two parallel calls that would pass the cap together", async () => {
    const a = agent();
    const epoch = await establish(a);
    const results = await Promise.all([open(a, epoch, 600, 1000), open(a, epoch, 600, 1000)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => r.reason === "subagent")).toHaveLength(1);
    expect(await ledger(a)).toMatchObject({ r: "600" });
  });

  it("keeps each sub-agent, and each session, on its own ledger", async () => {
    const a = agent();
    const epoch = await establish(a);
    expect((await open(a, epoch, 900, 1000)).ok).toBe(true);
    expect((await open(a, epoch, 900, 1000, { agent: "sub-b" })).ok).toBe(true);
    expect((await open(a, epoch, 900, 1000, { session: "sess-2" })).ok).toBe(true);
  });

  it("still applies the agent's own cap: the sub-ledger is an extra limit, not a replacement", async () => {
    const a = agent();
    const first = await openHold({
      agentId: a, attemptId: `init-${crypto.randomUUID()}`, estimate: 0, estimateMicrocents: 0,
      capTokens: null, capMicrocents: 500, budgetState: { epoch: null, established: false }, nowMs: NOW,
    });
    const epoch = first.epochToPersist!;
    const r = await openHold({
      agentId: a, attemptId: crypto.randomUUID(), estimate: 1, estimateMicrocents: 600, capTokens: null,
      capMicrocents: 500, budgetState: { epoch, established: true }, subLedger: { session: SES, agent: SUB, capMicrocents: 10_000 }, nowMs: NOW,
    });
    expect(r).toMatchObject({ ok: false, reason: "cost" });
    expect(await redis().exists(subLedgerKey(a, SES, SUB))).toBe(0);
  });

  it("is a transport replay, not a second reservation, when the same attempt opens twice", async () => {
    const a = agent();
    const epoch = await establish(a);
    expect((await open(a, epoch, 400, 1000, { attemptId: "same" })).ok).toBe(true);
    const again = await open(a, epoch, 400, 1000, { attemptId: "same" });
    expect(again).toMatchObject({ ok: true, replay: true });
    expect(await ledger(a)).toMatchObject({ r: "400" });
  });
});

describe.skipIf(!live)("C(b) sub-ledger: settle and release", () => {
  it("moves the estimate out of reserved and the charge into spent, then counts spent on the next open", async () => {
    const a = agent();
    const epoch = await establish(a);
    expect((await open(a, epoch, 600, 1000, { attemptId: "s1" })).ok).toBe(true);
    await settleKnown({ agentId: a, attemptId: "s1", tokens: 1, microcents: 450, nowMs: NOW });
    expect(await ledger(a)).toMatchObject({ r: "0", s: "450" });
    expect(await open(a, epoch, 600, 1000)).toMatchObject({ ok: false, reason: "subagent" });
    expect((await open(a, epoch, 500, 1000)).ok).toBe(true);
  });

  it("charges the greater of known and reserved when usage is unknown, as the agent's counters do", async () => {
    const a = agent();
    const epoch = await establish(a);
    expect((await open(a, epoch, 600, 1000, { attemptId: "u1" })).ok).toBe(true);
    await settleUnknown({ agentId: a, attemptId: "u1", tokens: 0, microcents: 100, nowMs: NOW });
    expect(await ledger(a)).toMatchObject({ r: "0", s: "600" });
  });

  it("releases a call that was never sent: reserved back, nothing spent", async () => {
    const a = agent();
    const epoch = await establish(a);
    expect((await open(a, epoch, 600, 1000, { attemptId: "n1" })).ok).toBe(true);
    await releaseUndispatched({ agentId: a, attemptId: "n1" });
    expect(await ledger(a)).toMatchObject({ r: "0" });
    expect((await ledger(a))!.s ?? "0").toBe("0");
  });

  it("never recreates a ledger that expired before the settle, and still moves the agent's counters", async () => {
    const a = agent();
    const epoch = await establish(a);
    expect((await open(a, epoch, 600, 1000, { attemptId: "x1" })).ok).toBe(true);
    await redis().del(subLedgerKey(a, SES, SUB));
    const s = await settleKnown({ agentId: a, attemptId: "x1", tokens: 1, microcents: 450, nowMs: NOW });
    expect(s.applied).toBe(true);
    expect(await redis().exists(subLedgerKey(a, SES, SUB))).toBe(0);
    expect(await num(`spent_cost:${a}`)).toBe(450);
    expect(await num(`reserved_cost:${a}`)).toBe(0);
  });

  it("a settle replay moves the ledger once", async () => {
    const a = agent();
    const epoch = await establish(a);
    expect((await open(a, epoch, 600, 1000, { attemptId: "r1" })).ok).toBe(true);
    await settleKnown({ agentId: a, attemptId: "r1", tokens: 1, microcents: 450, nowMs: NOW });
    await settleKnown({ agentId: a, attemptId: "r1", tokens: 1, microcents: 450, nowMs: NOW });
    expect(await ledger(a)).toMatchObject({ r: "0", s: "450" });
  });
});

describe.skipIf(!live)("C(b) bound on new ledgers per hour", () => {
  it("refuses a call that would open a ledger past the hourly bound, and keeps existing ones working", async () => {
    const a = agent();
    const epoch = await establish(a);
    expect((await open(a, epoch, 10, 1000, { agent: "s1", ledgersPerHour: 2 })).ok).toBe(true);
    expect((await open(a, epoch, 10, 1000, { agent: "s2", ledgersPerHour: 2 })).ok).toBe(true);
    expect(await open(a, epoch, 10, 1000, { agent: "s3", ledgersPerHour: 2 })).toMatchObject({ ok: false, reason: "subagent_ledgers" });
    // An existing ledger is not a new one.
    expect((await open(a, epoch, 10, 1000, { agent: "s1", ledgersPerHour: 2 })).ok).toBe(true);
    expect(await redis().exists(subLedgerKey(a, SES, "s3"))).toBe(0);
  });
});

describe("subLedgerKey", () => {
  it("is one key per agent, session and sub-agent", () => {
    expect(subLedgerKey("ag", "s", "x")).toBe("sl:ag:s:x");
  });
  it.each([["s b", "x"], ["s", "x\ny"], ["", "x"], ["s", ""], ["s".repeat(129), "x"]])("refuses ids the gateway would never accept (%j, %j)", (s, x) => {
    expect(() => subLedgerKey("ag", s, x)).toThrow();
  });
});
