// Key import at the agent cap must not leave the provider key behind.
//
// Both import paths store the provider key, then create the agent. With 0076's
// per-account limits live on open sign-up, an account at its agent cap had the
// key stored and the agent refused: a real provider secret in Vault, attached
// to nothing, counting against the credential cap, and a retry stored another.
//
// Two layers, both pinned here:
//   1. the cap is checked BEFORE the key is stored or the handoff is consumed,
//      so the user can free a slot and finish the same import;
//   2. anything that still fails after the store (a race past the pre-check, a
//      refused agent) deletes the credential this import created.
import { beforeEach, describe, expect, it, vi } from "vitest";

const RAW_PROVIDER_KEY = "sk-proj-provider-secret-material";
const NOW = 1_785_520_000_000;
const PASSPORT_ID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CREDENTIAL_ID = "11111111-2222-4333-8444-555555555555";

const mocks = vi.hoisted(() => {
  let sealedPlaintext = "";
  const stash = new Map<string, string>();
  const state = {
    limits: {} as Record<string, number | null>,
    limitError: null as null | { message: string },
    liveAgents: 0,
    agentsToday: 0,
    keysToday: 0,
    deleteError: null as null | { message: string },
  };

  // A PostgREST-shaped count query: chainable, awaitable, and it records the
  // filters so the count it returns is the one the trigger would compute.
  function countQuery(table: string) {
    const filters: string[] = [];
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((column: string) => (filters.push(`eq:${column}`), query)),
      neq: vi.fn((column: string, value: string) => (filters.push(`neq:${column}:${value}`), query)),
      gt: vi.fn((column: string) => (filters.push(`gt:${column}`), query)),
      then(resolve: (value: { count: number | null; error: null }) => unknown) {
        let count = 0;
        if (table === "agents" && filters.includes("neq:status:revoked")) count = state.liveAgents;
        else if (table === "agents" && filters.includes("gt:created_at")) count = state.agentsToday;
        else if (table === "agent_access_keys" && filters.includes("gt:created_at")) count = state.keysToday;
        return Promise.resolve({ count, error: null }).then(resolve);
      },
    };
    return query;
  }

  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "account_object_limit") {
      if (state.limitError) return { data: null, error: state.limitError };
      return { data: state.limits[String(args.p_column)] ?? null, error: null };
    }
    if (name === "store_provider_key_for_user") return { data: CREDENTIAL_ID, error: null };
    if (name === "delete_provider_key_for_user") return { data: null, error: state.deleteError };
    throw new Error(`unexpected rpc ${name}`);
  });
  const serviceFrom = vi.fn((table: string) => {
    if (table === "agents" || table === "agent_access_keys") return countQuery(table);
    if (table === "provider_credentials") {
      // purgeProviderKeyForTenant's agent scan; best-effort, so an empty list is fine.
      const q = { select: () => q, eq: () => q, limit: async () => ({ data: [], error: null }) };
      return q;
    }
    throw new Error(`unexpected service table ${table}`);
  });
  const credentialQuery = {
    select: vi.fn(() => credentialQuery),
    eq: vi.fn(() => credentialQuery),
    limit: vi.fn(async () => ({ data: [{ provider: "openai" }], error: null })),
  };
  const db = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: "tenant-a", email: "a@example.test" } } })),
    },
    from: vi.fn((table: string) => {
      if (table !== "provider_credentials") throw new Error(`unexpected table ${table}`);
      return credentialQuery;
    }),
  };

  return {
    state,
    rpc,
    db,
    stash,
    serviceDb: { rpc, from: serviceFrom },
    createAgent: vi.fn(async (_db: unknown, _userId: string, _input: unknown) => ({
      ok: true as const,
      value: { id: "agent-1", name: "Imported agent", createdAt: "2026-10-04T00:00:00Z", expiresAt: null },
    })),
    createDirectAgent: vi.fn(async (_db: unknown, _userId: string, input: { name: string; keyName: string }) => ({
      ok: true as const,
      value: {
        agentId: "agent-1",
        keyId: "key-1",
        key: `pc_agent_${"K".repeat(43)}`,
        name: input.name,
        keyName: input.keyName,
        expiresAt: null,
      },
    })),
    mfaAuthorizedUser: vi.fn(async () => ({ ok: true as const, user: { id: "tenant-a" } })),
    ensureProfileRow: vi.fn(async () => undefined),
    recordAdminAction: vi.fn(async () => undefined),
    captureError: vi.fn(async () => undefined),
    purgeProviderKeysCache: vi.fn(async () => undefined),
    takeKeyImport: vi.fn(async (userId: string, id: string) => {
      const value = stash.get(`${userId}:${id}`) ?? null;
      stash.delete(`${userId}:${id}`);
      return value;
    }),
    seal: vi.fn(async (plaintext: string) => {
      sealedPlaintext = plaintext;
      return "sealed";
    }),
    open: vi.fn(async () => sealedPlaintext),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => mocks.db }));
vi.mock("@/lib/supabase", () => ({ serviceClient: vi.fn(() => mocks.serviceDb) }));
vi.mock("@/lib/mfa", () => ({ mfaAuthorizedUser: mocks.mfaAuthorizedUser }));
vi.mock("@/lib/profile/manage", () => ({ ensureProfileRow: mocks.ensureProfileRow }));
vi.mock("@/lib/fleet", () => ({
  createAgent: mocks.createAgent,
  createDirectAgent: mocks.createDirectAgent,
  setTenantKill: vi.fn(),
  setAgentSuspended: vi.fn(),
  updateAgent: vi.fn(),
}));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: vi.fn(async () => ({ success: true, remaining: 4 })),
  rateLimitFailClosed: vi.fn(async () => ({ success: true, remaining: 4 })),
}));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: mocks.seal, open: mocks.open }));
vi.mock("@/lib/state/redis", () => ({
  stashKeyImport: vi.fn(),
  takeKeyImport: mocks.takeKeyImport,
  purgeProviderKeysCache: mocks.purgeProviderKeysCache,
  purgeAgentCaches: vi.fn(async () => undefined),
}));
vi.mock("@/lib/audit", () => ({ recordAdminAction: mocks.recordAdminAction }));
vi.mock("@/lib/observability", () => ({ captureError: mocks.captureError, captureSecurityEvent: vi.fn() }));
vi.mock("@/lib/seclog", () => ({ logSecurityEvent: vi.fn() }));
vi.mock("@/lib/alert", () => ({ dispatchSecurityAlert: vi.fn() }));
vi.mock("@/lib/apikeys", () => ({ generateApiKey: vi.fn() }));

import { completeKeyImport, completeKeyImportDirect } from "@/app/dashboard/actions-client";

const HANDOFF = "handoff-1";

async function stashHandoff() {
  mocks.stash.set(
    `tenant-a:${HANDOFF}`,
    await mocks.seal(JSON.stringify({
      version: 1,
      userId: "tenant-a",
      provider: "openai",
      key: RAW_PROVIDER_KEY,
      expiresAt: NOW + 60_000,
    }))
  );
}

const direct = (overrides: Record<string, unknown> = {}) =>
  completeKeyImportDirect({
    handoff: HANDOFF,
    provider: "openai",
    label: "imported",
    name: "summarizer",
    keyName: "My installation",
    models: ["gpt-5-mini"],
    ...overrides,
  } as never);

const passport = () =>
  completeKeyImport({
    handoff: HANDOFF,
    provider: "openai",
    label: "imported",
    name: "summarizer",
    passportPubkey: PASSPORT_ID,
    models: ["gpt-5-mini"],
  });

const stored = () => mocks.rpc.mock.calls.filter(([name]) => name === "store_provider_key_for_user");
const deleted = () => mocks.rpc.mock.calls.filter(([name]) => name === "delete_provider_key_for_user");

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  Object.assign(mocks.state, {
    limits: {},
    limitError: null,
    liveAgents: 0,
    agentsToday: 0,
    keysToday: 0,
    deleteError: null,
  });
  mocks.stash.clear();
  await stashHandoff();
});

describe("an import at the agent cap is refused before the key is stored", () => {
  it.each([
    ["Direct Agent Key", direct],
    ["passport", passport],
  ])("%s import: live cap", async (_label, run) => {
    mocks.state.limits.max_agents = 10;
    mocks.state.liveAgents = 10;
    await expect(run()).rejects.toThrow(/reached its limit of 10 agents/);
    expect(stored()).toHaveLength(0);
    expect(mocks.createAgent).not.toHaveBeenCalled();
    expect(mocks.createDirectAgent).not.toHaveBeenCalled();
    // The handoff is untouched, so freeing a slot finishes the same import.
    expect(mocks.takeKeyImport).not.toHaveBeenCalled();
    expect(mocks.stash.has(`tenant-a:${HANDOFF}`)).toBe(true);
  });

  it.each([
    ["Direct Agent Key", direct],
    ["passport", passport],
  ])("%s import: daily agent creations", async (_label, run) => {
    mocks.state.limits.max_creations_per_day = 50;
    mocks.state.agentsToday = 50;
    await expect(run()).rejects.toThrow(/Too many agents were created in the last 24 hours/);
    expect(stored()).toHaveLength(0);
  });

  it("Direct Agent Key import: daily agent-key creations, since it also mints a key", async () => {
    mocks.state.limits.max_creations_per_day = 50;
    mocks.state.keysToday = 50;
    await expect(direct()).rejects.toThrow(/Too many agent keys were created in the last 24 hours/);
    expect(stored()).toHaveLength(0);
  });

  it("goes ahead one below the cap", async () => {
    mocks.state.limits.max_agents = 10;
    mocks.state.liveAgents = 9;
    await expect(direct()).resolves.toMatchObject({ agentId: "agent-1" });
    expect(stored()).toHaveLength(1);
    expect(deleted()).toHaveLength(0);
  });

  it("goes ahead when the limits cannot be read: the database trigger still enforces them", async () => {
    mocks.state.limitError = { message: "function account_object_limit does not exist" };
    await expect(direct()).resolves.toMatchObject({ agentId: "agent-1" });
    expect(stored()).toHaveLength(1);
  });

  it("checks after the credential gate, so an unverified session learns nothing", async () => {
    mocks.mfaAuthorizedUser.mockResolvedValueOnce({ ok: false, reason: "step_up_required" } as never);
    await expect(direct()).rejects.toThrow(/two-factor/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("validates the Direct Agent name and installation name before storing anything", async () => {
    await expect(direct({ keyName: "" })).rejects.toThrow(/Installation name/);
    await expect(direct({ name: "   " })).rejects.toThrow(/Agent name/);
    expect(stored()).toHaveLength(0);
  });
});

describe("an agent refused after the key was stored takes the key with it", () => {
  const refusal = { ok: false as const, status: 409, code: "account_limit_reached", message: "This workspace has reached its limit of 10 agents. Revoke one you no longer use to add another." };

  it("Direct Agent Key import: deletes the credential it created and keeps the original message", async () => {
    mocks.createDirectAgent.mockResolvedValueOnce(refusal as never);
    await expect(direct()).rejects.toThrow(refusal.message);
    expect(deleted()).toEqual([["delete_provider_key_for_user", { p_user_id: "tenant-a", p_credential_id: CREDENTIAL_ID }]]);
    expect(mocks.recordAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "provider_key.delete",
      targetId: CREDENTIAL_ID,
      metadata: expect.objectContaining({ reason: "key_import_rolled_back" }),
    }));
  });

  it("passport import: same", async () => {
    mocks.createAgent.mockResolvedValueOnce(refusal as never);
    await expect(passport()).rejects.toThrow(refusal.message);
    expect(deleted()).toEqual([["delete_provider_key_for_user", { p_user_id: "tenant-a", p_credential_id: CREDENTIAL_ID }]]);
  });

  it("reports a cleanup the database refuses, and still shows the original refusal", async () => {
    // The first key for a provider is its active one, and 0027/0030 refuse to
    // delete an active credential. That key stays, visible in Settings.
    mocks.state.deleteError = { message: "active_credential" };
    mocks.createDirectAgent.mockResolvedValueOnce(refusal as never);
    await expect(direct()).rejects.toThrow(refusal.message);
    expect(mocks.captureError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ code: "key_import_rollback_failed" }));
    expect(mocks.recordAdminAction).not.toHaveBeenCalledWith(expect.objectContaining({ action: "provider_key.delete" }));
  });

  it("never puts the provider key in what it reports", async () => {
    mocks.state.deleteError = { message: `vault said ${RAW_PROVIDER_KEY}` };
    mocks.createDirectAgent.mockResolvedValueOnce(refusal as never);
    await expect(direct()).rejects.toThrow(refusal.message);
    expect(JSON.stringify(mocks.captureError.mock.calls)).not.toContain(RAW_PROVIDER_KEY);
  });
});
