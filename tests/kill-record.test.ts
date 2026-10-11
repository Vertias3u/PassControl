import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * lib/state/kill-record.ts: the kill switches' durable record (0083), through the
 * service role. Each stop is scoped to its tenant by hand, because the service
 * role bypasses RLS: a delete that forgot `user_id` would clear another tenant's
 * stop of the same kind.
 */
const { calls, result, client } = vi.hoisted(() => {
  const calls: Array<[string, ...unknown[]]> = [];
  const result: { value: { data?: unknown; error: unknown } } = { value: { data: [], error: null } };
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "insert", "delete", "eq", "order"]) {
    chain[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
      return chain;
    };
  }
  chain.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(result.value).then(ok, bad);
  const client = {
    from: vi.fn((table: string) => {
      calls.push(["from", table]);
      return chain;
    }),
  };
  return { calls, result, client };
});
vi.mock("../lib/supabase", () => ({ serviceClient: () => client }));

import { loadKillRecords, saveKillRecord, deleteKillRecord } from "../lib/state/kill-record";

const U = "11111111-1111-4111-8111-111111111111";
const A = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  calls.length = 0;
  result.value = { data: [], error: null };
});

describe("loadKillRecords", () => {
  it("reads one tenant's rows and turns each into the stop it records", async () => {
    result.value = {
      data: [
        { kind: "tenant", service: null, agent_id: null, session_id: null },
        { kind: "service", service: "github", agent_id: null, session_id: null },
        { kind: "session", service: null, agent_id: A, session_id: "claude-code:s1" },
      ],
      error: null,
    };
    expect(await loadKillRecords(U)).toEqual([
      { kind: "tenant" },
      { kind: "service", service: "github" },
      { kind: "session", agentId: A, sessionId: "claude-code:s1" },
    ]);
    expect(calls).toContainEqual(["from", "kill_switch_records"]);
    expect(calls).toContainEqual(["eq", "user_id", U]);
  });

  it("throws on a failed read, so the caller applies the fail posture instead of 'nothing armed'", async () => {
    result.value = { data: null, error: { message: "relation does not exist" } };
    await expect(loadKillRecords(U)).rejects.toThrow();
  });

  it("skips a row it cannot turn back into a key rather than guessing", async () => {
    result.value = {
      data: [
        { kind: "service", service: null, agent_id: null, session_id: null },
        { kind: "session", service: null, agent_id: A, session_id: "has space" },
        { kind: "tenant", service: null, agent_id: null, session_id: null },
      ],
      error: null,
    };
    expect(await loadKillRecords(U)).toEqual([{ kind: "tenant" }]);
  });
});

describe("saveKillRecord", () => {
  it("inserts the tenant's row", async () => {
    expect(await saveKillRecord(U, { kind: "session", agentId: A, sessionId: "s1" })).toBe(true);
    expect(calls).toContainEqual([
      "insert",
      { user_id: U, kind: "session", service: null, agent_id: A, session_id: "s1" },
    ]);
  });

  it("reads 'already recorded' (a unique violation) as saved: arming twice is not a failure", async () => {
    result.value = { error: { code: "23505", message: "duplicate key value" } };
    expect(await saveKillRecord(U, { kind: "tenant" })).toBe(true);
  });

  it("answers false, never throws, on any other failure", async () => {
    result.value = { error: { code: "42P01", message: "missing" } };
    expect(await saveKillRecord(U, { kind: "tenant" })).toBe(false);
    client.from.mockImplementationOnce(() => {
      throw new Error("env not set");
    });
    expect(await saveKillRecord(U, { kind: "tenant" })).toBe(false);
  });
});

describe("deleteKillRecord", () => {
  it("deletes only this tenant's row of this stop", async () => {
    expect(await deleteKillRecord(U, { kind: "service", service: "github" })).toBe(true);
    expect(calls).toContainEqual(["delete"]);
    expect(calls).toContainEqual(["eq", "user_id", U]);
    expect(calls).toContainEqual(["eq", "kind", "service"]);
    expect(calls).toContainEqual(["eq", "service", "github"]);
  });

  it("names the agent and session for a session stop", async () => {
    await deleteKillRecord(U, { kind: "session", agentId: A, sessionId: "s1" });
    expect(calls).toContainEqual(["eq", "agent_id", A]);
    expect(calls).toContainEqual(["eq", "session_id", "s1"]);
  });

  it("answers false, never throws, on a failure", async () => {
    result.value = { error: { message: "down" } };
    expect(await deleteKillRecord(U, { kind: "tenant" })).toBe(false);
  });
});
