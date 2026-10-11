// Bet D slice 6: the exchange route's durable reads and writes, against a minimal fake
// of the Supabase query builder. Both throw on any failure (the route fails closed).
import { describe, expect, it, vi } from "vitest";
import { delegationRecordRevokes, readDelegationRecord, recordFirstExchanges } from "@/lib/delegation/store";

function fakeDb(results: Record<string, { data: unknown; error: unknown }>) {
  const calls: Record<string, unknown[]> = {};
  const from = vi.fn((table: string) => {
    const result = results[table]!;
    const chain: Record<string, unknown> = {};
    const record = (name: string) => (...args: unknown[]) => {
      (calls[`${table}.${name}`] ??= []).push(args);
      return chain;
    };
    for (const m of ["select", "eq", "in", "upsert"]) chain[m] = record(m);
    chain.maybeSingle = async () => result;
    chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
    return chain;
  });
  return { db: { from } as never, calls };
}

describe("readDelegationRecord", () => {
  it("reads the watermark in seconds and the revoked jtis", async () => {
    const { db } = fakeDb({
      agents: { data: { delegations_valid_after: "2026-10-10T00:00:10Z" }, error: null },
      delegation_revocations: { data: [{ jti: "j2" }], error: null },
    });
    expect(await readDelegationRecord(db, "a", ["j1", "j2"])).toEqual({
      watermarkSeconds: Date.parse("2026-10-10T00:00:10Z") / 1000,
      revoked: ["j2"],
    });
  });
  it.each([
    ["the agents read fails", { data: null, error: { message: "x" } }, { data: [], error: null }],
    ["the revocations read fails", { data: { delegations_valid_after: null }, error: null }, { data: null, error: { message: "x" } }],
    ["the watermark is unparseable", { data: { delegations_valid_after: "nope" }, error: null }, { data: [], error: null }],
  ])("throws when %s", async (_l, agents, revocations) => {
    const { db } = fakeDb({ agents, delegation_revocations: revocations });
    await expect(readDelegationRecord(db, "a", ["j1"])).rejects.toThrow();
  });
});

describe("recordFirstExchanges", () => {
  it("upserts ignoring duplicates and returns only the rows it created", async () => {
    const { db, calls } = fakeDb({ delegation_exchanges: { data: [{ jti: "j2" }], error: null } });
    const created = await recordFirstExchanges(db, [
      { userId: "u", agentId: "a", jti: "j1", depth: 1, parentJti: null, workerKey: "k", capMicrocents: 5, scope: [], iat: 10, exp: 20 },
      { userId: "u", agentId: "a", jti: "j2", depth: 2, parentJti: "j1", workerKey: "k2", capMicrocents: 1, scope: [], iat: 11, exp: 19 },
    ]);
    expect(created).toEqual(["j2"]);
    const [rows, options] = calls["delegation_exchanges.upsert"]![0] as [Record<string, unknown>[], unknown];
    expect(options).toEqual({ onConflict: "agent_id,jti", ignoreDuplicates: true });
    expect(rows[1]).toMatchObject({ jti: "j2", parent_jti: "j1", depth: 2, issued_at: new Date(11_000).toISOString() });
  });
  it("throws when the write fails", async () => {
    const { db } = fakeDb({ delegation_exchanges: { data: null, error: { message: "x" } } });
    await expect(recordFirstExchanges(db, [])).rejects.toThrow();
  });
});

describe("delegationRecordRevokes", () => {
  const links = [{ jti: "j1", iat: 100 }, { jti: "j2", iat: 200 }];
  it("revokes on a revoked jti, or a watermark at or after any link's iat", () => {
    expect(delegationRecordRevokes({ watermarkSeconds: null, revoked: [] }, links)).toBe(false);
    expect(delegationRecordRevokes({ watermarkSeconds: null, revoked: ["j2"] }, links)).toBe(true);
    expect(delegationRecordRevokes({ watermarkSeconds: 100, revoked: [] }, links)).toBe(true);
    expect(delegationRecordRevokes({ watermarkSeconds: 99, revoked: [] }, links)).toBe(false);
  });
});
