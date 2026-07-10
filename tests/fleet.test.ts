import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";

// Mock the side-effecting machinery; assert it's invoked. (vi.hoisted so the
// fns exist before the hoisted vi.mock factories run.)
const { suspendAgent, unsuspendAgent, purgeAgentCaches, armTenantKill } = vi.hoisted(() => ({
  suspendAgent: vi.fn(async () => {}),
  unsuspendAgent: vi.fn(async () => {}),
  purgeAgentCaches: vi.fn(async () => {}),
  armTenantKill: vi.fn(async () => {}),
}));
vi.mock("@/lib/state/redis", () => ({ suspendAgent, unsuspendAgent, purgeAgentCaches }));
vi.mock("@/lib/state/killswitch", () => ({ armTenantKill }));

import { createAgent, updateAgent, setAgentSuspended, revokeAgent, setTenantKill } from "@/lib/fleet";
import { PROVIDERS } from "@/lib/providers";
import { validateAgentUpdate } from "@/lib/validate";

// Chainable Supabase mock that records insert/update payloads + eq() filters.
function makeDb(
  result: { data: unknown; error: unknown },
  selectResult: { data: unknown; error: unknown } = result
) {
  const calls = {
    from: [] as string[],
    insert: null as any,
    update: null as any,
    eq: [] as [string, unknown][],
    neq: [] as [string, unknown][],
  };
  const builder = () => {
    let mutation = false;
    const b: any = {
      insert: (p: any) => { mutation = true; calls.insert = p; return b; },
      update: (p: any) => { mutation = true; calls.update = p; return b; },
      select: () => b,
      eq: (c: string, v: unknown) => { calls.eq.push([c, v]); return b; },
      neq: (c: string, v: unknown) => { calls.neq.push([c, v]); return b; },
      single: async () => result,
      maybeSingle: async () => mutation ? result : selectResult,
      then: (res: any) => res(result),
    };
    return b;
  };
  return { db: { from: (t: string) => { calls.from.push(t); return builder(); } } as any, calls };
}

const validPubkey = randomBytes(32).toString("base64url"); // 32-byte Ed25519-shaped key
const validInput = { name: "bot", passportPubkey: validPubkey, scopes: [{ provider: "anthropic", models: ["claude-*"] }] };

beforeEach(() => vi.clearAllMocks());

describe("createAgent", () => {
  it("inserts scoped to userId and returns the new id", async () => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null });
    const r = await createAgent(db, "u1", validInput);
    expect(r).toEqual({ ok: true, value: { id: "a1", name: "bot" } });
    expect(calls.insert.user_id).toBe("u1"); // tenant binding
    expect(calls.insert.passport_pubkey).toBe(validPubkey);
    expect(calls.insert.budget_tokens).toBeNull();
    expect(calls.insert.budget_cents).toBeNull();
  });

  it("persists optional token and cost budgets on create", async () => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null });
    await createAgent(db, "u1", { ...validInput, budget_tokens: 1000, budget_cents: 500 });
    expect(calls.insert.budget_tokens).toBe(1000);
    expect(calls.insert.budget_cents).toBe(500);
  });

  it("rejects invalid input (422) without touching the DB", async () => {
    const { db, calls } = makeDb({ data: null, error: null });
    const r = await createAgent(db, "u1", { name: "", passportPubkey: "bad", scopes: [] });
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(calls.insert).toBeNull();
  });

  it("maps a unique-violation to 409 agent_exists", async () => {
    const { db } = makeDb({ data: null, error: { code: "23505" } });
    expect(await createAgent(db, "u1", validInput)).toMatchObject({ ok: false, status: 409, code: "agent_exists" });
  });
});

describe("validateAgentUpdate", () => {
  it("maps only provided fields to DB columns", () => {
    expect(validateAgentUpdate({ name: "new", budget_tokens: 1000 })).toEqual({
      name: "new",
      budget_tokens: 1000,
    });
  });
  it("accepts null budgets (= unlimited) and validates scopes", () => {
    const p = validateAgentUpdate({ budget_cents: null, scopes: [{ provider: "openai", models: ["gpt-4o"] }] });
    expect(p.budget_cents).toBeNull();
    expect(p.allowed_scopes).toEqual([{ provider: "openai", models: ["gpt-4o"] }]);
  });
  it("rejects bad budgets and unknown providers", () => {
    expect(() => validateAgentUpdate({ budget_tokens: -5 })).toThrow();
    expect(() => validateAgentUpdate({ budget_tokens: 1.5 })).toThrow();
    expect(() => validateAgentUpdate({ scopes: [{ provider: "evil", models: [] }] })).toThrow();
  });
  it("returns {} when nothing is provided", () => {
    expect(validateAgentUpdate({})).toEqual({});
  });
});

describe("updateAgent", () => {
  it("applies a tenant-scoped patch", async () => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null });
    const r = await updateAgent(db, "u1", "a1", { name: "renamed", budget_tokens: 500, budget_cents: null });
    expect(r).toEqual({ ok: true, value: { id: "a1" } });
    expect(calls.update).toEqual({ name: "renamed", budget_tokens: 500, budget_cents: null });
    expect(calls.eq).toContainEqual(["user_id", "u1"]);
    expect(calls.eq).toContainEqual(["id", "a1"]);
  });
  it("400 on an empty patch (no DB write)", async () => {
    const { db, calls } = makeDb({ data: null, error: null });
    const r = await updateAgent(db, "u1", "a1", {});
    expect(r).toMatchObject({ ok: false, status: 400, code: "empty_update" });
    expect(calls.update).toBeNull();
  });
  it("422 on invalid input", async () => {
    const { db } = makeDb({ data: null, error: null });
    expect(await updateAgent(db, "u1", "a1", { budget_tokens: -1 })).toMatchObject({ ok: false, status: 422 });
  });
  it("404 when not the caller's agent", async () => {
    const { db } = makeDb({ data: null, error: null });
    expect(await updateAgent(db, "u1", "a1", { name: "x" })).toMatchObject({ ok: false, status: 404 });
  });
});

describe("setAgentSuspended", () => {
  it("does not mutate Postgres when the security-critical Redis suspend fails", async () => {
    suspendAgent.mockRejectedValueOnce(new Error("redis unavailable"));
    const { db, calls } = makeDb(
      { data: { id: "a1" }, error: null },
      { data: { id: "a1", status: "active" }, error: null }
    );

    await expect(setAgentSuspended(db, "u1", "a1", true)).rejects.toThrow("redis unavailable");
    expect(calls.update).toBeNull();
  });

  it("repairs a stale Redis suspend when Postgres is already active", async () => {
    const { db } = makeDb(
      { data: null, error: null },
      { data: { id: "a1", status: "active" }, error: null }
    );

    const r = await setAgentSuspended(db, "u1", "a1", false);

    expect(r).toEqual({ ok: true, value: { id: "a1" } });
    expect(unsuspendAgent).toHaveBeenCalledWith("a1");
  });

  it("suspends: scoped update + Redis suspend + cache purge", async () => {
    const { db, calls } = makeDb(
      { data: { id: "a1" }, error: null },
      { data: { id: "a1", status: "active" }, error: null }
    );
    const r = await setAgentSuspended(db, "u1", "a1", true);
    expect(r).toEqual({ ok: true, value: { id: "a1" } });
    expect(calls.update).toEqual({ status: "suspended" });
    expect(calls.eq).toContainEqual(["user_id", "u1"]);
    expect(calls.eq).toContainEqual(["id", "a1"]);
    expect(suspendAgent).toHaveBeenCalledWith("a1");
    expect(purgeAgentCaches).toHaveBeenCalledWith("a1", PROVIDERS);
    expect(unsuspendAgent).not.toHaveBeenCalled();
  });

  it("resumes only an explicitly suspended agent", async () => {
    const { db, calls } = makeDb(
      { data: { id: "a1" }, error: null },
      { data: { id: "a1", status: "suspended" }, error: null }
    );
    await setAgentSuspended(db, "u1", "a1", false);
    expect(calls.update).toEqual({ status: "active" });
    expect(calls.eq).toContainEqual(["status", "suspended"]);
    expect(unsuspendAgent).toHaveBeenCalledWith("a1");
    expect(suspendAgent).not.toHaveBeenCalled();
  });

  it("404 when the agent isn't the caller's (no Redis effect)", async () => {
    const { db } = makeDb({ data: null, error: null });
    const r = await setAgentSuspended(db, "u1", "a1", true);
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(suspendAgent).not.toHaveBeenCalled();
  });
});

describe("revokeAgent", () => {
  it("does not persist revocation when the security-critical Redis block fails", async () => {
    suspendAgent.mockRejectedValueOnce(new Error("redis unavailable"));
    const { db, calls } = makeDb(
      { data: { id: "a1" }, error: null },
      { data: { id: "a1", status: "active" }, error: null }
    );

    await expect(revokeAgent(db, "u1", "a1")).rejects.toThrow("redis unavailable");
    expect(calls.update).toBeNull();
  });

  it("sets status revoked + suspend + purge", async () => {
    const { db, calls } = makeDb(
      { data: { id: "a1" }, error: null },
      { data: { id: "a1", status: "active" }, error: null }
    );
    const r = await revokeAgent(db, "u1", "a1");
    expect(r).toEqual({ ok: true, value: { id: "a1" } });
    expect(calls.update).toEqual({ status: "revoked" });
    expect(calls.eq).toContainEqual(["user_id", "u1"]);
    expect(calls.eq).toContainEqual(["status", "active"]);
    expect(suspendAgent).toHaveBeenCalledWith("a1");
  });
  it("404 when not found", async () => {
    const { db } = makeDb({ data: null, error: null });
    expect(await revokeAgent(db, "u1", "a1")).toMatchObject({ ok: false, status: 404 });
  });
});

describe("setTenantKill", () => {
  it("arms only the tenant kill flag; it never overwrites individual suspension state", async () => {
    const { db, calls } = makeDb({ data: [{ id: "a1" }, { id: "a2" }], error: null });
    const r = await setTenantKill(db, "u1", true);
    expect(r).toEqual({ ok: true, value: { affected: 2 } });
    expect(armTenantKill).toHaveBeenCalledWith("u1", true);
    expect(calls.eq).toContainEqual(["user_id", "u1"]);
    expect(suspendAgent).not.toHaveBeenCalled();
    expect(unsuspendAgent).not.toHaveBeenCalled();
    expect(purgeAgentCaches).not.toHaveBeenCalled();
  });

  it("disarms only the tenant kill flag; individual suspension markers remain untouched", async () => {
    const { db } = makeDb({ data: [{ id: "a1" }], error: null });
    await setTenantKill(db, "u1", false);
    expect(armTenantKill).toHaveBeenCalledWith("u1", false);
    expect(suspendAgent).not.toHaveBeenCalled();
    expect(unsuspendAgent).not.toHaveBeenCalled();
    expect(purgeAgentCaches).not.toHaveBeenCalled();
  });
});
