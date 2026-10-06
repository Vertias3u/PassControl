import { beforeEach, describe, expect, it, vi } from "vitest";

// A worker credential is only useful if PassControl holds a provider key to
// inject for it. Without one, every call the worker makes is refused with
// `no_provider_key`, which reads to a new user like a broken product rather
// than a missing step. v1 playbook Session 04, requirement 2: check before
// issuing, offer the missing step, and never read a failed lookup as "stored".

const RAW_PROVIDER_KEY = "sk-proj-provider-secret-material";
const NOW = 1_785_520_000_000;

const mocks = vi.hoisted(() => {
  let sealedPlaintext = "";
  const stash = new Map<string, string>();
  const credentialRows = { data: [{ provider: "openai" }] as { provider: string }[] | null, error: null as null | { code: string } };
  const credentialQuery = {
    select: vi.fn(() => credentialQuery),
    eq: vi.fn(() => credentialQuery),
    limit: vi.fn(async () => ({ data: credentialRows.data, error: credentialRows.error })),
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
  const rpc = vi.fn(async () => ({ error: null }));
  return {
    db,
    rpc,
    credentialRows,
    credentialQuery,
    stash,
    serviceDb: { rpc },
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
    revalidatePath: vi.fn(),
    stashKeyImport: vi.fn(async (userId: string, id: string, sealed: string) => {
      stash.set(`${userId}:${id}`, sealed);
    }),
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

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => mocks.db }));
vi.mock("@/lib/supabase", () => ({ serviceClient: vi.fn(() => mocks.serviceDb) }));
vi.mock("@/lib/mfa", () => ({ mfaAuthorizedUser: mocks.mfaAuthorizedUser }));
vi.mock("@/lib/profile/manage", () => ({ ensureProfileRow: mocks.ensureProfileRow }));
vi.mock("@/lib/fleet", () => ({
  createDirectAgent: mocks.createDirectAgent,
  createAgent: vi.fn(),
  setTenantKill: vi.fn(),
  setAgentSuspended: vi.fn(),
}));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: vi.fn(async () => ({ success: true, remaining: 4 })),
  rateLimitFailClosed: vi.fn(async () => ({ success: true, remaining: 4 })),
}));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: mocks.seal, open: mocks.open }));
vi.mock("@/lib/state/redis", () => ({
  stashKeyImport: mocks.stashKeyImport,
  takeKeyImport: mocks.takeKeyImport,
  purgeProviderKeysCache: vi.fn(async () => {}),
  purgeAgentCaches: vi.fn(async () => {}),
  purgeAgentFallbacks: vi.fn(async () => {}),
}));
vi.mock("@/lib/audit", () => ({ recordAdminAction: mocks.recordAdminAction }));
vi.mock("@/lib/seclog", () => ({ logSecurityEvent: vi.fn() }));
vi.mock("@/lib/alert", () => ({ dispatchSecurityAlert: vi.fn() }));
vi.mock("@/lib/apikeys", () => ({ generateApiKey: vi.fn() }));

import { completeKeyImportDirect, issueDirectAgent } from "@/app/dashboard/actions-client";

const openaiWorker = {
  name: "summarizer",
  keyName: "My installation",
  scopes: [{ provider: "openai", models: ["gpt-5-mini"] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stash.clear();
  mocks.credentialRows.data = [{ provider: "openai" }];
  mocks.credentialRows.error = null;
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

describe("issuing a worker credential checks the provider key first", () => {
  it("issues when a key for the scoped provider is stored", async () => {
    const issued = await issueDirectAgent(openaiWorker);
    expect(issued.agentId).toBe("agent-1");
    expect(mocks.createDirectAgent).toHaveBeenCalledOnce();
  });

  it("refuses, naming the provider, when no key for it is stored — and mints nothing", async () => {
    mocks.credentialRows.data = [{ provider: "anthropic" }];
    await expect(issueDirectAgent(openaiWorker)).rejects.toThrow(/No openai provider key is stored/);
    expect(mocks.createDirectAgent).not.toHaveBeenCalled();
  });

  it("refuses when the stored keys cannot be read, rather than assuming one exists", async () => {
    mocks.credentialRows.data = null;
    mocks.credentialRows.error = { code: "57014" };
    await expect(issueDirectAgent(openaiWorker)).rejects.toThrow(/could not confirm/i);
    expect(mocks.createDirectAgent).not.toHaveBeenCalled();
  });

  it("checks after the credential gate, so an unverified session learns nothing about stored keys", async () => {
    mocks.mfaAuthorizedUser.mockResolvedValueOnce({ ok: false, reason: "step_up_required" } as never);
    await expect(issueDirectAgent(openaiWorker)).rejects.toThrow(/two-factor/);
    expect(mocks.db.from).not.toHaveBeenCalled();
  });
});

describe("the key-import on-ramp can finish with a Direct Agent Key", () => {
  async function probedHandoff(): Promise<string> {
    const handoff = "handoff-1";
    await mocks.stashKeyImport(
      "tenant-a",
      handoff,
      await mocks.seal(JSON.stringify({
        version: 1,
        userId: "tenant-a",
        provider: "openai",
        key: RAW_PROVIDER_KEY,
        expiresAt: NOW + 60_000,
      }))
    );
    return handoff;
  }

  it("stores the provider key, then issues one worker credential — returning the key once and no provider secret", async () => {
    const result = await completeKeyImportDirect({
      handoff: await probedHandoff(),
      provider: "openai",
      label: "imported",
      name: "summarizer",
      keyName: "My installation",
      models: ["gpt-5-mini"],
    });
    expect(mocks.rpc).toHaveBeenCalledWith("store_provider_key_for_user", expect.objectContaining({ p_provider: "openai", p_user_id: "tenant-a" }));
    expect(mocks.createDirectAgent).toHaveBeenCalledWith(
      mocks.serviceDb,
      "tenant-a",
      expect.objectContaining({ scopes: [{ provider: "openai", models: ["gpt-5-mini"] }], keyName: "My installation" })
    );
    expect(result.key).toMatch(/^pc_agent_/);
    expect(JSON.stringify(result)).not.toContain(RAW_PROVIDER_KEY);
    // Revalidating before the reveal is acknowledged would remount the on-ramp
    // and destroy a key that exists nowhere else.
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("is single-use: a replayed handoff issues nothing", async () => {
    const handoff = await probedHandoff();
    await completeKeyImportDirect({ handoff, provider: "openai", label: "imported", name: "a", keyName: "k", models: ["gpt-5-mini"] });
    await expect(
      completeKeyImportDirect({ handoff, provider: "openai", label: "imported", name: "b", keyName: "k", models: ["gpt-5-mini"] })
    ).rejects.toThrow(/expired/);
    expect(mocks.createDirectAgent).toHaveBeenCalledOnce();
  });
});

describe("the connect form's reading of stored providers", () => {
  it("tells stored, missing and unreadable apart, and never reads a failed read as either", async () => {
    const { providerAvailability } = await import("@/lib/agent-connect");
    expect(providerAvailability(["openai"], "openai")).toBe("configured");
    expect(providerAvailability(["anthropic"], "openai")).toBe("missing");
    expect(providerAvailability([], "openai")).toBe("missing");
    expect(providerAvailability(null, "openai")).toBe("unknown");
    expect(providerAvailability(undefined, "openai")).toBe("unchecked");
  });

  it("blocks Create for a missing or unreadable provider and offers the missing step", async () => {
    const { readFileSync } = await import("node:fs");
    const ui = readFileSync("components/DirectAgentConnect.tsx", "utf8");
    expect(ui).toMatch(/availability === "missing" \|\| availability === "unknown"/);
    expect(ui).toMatch(/href="\/dashboard\/settings#provider-credentials"/);
    expect(ui).toMatch(/router\.refresh\(\)/);
    // The grant starts at the concrete model, not a family wildcard.
    expect(ui).toMatch(/useState\(DEFAULT_CLIENT_MODELS\[initialProvider\]\);\n  const \[clientModel/);
  });
});
