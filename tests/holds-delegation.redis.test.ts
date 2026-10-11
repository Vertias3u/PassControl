// Bet D slice 4 (plans/delegation-design.md §7, §13): a delegation's caps, as REAL Lua
// on a REAL Redis through SRH. One ledger per link jti, created ONLY by the first
// exchange of that link. OPEN_LUA checks every link of the chain with the agent's own
// limits in one eval, all-or-nothing, and stamps the ledgers on the hold; settle moves
// exactly those. Unlike C(b)'s declared sub-ledgers, a MISSING delegation ledger
// REFUSES: the jti is signed, so a lost ledger recreated at zero would hand the worker
// its whole cap again.
import { describe, it, expect, afterEach } from "vitest";
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
  console.warn(`[holds-delegation.redis.test] SKIPPED — no SRH at ${URL_}.`);
}

process.env.UPSTASH_REDIS_REST_URL = URL_;
process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
const { openHold, settleKnown, releaseUndispatched, delegationLedgerKey, createDelegationLedger } = await import("../lib/state/holds");
const { readDelegationRevocation, revokeDelegation, raiseDelegationWatermark } = await import("../lib/state/delegation");
const { redis } = await import("../lib/state/redis");

const NOW = Date.parse("2026-10-10T12:00:00.000Z");
const EXP = Math.floor(Date.now() / 1000) + 3600;
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
      ...(await r.keys(`dl:${agid}:*`)),
      ...(await r.keys(`dlrev:${agid}:*`)),
      ...(await r.keys(`sl:${agid}:*`)),
      ...(await r.keys(`slnew:${agid}:*`)),
    ];
    await r.del(`reserved:${agid}`, `spent:${agid}`, `reserved_cost:${agid}`, `spent_cost:${agid}`, `holds:${agid}`,
      `epoch:${agid}`, `acctfmt:${agid}`, `pbase:${agid}`, `dlwm:${agid}`, ...keys);
  }
});

async function establish(agentId: string): Promise<string> {
  const first = await openHold({
    agentId, attemptId: `init-${crypto.randomUUID()}`, estimate: 0, estimateMicrocents: 0,
    capTokens: null, capMicrocents: null, budgetState: { epoch: null, established: false }, nowMs: NOW,
  });
  expect(first.ok).toBe(true);
  return first.epochToPersist!;
}
const L1 = "jti-0000000000000001";
const A = "jti-000000000000000a";
const B = "jti-000000000000000b";
type Link = { jti: string; capMicrocents: number };
function open(agentId: string, epoch: string, cost: number, links: Link[], opts: { attemptId?: string; subLedger?: { session: string; agent: string; capMicrocents: number } } = {}) {
  return openHold({
    agentId,
    attemptId: opts.attemptId ?? crypto.randomUUID(),
    estimate: 1,
    estimateMicrocents: cost,
    capTokens: null,
    capMicrocents: null,
    budgetState: { epoch, established: true },
    delegation: { links },
    ...(opts.subLedger ? { subLedger: opts.subLedger } : {}),
    nowMs: NOW,
  });
}
const ledger = async (agentId: string, jti: string) => {
  const h = await redis().hgetall<Record<string, unknown>>(delegationLedgerKey(agentId, jti));
  return h ? Object.fromEntries(Object.entries(h).map(([k, v]) => [k, String(v)])) : null;
};
const num = async (key: string) => Number((await redis().get(key)) ?? 0);

describe.skipIf(!live)("delegation ledgers: open", () => {
  it("admits a call under the link's cap, reserves on its ledger and stamps it on the hold", async () => {
    const a = agent();
    const epoch = await establish(a);
    await createDelegationLedger(a, L1, EXP);
    expect(await ledger(a, L1)).toEqual({ r: "0", s: "0" });
    expect((await open(a, epoch, 400, [{ jti: L1, capMicrocents: 1000 }], { attemptId: "att-1" })).ok).toBe(true);
    expect(await ledger(a, L1)).toEqual({ r: "400", s: "0" });
    expect(await redis().hget(`hold:${a}:att-1`, "dl")).toBe(delegationLedgerKey(a, L1));
    expect(await redis().ttl(delegationLedgerKey(a, L1))).toBeGreaterThan(3600);
  });

  it("refuses when a ledger is missing (lost, or never exchanged), and moves NO counter", async () => {
    const a = agent();
    const epoch = await establish(a);
    const before = await num(`reserved_cost:${a}`);
    expect(await open(a, epoch, 1, [{ jti: L1, capMicrocents: 1000 }])).toMatchObject({ ok: false, reason: "delegation_state" });
    expect(await num(`reserved_cost:${a}`)).toBe(before);
    expect(await ledger(a, L1)).toBeNull();
  });

  it("refuses a call that would pass the cap, and moves no counter", async () => {
    const a = agent();
    const epoch = await establish(a);
    await createDelegationLedger(a, L1, EXP);
    expect((await open(a, epoch, 700, [{ jti: L1, capMicrocents: 1000 }])).ok).toBe(true);
    const before = await num(`reserved_cost:${a}`);
    expect(await open(a, epoch, 400, [{ jti: L1, capMicrocents: 1000 }])).toMatchObject({ ok: false, reason: "delegation" });
    expect(await num(`reserved_cost:${a}`)).toBe(before);
    expect(await ledger(a, L1)).toEqual({ r: "700", s: "0" });
  });

  it("two siblings each under their own cap cannot together pass the parent link's cap", async () => {
    const a = agent();
    const epoch = await establish(a);
    for (const j of [L1, A, B]) await createDelegationLedger(a, j, EXP);
    expect((await open(a, epoch, 600, [{ jti: L1, capMicrocents: 1000 }, { jti: A, capMicrocents: 800 }])).ok).toBe(true);
    expect(await open(a, epoch, 600, [{ jti: L1, capMicrocents: 1000 }, { jti: B, capMicrocents: 800 }])).toMatchObject({ ok: false, reason: "delegation" });
    // All-or-nothing: B's own ledger did not move although B's cap alone allowed it.
    expect(await ledger(a, B)).toEqual({ r: "0", s: "0" });
    expect(await ledger(a, L1)).toEqual({ r: "600", s: "0" });
  });

  it("admits exactly one of two parallel calls that would pass the cap together", async () => {
    const a = agent();
    const epoch = await establish(a);
    await createDelegationLedger(a, L1, EXP);
    const rs = await Promise.all([open(a, epoch, 600, [{ jti: L1, capMicrocents: 1000 }]), open(a, epoch, 600, [{ jti: L1, capMicrocents: 1000 }])]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(await ledger(a, L1)).toEqual({ r: "600", s: "0" });
  });

  it("refuses everything at a cap of zero", async () => {
    const a = agent();
    const epoch = await establish(a);
    await createDelegationLedger(a, L1, EXP);
    expect(await open(a, epoch, 0, [{ jti: L1, capMicrocents: 0 }])).toMatchObject({ ok: false, reason: "delegation" });
  });

  it("works beside a C(b) sub-ledger in the same call, each on its own key", async () => {
    const a = agent();
    const epoch = await establish(a);
    await createDelegationLedger(a, L1, EXP);
    const r = await open(a, epoch, 300, [{ jti: L1, capMicrocents: 1000 }], { attemptId: "att-2", subLedger: { session: "s1", agent: "sub", capMicrocents: 500 } });
    expect(r.ok).toBe(true);
    expect(await ledger(a, L1)).toEqual({ r: "300", s: "0" });
    expect(String(await redis().hget(`sl:${a}:s1:sub`, "r"))).toBe("300");
    expect(await open(a, epoch, 300, [{ jti: L1, capMicrocents: 1000 }], { subLedger: { session: "s1", agent: "sub", capMicrocents: 500 } })).toMatchObject({ ok: false, reason: "subagent" });
  });

  it("creating a ledger never resets one that exists", async () => {
    const a = agent();
    const epoch = await establish(a);
    await createDelegationLedger(a, L1, EXP);
    expect((await open(a, epoch, 400, [{ jti: L1, capMicrocents: 1000 }])).ok).toBe(true);
    await createDelegationLedger(a, L1, EXP);
    expect(await ledger(a, L1)).toEqual({ r: "400", s: "0" });
  });
});

describe.skipIf(!live)("delegation ledgers: settle", () => {
  it("moves exactly the stamped ledgers: reservation out, actual spend in", async () => {
    const a = agent();
    const epoch = await establish(a);
    await createDelegationLedger(a, L1, EXP);
    await createDelegationLedger(a, A, EXP);
    expect((await open(a, epoch, 500, [{ jti: L1, capMicrocents: 1000 }, { jti: A, capMicrocents: 800 }], { attemptId: "att-3" })).ok).toBe(true);
    await settleKnown({ agentId: a, attemptId: "att-3", tokens: 1, microcents: 320, nowMs: NOW });
    expect(await ledger(a, L1)).toEqual({ r: "0", s: "320" });
    expect(await ledger(a, A)).toEqual({ r: "0", s: "320" });
    // A replay moves nothing again.
    await settleKnown({ agentId: a, attemptId: "att-3", tokens: 1, microcents: 320, nowMs: NOW });
    expect(await ledger(a, L1)).toEqual({ r: "0", s: "320" });
  });

  it("a release returns the reservation", async () => {
    const a = agent();
    const epoch = await establish(a);
    await createDelegationLedger(a, L1, EXP);
    expect((await open(a, epoch, 500, [{ jti: L1, capMicrocents: 1000 }], { attemptId: "att-4" })).ok).toBe(true);
    await releaseUndispatched({ agentId: a, attemptId: "att-4" });
    expect(await ledger(a, L1)).toEqual({ r: "0", s: "0" });
  });

  it("never recreates a ledger that expired while the call ran", async () => {
    const a = agent();
    const epoch = await establish(a);
    await createDelegationLedger(a, L1, EXP);
    expect((await open(a, epoch, 500, [{ jti: L1, capMicrocents: 1000 }], { attemptId: "att-5" })).ok).toBe(true);
    await redis().del(delegationLedgerKey(a, L1));
    await settleKnown({ agentId: a, attemptId: "att-5", tokens: 1, microcents: 320, nowMs: NOW });
    expect(await ledger(a, L1)).toBeNull();
  });
});

describe.skipIf(!live)("delegation revocation", () => {
  const links = (iat: number) => [{ dlg: L1, iat }, { dlg: A, iat }];
  it("is clear until a link is revoked", async () => {
    const a = agent();
    expect(await readDelegationRevocation(a, links(100))).toBe(false);
    await revokeDelegation(a, A);
    expect(await readDelegationRevocation(a, links(100))).toBe(true);
    expect(await readDelegationRevocation(a, [{ dlg: L1, iat: 100 }])).toBe(false);
  });
  it("the watermark kills every link issued at or before it, and only moves forward", async () => {
    const a = agent();
    await raiseDelegationWatermark(a, 200);
    expect(await readDelegationRevocation(a, links(200))).toBe(true);
    expect(await readDelegationRevocation(a, links(201))).toBe(false);
    await raiseDelegationWatermark(a, 150);
    expect(Number(await redis().get(`dlwm:${a}`))).toBe(200);
  });
  it("never builds a key from a jti the chain rules would refuse", async () => {
    const a = agent();
    await expect(revokeDelegation(a, "bad jti")).rejects.toThrow();
    expect(() => delegationLedgerKey(a, "x")).toThrow();
  });
});
