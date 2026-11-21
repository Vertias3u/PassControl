// 1.9.0 session caps: the session script, as REAL Lua on a REAL Redis through SRH, and the
// money cap end to end through the REAL hold script. One eval per call starts or reads the
// session's clock, counts its calls, bounds how many new sessions an agent may open per hour
// (the ids are declared, so a fresh one is always one header away), and makes sure the
// session's money ledger exists. The money itself is then checked and moved by OPEN_LUA and
// settle as one more ledger link, all-or-nothing with the agent's own hold.
import { afterEach, describe, expect, it } from "vitest";
import { redisGate } from "./support/redis-gate";

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
  console.warn(`[session-caps.redis.test] SKIPPED — no SRH at ${URL_}.`);
}

process.env.UPSTASH_REDIS_REST_URL = URL_;
process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;

const { checkSessionCaps } = await import("@/lib/state/runaway");
const { sessionLedgerJti } = await import("@/lib/runaway");
const { openHold, settleKnown, delegationLedgerKey } = await import("@/lib/state/holds");
const { redis } = await import("@/lib/state/redis");

const used: string[] = [];
function agent(): string {
  const id = `ses-test-${crypto.randomUUID()}`;
  used.push(id);
  return id;
}
afterEach(async () => {
  if (!live) return;
  const r = redis();
  for (const agid of used.splice(0)) {
    const keys = [
      ...(await r.keys(`sst:${agid}:*`)),
      ...(await r.keys(`scl:${agid}:*`)),
      ...(await r.keys(`ssnew:${agid}:*`)),
      ...(await r.keys(`dl:${agid}:*`)),
      ...(await r.keys(`hold:${agid}:*`)),
    ];
    await r.del(`reserved:${agid}`, `spent:${agid}`, `reserved_cost:${agid}`, `spent_cost:${agid}`, `holds:${agid}`,
      `epoch:${agid}`, `acctfmt:${agid}`, `pbase:${agid}`, ...keys);
  }
});

const NOW = Date.parse("2026-11-21T12:00:00.000Z");

describe.runIf(live)("checkSessionCaps on real Redis", () => {
  it("counts calls and refuses the one past the cap, without counting the refused one", async () => {
    const a = agent();
    for (let i = 1; i <= 3; i++) expect(await checkSessionCaps(a, "s1", { calls: 3, nowMs: NOW })).toEqual({ ok: true, calls: i });
    expect(await checkSessionCaps(a, "s1", { calls: 3, nowMs: NOW })).toEqual({ ok: false, reason: "calls" });
    expect(await checkSessionCaps(a, "s1", { calls: 3, nowMs: NOW })).toEqual({ ok: false, reason: "calls" });
    expect(Number(await redis().get(`scl:${a}:s1`))).toBe(3);
  });

  it("keeps each session's count apart", async () => {
    const a = agent();
    expect(await checkSessionCaps(a, "s1", { calls: 1, nowMs: NOW })).toMatchObject({ ok: true });
    expect(await checkSessionCaps(a, "s2", { calls: 1, nowMs: NOW })).toMatchObject({ ok: true });
    expect(await checkSessionCaps(a, "s1", { calls: 1, nowMs: NOW })).toEqual({ ok: false, reason: "calls" });
  });

  it("times a session from its first call and refuses once the minutes have run out", async () => {
    const a = agent();
    expect(await checkSessionCaps(a, "s1", { minutes: 30, nowMs: NOW })).toMatchObject({ ok: true });
    expect(await checkSessionCaps(a, "s1", { minutes: 30, nowMs: NOW + 29 * 60_000 })).toMatchObject({ ok: true });
    expect(await checkSessionCaps(a, "s1", { minutes: 30, nowMs: NOW + 30 * 60_000 })).toEqual({ ok: false, reason: "minutes" });
    // A later call does not move the start: the clock is the session's, not the last call's.
    expect(Number(await redis().get(`sst:${a}:s1`))).toBe(NOW);
  });

  it("bounds the new sessions one agent may open per hour, and a known session is not new", async () => {
    const a = agent();
    for (let i = 0; i < 3; i++) expect(await checkSessionCaps(a, `s${i}`, { calls: 10, nowMs: NOW, newPerHour: 3 })).toMatchObject({ ok: true });
    expect(await checkSessionCaps(a, "s9", { calls: 10, nowMs: NOW, newPerHour: 3 })).toEqual({ ok: false, reason: "sessions" });
    expect(await checkSessionCaps(a, "s0", { calls: 10, nowMs: NOW, newPerHour: 3 })).toMatchObject({ ok: true });
    // The refused session left no clock behind.
    expect(await redis().get(`sst:${a}:s9`)).toBeNull();
  });

  it("idles out: every key it writes carries a TTL", async () => {
    const a = agent();
    const jti = await sessionLedgerJti("s1");
    await checkSessionCaps(a, "s1", { calls: 5, minutes: 5, ledgerJti: jti, nowMs: NOW });
    for (const key of [`sst:${a}:s1`, `scl:${a}:s1`, delegationLedgerKey(a, jti)]) {
      expect(await redis().ttl(key)).toBeGreaterThan(23 * 3600);
    }
  });

  it("creates the money ledger at zero once and never resets it", async () => {
    const a = agent();
    const jti = await sessionLedgerJti("s1");
    await checkSessionCaps(a, "s1", { ledgerJti: jti, nowMs: NOW });
    expect(await redis().hgetall(delegationLedgerKey(a, jti))).toMatchObject({ r: 0, s: 0 });
    await redis().hset(delegationLedgerKey(a, jti), { s: "500" });
    await checkSessionCaps(a, "s1", { ledgerJti: jti, nowMs: NOW });
    expect(Number(await redis().hget(delegationLedgerKey(a, jti), "s"))).toBe(500);
  });
});

// Review 2026-11-21 (Codex, runaway package): a session's money ledger must never come back
// at zero while the session lives, and a session that idled out must start fresh.
describe.runIf(live)("the session's money ledger across lost state and restarts", () => {
  it("refuses a live session whose money ledger was lost, rather than granting it a fresh cap", async () => {
    const a = agent();
    const jti = await sessionLedgerJti("s1");
    expect(await checkSessionCaps(a, "s1", { calls: 10, ledgerJti: jti, nowMs: NOW })).toEqual({ ok: true, calls: 1 });
    await redis().hset(delegationLedgerKey(a, jti), { s: "900" });
    await redis().del(delegationLedgerKey(a, jti));
    expect(await checkSessionCaps(a, "s1", { calls: 10, ledgerJti: jti, nowMs: NOW })).toEqual({ ok: false, reason: "state" });
    expect(await redis().exists(delegationLedgerKey(a, jti))).toBe(0);
    // The refused call was not counted, and the session's clock was not kept alive by it.
    expect(Number(await redis().get(`scl:${a}:s1`))).toBe(1);
  });

  it("starts a session that idled out afresh, its money included", async () => {
    const a = agent();
    const jti = await sessionLedgerJti("s1");
    await checkSessionCaps(a, "s1", { calls: 10, ledgerJti: jti, nowMs: NOW });
    await redis().hset(delegationLedgerKey(a, jti), { s: "900" });
    // The clock and the count idle out a day after the last call; the ledger an hour later.
    await redis().del(`sst:${a}:s1`, `scl:${a}:s1`);
    expect(await checkSessionCaps(a, "s1", { calls: 10, ledgerJti: jti, nowMs: NOW + 86_400_000 })).toEqual({ ok: true, calls: 1 });
    expect(await redis().hgetall(delegationLedgerKey(a, jti))).toMatchObject({ r: 0, s: 0 });
  });

  it("never resets a ledger a hold still reserves against: that restart is refused, retryably", async () => {
    const a = agent();
    const jti = await sessionLedgerJti("s1");
    await checkSessionCaps(a, "s1", { calls: 10, ledgerJti: jti, nowMs: NOW, newPerHour: 5 });
    await redis().hset(delegationLedgerKey(a, jti), { r: "600", s: "100" });
    await redis().del(`sst:${a}:s1`, `scl:${a}:s1`);
    expect(await checkSessionCaps(a, "s1", { calls: 10, ledgerJti: jti, nowMs: NOW, newPerHour: 5 })).toEqual({ ok: false, reason: "state" });
    expect(await redis().hgetall(delegationLedgerKey(a, jti))).toMatchObject({ r: 600, s: 100 });
    expect(await redis().get(`sst:${a}:s1`)).toBeNull();
    expect(Number(await redis().get(`ssnew:${a}:${Math.floor(NOW / 3_600_000)}`))).toBe(1);
  });
});

describe.runIf(live)("the session's money cap through the real hold script", () => {
  async function establish(agentId: string): Promise<string> {
    const first = await openHold({
      agentId, attemptId: `init-${crypto.randomUUID()}`, estimate: 0, estimateMicrocents: 0,
      capTokens: null, capMicrocents: null, budgetState: { epoch: null, established: false }, nowMs: NOW,
    });
    return first.epochToPersist!;
  }

  it("admits calls under the cap, refuses the one that would pass it, and settle moves the spend", async () => {
    const a = agent();
    const epoch = await establish(a);
    const jti = await sessionLedgerJti("s1");
    await checkSessionCaps(a, "s1", { ledgerJti: jti, nowMs: NOW });
    const open = (attemptId: string, cost: number) =>
      openHold({
        agentId: a, attemptId, estimate: 1, estimateMicrocents: cost, capTokens: null, capMicrocents: null,
        budgetState: { epoch, established: true }, delegation: { links: [{ jti, capMicrocents: 1000 }] }, nowMs: NOW,
      });
    expect((await open("att-1", 600)).ok).toBe(true);
    expect(await open("att-2", 600)).toMatchObject({ ok: false, reason: "delegation", link: 1 });
    await settleKnown({ agentId: a, attemptId: "att-1", tokens: 1, microcents: 300 });
    expect(await redis().hgetall(delegationLedgerKey(a, jti))).toMatchObject({ r: 0, s: 300 });
    expect((await open("att-3", 600)).ok).toBe(true);
  });
});

describe("checkSessionCaps when Redis cannot answer", () => {
  it("returns null, which the proxy reads as fail open", async () => {
    const down = () => ({ eval: async () => { throw new Error("down"); } });
    expect(await checkSessionCaps("agent-x", "s1", { calls: 3, redisClient: down as never })).toBeNull();
  });
  it("returns null for a session id the gateway would never accept, without a call", async () => {
    let called = false;
    const spy = () => ({ eval: async () => { called = true; return [0, 1]; } });
    expect(await checkSessionCaps("agent-x", "bad id with spaces", { calls: 3, redisClient: spy as never })).toBeNull();
    expect(called).toBe(false);
  });
});
