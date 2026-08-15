import { beforeEach, describe, expect, it, vi } from "vitest";

const RAW_KEY = "sk-ant-api03-super-secret-key-material";
const PASSPORT_ID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const NOW = 1_785_520_000_000;

const mocks = vi.hoisted(() => {
  let currentUserId = "tenant-a";
  let sealedPlaintext = "";

  const rpc = vi.fn(async (): Promise<{ error: null | { message: string } }> => ({ error: null }));
  const usersSelect = vi.fn(async () => ({ data: [{ id: currentUserId }], error: null }));
  const usersUpsert = vi.fn(() => ({ select: usersSelect }));
  const from = vi.fn((table: string) => {
    if (table !== "users") throw new Error(`unexpected table ${table}`);
    return { upsert: usersUpsert };
  });
  const db = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: currentUserId, email: `${currentUserId}@example.test` } },
      })),
    },
    rpc,
    from,
  };

  // A real in-memory store, not a stub: the point of the Redis-backed handoff
  // is that redeeming DELETES it, and a vi.fn() returning a fixed value could
  // not tell a single-use handoff from a replayable one.
  const stash = new Map<string, string>();

  return {
    db,
    rpc,
    from,
    usersUpsert,
    stash,
    stashKeyImport: vi.fn(async (userId: string, id: string, sealed: string) => {
      stash.set(`${userId}:${id}`, sealed);
    }),
    takeKeyImport: vi.fn(async (userId: string, id: string) => {
      const key = `${userId}:${id}`;
      const value = stash.get(key) ?? null;
      stash.delete(key);
      return value;
    }),
    // Adding a key changes which providers an exhausted call can fail over to,
    // so addProviderKey drops that cache. Asserted below rather than merely
    // stubbed — an import that leaves the list stale advertises the wrong set.
    purgeProviderKeysCache: vi.fn(async (_userId: string) => {}),
    createAgent: vi.fn(async (_db: unknown, _userId: string, _input: unknown) => ({
      ok: true,
      value: { id: "agent-1", name: "Imported agent" },
    })),
    rateLimit: vi.fn(async () => ({ success: true, remaining: 4 })),
    recordAdminAction: vi.fn(async () => undefined),
    revalidatePath: vi.fn(),
    seal: vi.fn(async (plaintext: string) => {
      sealedPlaintext = plaintext;
      return "opaque-encrypted-handoff";
    }),
    open: vi.fn(async () => sealedPlaintext),
    headers: vi.fn(async () => new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.2" })),
    // vi.clearAllMocks() clears call history but NOT queued mockResolvedValueOnce
    // values, so an unconsumed one leaks into the next test and is returned in
    // place of that test's own. Reset the implementation explicitly.
    resetOpen(open: ReturnType<typeof vi.fn>) {
      open.mockReset();
      open.mockImplementation(async () => sealedPlaintext);
    },
    setUser(id: string) {
      currentUserId = id;
    },
    resetSealed() {
      sealedPlaintext = "";
    },
  };
});

vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => mocks.db }));
vi.mock("@/lib/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/lib/fleet", () => ({
  createAgent: mocks.createAgent,
  setTenantKill: vi.fn(),
  setAgentSuspended: vi.fn(),
  updateAgent: vi.fn(),
}));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: mocks.seal, open: mocks.open }));
vi.mock("@/lib/state/redis", () => ({
  stashKeyImport: mocks.stashKeyImport,
  takeKeyImport: mocks.takeKeyImport,
  purgeProviderKeysCache: mocks.purgeProviderKeysCache,
}));
vi.mock("@/lib/audit", () => ({ recordAdminAction: mocks.recordAdminAction }));
vi.mock("@/lib/seclog", () => ({ logSecurityEvent: vi.fn() }));
vi.mock("@/lib/alert", () => ({ dispatchSecurityAlert: vi.fn() }));
vi.mock("@/lib/apikeys", () => ({ generateApiKey: vi.fn() }));

import {
  PROVIDERS,
  authHeaders,
  detectProviderFromKey,
  modelListingUrl,
  resolveProviderSelection,
  type ProviderId,
} from "@/lib/providers";
import { completeKeyImport, probeProviderKey } from "@/app/dashboard/actions";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.setUser("tenant-a");
  mocks.resetSealed();
  mocks.resetOpen(mocks.open);
  mocks.stash.clear();
  mocks.rpc.mockReset();
  mocks.rpc.mockResolvedValue({ error: null });
  mocks.createAgent.mockReset();
  mocks.createAgent.mockResolvedValue({
    ok: true,
    value: { id: "agent-1", name: "Imported agent" },
  });
  mocks.rateLimit.mockReset();
  mocks.rateLimit.mockResolvedValue({ success: true, remaining: 4 });
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

describe("key-shape provider detection", () => {
  it.each([
    ["openai", "sk-proj-example", "openai", false],
    ["anthropic", "sk-ant-api03-example", "anthropic", false],
    ["groq", "gsk_example", "groq", false],
    ["mistral", "plain-mistral-key-with-no-public-prefix", null, true],
    ["together", "plain-together-key-with-no-public-prefix", null, true],
    ["deepseek", "sk-example-shared-prefix", "openai", true],
  ] satisfies Array<[ProviderId, string, ProviderId | null, boolean]>) (
    "classifies the known limits of %s's key shape",
    (_provider, key, suggested, ambiguous) => {
      expect(detectProviderFromKey(key)).toMatchObject({ suggested, ambiguous });
    }
  );

  it.each([
    ["openai", "sk-proj-example"],
    ["anthropic", "sk-ant-api03-example"],
    ["groq", "gsk_example"],
    ["mistral", "plain-mistral-key-with-no-public-prefix"],
    ["together", "plain-together-key-with-no-public-prefix"],
    ["deepseek", "sk-example-shared-prefix"],
  ] satisfies Array<[ProviderId, string]>) (
    "lets an explicit %s dropdown selection override every heuristic",
    (provider, key) => {
      expect(PROVIDERS).toContain(provider);
      expect(resolveProviderSelection(key, provider)).toBe(provider);
    }
  );

  it("recognizes distinctive prefixes but marks a bare sk- as ambiguous", () => {
    expect(detectProviderFromKey("sk-ant-api03-example")).toMatchObject({
      suggested: "anthropic",
      candidates: ["anthropic"],
      ambiguous: false,
    });
    expect(detectProviderFromKey("gsk_example")).toMatchObject({
      suggested: "groq",
      candidates: ["groq"],
      ambiguous: false,
    });
    expect(detectProviderFromKey("sk-proj-example")).toMatchObject({
      suggested: "openai",
      candidates: ["openai"],
      ambiguous: false,
    });
    expect(detectProviderFromKey("sk-example-shared-prefix")).toMatchObject({
      suggested: "openai",
      candidates: ["openai", "deepseek"],
      ambiguous: true,
    });
  });
});

describe("server-side provider model probe", () => {
  it.each([
    ["openai", "https://api.openai.com/v1/models"],
    ["anthropic", "https://api.anthropic.com/v1/models"],
    ["groq", "https://api.groq.com/openai/v1/models"],
    ["mistral", "https://api.mistral.ai/v1/models"],
    ["together", "https://api.together.ai/v1/models"],
    ["deepseek", "https://api.deepseek.com/models"],
  ] satisfies Array<[ProviderId, string]>) (
    "uses %s's model-listing URL and existing auth-header helper",
    async (provider, expectedUrl) => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: `${provider}-model` }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await probeProviderKey({ provider, key: RAW_KEY });

      expect(modelListingUrl(provider)).toBe(expectedUrl);
      expect(fetchMock).toHaveBeenCalledWith(
        expectedUrl,
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining(authHeaders(provider, RAW_KEY)),
        })
      );
      expect(result).toMatchObject({
        ok: true,
        provider,
        mode: "detected",
        models: [`${provider}-model`],
        handoff: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
      expect(JSON.stringify(result)).not.toContain(RAW_KEY);
    }
  );

  it("rate-limits the tenant and source independently before making an authenticated outbound request", async () => {
    mocks.rateLimit
      .mockResolvedValueOnce({ success: true, remaining: 4 })
      .mockResolvedValueOnce({ success: false, remaining: 0 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(probeProviderKey({ provider: "anthropic", key: RAW_KEY })).resolves.toEqual({
      ok: false,
      error: "rate_limited",
      message: "Too many detection attempts. Please wait a minute and try again.",
    });
    expect(mocks.rateLimit.mock.calls).toEqual([
      ["key-import-probe:tenant:tenant-a", 5, 60],
      ["key-import-probe:ip:203.0.113.7", 30, 60],
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.seal).not.toHaveBeenCalled();
  });

  it("returns only a plain invalid-key error and never reads or returns the upstream body", async () => {
    const reflected = `upstream reflected ${RAW_KEY}`;
    const json = vi.fn(async () => ({ error: reflected }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, json }))
    );

    const result = await probeProviderKey({ provider: "anthropic", key: RAW_KEY });

    expect(result).toEqual({
      ok: false,
      error: "invalid_key",
      message: "That key didn't work.",
    });
    expect(json).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(RAW_KEY);
    expect(mocks.seal).not.toHaveBeenCalled();
  });

  it("filters a secret reflected in an otherwise successful model-list response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: RAW_KEY }, { id: "claude-safe" }] }), {
          status: 200,
        })
      )
    );

    const result = await probeProviderKey({ provider: "anthropic", key: RAW_KEY });

    expect(result).toMatchObject({ ok: true, mode: "detected", models: ["claude-safe"] });
    expect(JSON.stringify(result)).not.toContain(RAW_KEY);
  });

  it("degrades a probe outage to manual scope selection and can still finish the import", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error(`network failure reflected ${RAW_KEY}`);
    }));

    const probed = await probeProviderKey({ provider: "anthropic", key: RAW_KEY });
    expect(probed).toMatchObject({
      ok: true,
      provider: "anthropic",
      mode: "manual",
      models: [],
      handoff: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(JSON.stringify(probed)).not.toContain(RAW_KEY);

    if (!probed.ok) throw new Error("expected a manual handoff");
    const completed = await completeKeyImport({
      handoff: probed.handoff,
      provider: "anthropic",
      label: "imported",
      name: "Imported agent",
      passportPubkey: PASSPORT_ID,
      models: ["claude-sonnet-*"],
    });

    expect(completed).toEqual({
      agentId: "agent-1",
      provider: "anthropic",
      scope: [{ provider: "anthropic", models: ["claude-sonnet-*"] }],
    });
    expect(mocks.rpc).toHaveBeenCalledWith("store_provider_key", {
      p_provider: "anthropic",
      p_label: "imported",
      p_plaintext: RAW_KEY,
    });
    // The tenant's provider list is cached for 5 minutes to answer "what could
    // this agent fail over to". An import that does not drop it advertises the
    // wrong set for the next five minutes.
    expect(mocks.purgeProviderKeysCache).toHaveBeenCalledWith("tenant-a");
    expect(mocks.createAgent).toHaveBeenCalledWith(
      mocks.db,
      "tenant-a",
      expect.objectContaining({
        name: "Imported agent",
        passportPubkey: PASSPORT_ID,
        scopes: [{ provider: "anthropic", models: ["claude-sonnet-*"] }],
      })
    );
  });

  it("does not revalidate while the browser holds the reveal-once passport secret", async () => {
    const probed = await probeProviderKey({ provider: "anthropic", key: RAW_KEY });
    if (!probed.ok) throw new Error("expected a successful probe");

    await completeKeyImport({
      handoff: probed.handoff,
      provider: "anthropic",
      label: "imported",
      name: "Imported agent",
      passportPubkey: PASSPORT_ID,
      models: ["claude-a"],
    });

    // A server revalidation remounts KeyImportOnramp before it can commit the
    // locally generated private key to React state. Refresh belongs after the
    // operator acknowledges storing the reveal-once setup snippet.
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe("key import secret and tenant boundaries", () => {
  it("stores through store_provider_key, creates through fleet, and returns the chosen probed scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ id: "claude-a" }, { id: "claude-b" }] }), {
          status: 200,
        })
      )
    );
    const probed = await probeProviderKey({ provider: "anthropic", key: RAW_KEY });
    if (!probed.ok) throw new Error("expected a probe handoff");

    const result = await completeKeyImport({
      handoff: probed.handoff,
      provider: "anthropic",
      label: "existing key",
      name: "Imported agent",
      passportPubkey: PASSPORT_ID,
      models: probed.models,
    });

    expect(result.scope).toEqual([
      { provider: "anthropic", models: ["claude-a", "claude-b"] },
    ]);
    expect(result.agentId).toBe("agent-1");
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.createAgent).toHaveBeenCalledTimes(1);
    expect(mocks.createAgent.mock.calls[0]?.[1]).toBe("tenant-a");
  });

  it("binds the encrypted handoff to the authenticated tenant before any mutation", async () => {
    mocks.open.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        userId: "tenant-b",
        provider: "anthropic",
        key: RAW_KEY,
        expiresAt: NOW + 60_000,
      })
    );

    await expect(
      completeKeyImport({
        handoff: "foreign-handoff",
        provider: "anthropic",
        label: "foreign",
        name: "Imported agent",
        passportPubkey: PASSPORT_ID,
        models: ["claude-a"],
      })
    ).rejects.toThrow("This key import has expired. Start again.");

    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  // The whole reason the sealed key lives in Redis rather than travelling to the
  // browser: the client holds an unguessable REFERENCE, and redeeming it destroys
  // it. A captured handoff must not be replayable for the rest of its TTL.
  it("keeps the sealed key server-side and redeems the handoff exactly once", async () => {
    const probed = await probeProviderKey({ provider: "anthropic", key: RAW_KEY });
    if (!probed.ok) throw new Error("expected a successful probe");

    // What crosses to the browser is an opaque id, not the sealed material.
    expect(probed.handoff).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(probed)).not.toContain(RAW_KEY);
    expect(JSON.stringify(probed)).not.toContain("opaque-encrypted-handoff");
    expect(mocks.stashKeyImport).toHaveBeenCalledWith(
      "tenant-a",
      probed.handoff,
      "opaque-encrypted-handoff",
      expect.any(Number)
    );

    const args = {
      handoff: probed.handoff,
      provider: "anthropic",
      label: "imported",
      name: "Imported agent",
      passportPubkey: PASSPORT_ID,
      models: ["claude-a"],
    };
    await expect(completeKeyImport(args)).resolves.toMatchObject({ provider: "anthropic" });

    // Second redemption of the same id finds nothing and mutates nothing.
    mocks.createAgent.mockClear();
    await expect(completeKeyImport(args)).rejects.toThrow("This key import has expired. Start again.");
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  // A handoff id belonging to another tenant is not redeemable, because the
  // tenant is part of the Redis key rather than merely checked afterwards.
  it("cannot redeem another tenant's handoff id", async () => {
    const probed = await probeProviderKey({ provider: "anthropic", key: RAW_KEY });
    if (!probed.ok) throw new Error("expected a successful probe");

    mocks.setUser("tenant-b");
    await expect(
      completeKeyImport({
        handoff: probed.handoff,
        provider: "anthropic",
        label: "imported",
        name: "Imported agent",
        passportPubkey: PASSPORT_ID,
        models: ["claude-a"],
      })
    ).rejects.toThrow("This key import has expired. Start again.");
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  it("never writes a raw key or an upstream-reflected key to logs or error output", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.open.mockResolvedValueOnce(
      JSON.stringify({
        version: 1,
        userId: "tenant-a",
        provider: "anthropic",
        key: RAW_KEY,
        expiresAt: NOW + 60_000,
      })
    );
    mocks.rpc.mockResolvedValueOnce({ error: { message: `vault rejected ${RAW_KEY}` } });

    // Seed a redeemable handoff for this tenant: the id is the input here, and
    // `open` above supplies the plaintext it decrypts to.
    const handoffId = "11111111-2222-3333-4444-555555555555";
    mocks.stash.set(`tenant-a:${handoffId}`, "sealed");

    await expect(
      completeKeyImport({
        handoff: handoffId,
        provider: "anthropic",
        label: "imported",
        name: "Imported agent",
        passportPubkey: PASSPORT_ID,
        models: ["claude-a"],
      })
    ).rejects.toThrow("Something went wrong. Please try again.");

    const actualOutput = JSON.stringify([
      ...error.mock.calls,
      ...warn.mock.calls,
      ...log.mock.calls,
    ]);
    expect(actualOutput).not.toContain(RAW_KEY);
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });
});
