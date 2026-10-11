// Bet D slice 8: the owner's side. List an agent's delegations (the links the gateway
// has seen), revoke one, or revoke every delegation issued before now (the watermark).
// The database is the record and is written first; the Redis copy makes the proxy see it
// within a visa's lifetime. Every read and write is scoped to the owner by hand: the
// service-role client bypasses RLS.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ revokeRedis: vi.fn(), raiseRedis: vi.fn() }));
vi.mock("@/lib/state/delegation", () => ({
  revokeDelegation: (...a: unknown[]) => m.revokeRedis(...a),
  raiseDelegationWatermark: (...a: unknown[]) => m.raiseRedis(...a),
}));

import { delegationRevokeMetadata, listDelegations, revokeAgentDelegation, revokeAllAgentDelegations } from "@/lib/delegation/manage";

type Result = { data: unknown; error: unknown };
function fakeDb(results: Record<string, Result | Result[]>) {
  const calls: { table: string; op: string; args: unknown[] }[] = [];
  const queues: Record<string, Result[]> = {};
  for (const [t, r] of Object.entries(results)) queues[t] = Array.isArray(r) ? [...r] : [r];
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    const record = (op: string) => (...args: unknown[]) => {
      calls.push({ table, op, args });
      return chain;
    };
    for (const op of ["select", "eq", "in", "order", "limit", "upsert", "update", "insert"]) chain[op] = record(op);
    const next = () => (queues[table]!.length > 1 ? queues[table]!.shift()! : queues[table]![0]!);
    chain.maybeSingle = async () => next();
    chain.then = (resolve: (v: unknown) => unknown) => resolve(next());
    return chain;
  };
  return { db: { from } as never, calls };
}
const AGENT = "11111111-1111-4111-8111-111111111111";
const JTI = "jti-0000000000000001";

beforeEach(() => {
  m.revokeRedis.mockReset().mockResolvedValue(undefined);
  m.raiseRedis.mockReset().mockResolvedValue(undefined);
});

describe("listDelegations", () => {
  it("lists the owner's agent's links, marking the revoked ones", async () => {
    const { db, calls } = fakeDb({
      agents: { data: { id: AGENT, delegations_valid_after: null }, error: null },
      delegation_exchanges: { data: [{ jti: JTI, depth: 1, issued_at: "2026-10-10T00:00:00Z" }, { jti: "jti-0000000000000002", depth: 2, issued_at: "2026-10-10T00:00:00Z" }], error: null },
      delegation_revocations: { data: [{ jti: JTI }], error: null },
    });
    const r = await listDelegations(db, "user-1", AGENT);
    expect(r).toMatchObject({ ok: true, delegations: [{ jti: JTI, revoked: true }, { jti: "jti-0000000000000002", revoked: false }] });
    expect(calls).toContainEqual({ table: "agents", op: "eq", args: ["user_id", "user-1"] });
    expect(calls).toContainEqual({ table: "delegation_exchanges", op: "eq", args: ["user_id", "user-1"] });
  });
  it("counts every link issued at or before the watermark as revoked", async () => {
    const { db } = fakeDb({
      agents: { data: { id: AGENT, delegations_valid_after: "2026-10-10T00:00:00Z" }, error: null },
      delegation_exchanges: { data: [{ jti: JTI, issued_at: "2026-10-10T00:00:00Z" }, { jti: "jti-0000000000000002", issued_at: "2026-10-11T00:00:00Z" }], error: null },
      delegation_revocations: { data: [], error: null },
    });
    const r = await listDelegations(db, "user-1", AGENT);
    expect(r.ok && r.delegations.map((d) => d.revoked)).toEqual([true, false]);
  });
  it("is not found for an agent the user does not own", async () => {
    const { db } = fakeDb({ agents: { data: null, error: null } });
    expect(await listDelegations(db, "user-2", AGENT)).toEqual({ ok: false, status: 404, code: "agent_not_found" });
  });
});

describe("revokeAgentDelegation", () => {
  it("records the revocation, then mirrors it to Redis", async () => {
    const { db, calls } = fakeDb({
      agents: { data: { id: AGENT }, error: null },
      delegation_revocations: { data: [{ jti: JTI }], error: null },
    });
    expect(await revokeAgentDelegation(db, "user-1", AGENT, JTI)).toEqual({ ok: true, immediate: true, passports: [] });
    const upsert = calls.find((c) => c.table === "delegation_revocations" && c.op === "upsert")!;
    expect(upsert.args[0]).toEqual({ user_id: "user-1", agent_id: AGENT, jti: JTI });
    expect(m.revokeRedis).toHaveBeenCalledWith(AGENT, JTI);
  });
  it("is recorded even when Redis is down, and says the proxy may see it only at the next visa", async () => {
    m.revokeRedis.mockRejectedValue(new Error("down"));
    const { db } = fakeDb({ agents: { data: { id: AGENT }, error: null }, delegation_revocations: { data: [], error: null } });
    expect(await revokeAgentDelegation(db, "user-1", AGENT, JTI)).toEqual({ ok: true, immediate: false, passports: [] });
  });
  it("refuses a malformed jti, a foreign agent, and a failed write", async () => {
    expect(await revokeAgentDelegation(fakeDb({}).db, "user-1", AGENT, "bad jti")).toMatchObject({ ok: false, status: 400 });
    expect(await revokeAgentDelegation(fakeDb({ agents: { data: null, error: null } }).db, "user-2", AGENT, JTI)).toMatchObject({ ok: false, status: 404 });
    const failed = fakeDb({ agents: { data: { id: AGENT }, error: null }, delegation_revocations: { data: null, error: { message: "x" } } });
    expect(await revokeAgentDelegation(failed.db, "user-1", AGENT, JTI)).toMatchObject({ ok: false, status: 500 });
    expect(m.revokeRedis).not.toHaveBeenCalled();
  });
});

describe("revokeAllAgentDelegations", () => {
  it("moves the watermark to now in the record, then in Redis", async () => {
    const { db, calls } = fakeDb({ agents: [{ data: { id: AGENT }, error: null }, { data: [{ id: AGENT }], error: null }] });
    const before = Math.floor(Date.now() / 1000);
    const r = await revokeAllAgentDelegations(db, "user-1", AGENT);
    expect(r).toMatchObject({ ok: true, immediate: true });
    const update = calls.find((c) => c.table === "agents" && c.op === "update")!;
    expect(Date.parse((update.args[0] as { delegations_valid_after: string }).delegations_valid_after) / 1000).toBeGreaterThanOrEqual(before);
    expect(m.raiseRedis).toHaveBeenCalledWith(AGENT, expect.any(Number));
  });

  // P2.4: the public revocation list publishes each watermark raise under the passport
  // ids it covered, read from the audit row. They are fixed at the moment of the raise:
  // reading the agent's keys later would let a rotation rewrite a published entry.
  it("returns the passports the watermark covers: the current key and one still in its grace window", async () => {
    const { db, calls } = fakeDb({
      agents: [
        { data: { id: AGENT, passport_pubkey: "key-now", previous_passport_pubkey: "key-old" }, error: null },
        { data: [{ id: AGENT }], error: null },
      ],
    });
    const r = await revokeAllAgentDelegations(db, "user-1", AGENT);
    expect(r).toMatchObject({ ok: true, passports: ["key-now", "key-old"] });
    expect(calls).toContainEqual({ table: "agents", op: "select", args: [expect.stringContaining("previous_passport_pubkey")] });
  });

  it("returns only the passports the agent has", async () => {
    const { db } = fakeDb({
      agents: [
        { data: { id: AGENT, passport_pubkey: "key-now", previous_passport_pubkey: null }, error: null },
        { data: [{ id: AGENT }], error: null },
      ],
    });
    expect(await revokeAllAgentDelegations(db, "user-1", AGENT)).toMatchObject({ ok: true, passports: ["key-now"] });
  });
});

describe("revokeAgentDelegation and the public list", () => {
  // A jti alone names nobody (a delegator picks its own), so a single revoke records
  // the root passport(s) it covers too, fixed at that moment.
  it("returns the passports a single revocation covers", async () => {
    const { db } = fakeDb({
      agents: { data: { id: AGENT, passport_pubkey: "key-now", previous_passport_pubkey: "key-old" }, error: null },
      delegation_revocations: { data: null, error: null },
    });
    expect(await revokeAgentDelegation(db, "user-1", AGENT, JTI)).toMatchObject({ ok: true, passports: ["key-now", "key-old"] });
  });
});

describe("delegationRevokeMetadata", () => {
  it("records the watermark and its passports for an all-revoke, so the public list can publish it", () => {
    expect(
      delegationRevokeMetadata({ all: true, validAfter: "2026-10-10T00:00:00.000Z", passports: ["key-now"], immediate: true, via: "api" })
    ).toEqual({ all: true, valid_after: "2026-10-10T00:00:00.000Z", passports: ["key-now"], immediate: true, via: "api" });
  });
  it("records the jti for a single revoke", () => {
    expect(delegationRevokeMetadata({ all: false, jti: JTI, passports: ["key-now"], immediate: false, via: "dashboard" })).toEqual({
      all: false,
      jti: JTI,
      passports: ["key-now"],
      immediate: false,
      via: "dashboard",
    });
  });
});
