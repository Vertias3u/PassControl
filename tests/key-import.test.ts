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
  // `rpc` deliberately lives on the SERVICE client only. 0030 drops the
  // auth.uid()-derived provider-key RPCs, so the user-scoped client has no
  // business calling one — and leaving `rpc` off this object means a regression
  // back to `db.rpc(...)` fails loudly here rather than passing silently.
  // `from` deliberately lives on the SERVICE client only, for the same reason
  // `rpc` does. 0032 revokes INSERT/UPDATE/DELETE on public.users from
  // `authenticated`, so the profile-row upsert cannot run under the dashboard
  // user's JWT any more. Leaving `from` off this object means a regression back
  // to `db.from("users")` fails loudly here instead of passing silently and then
  // failing in production as an unrelated foreign-key error.
  const db = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: currentUserId, email: `${currentUserId}@example.test` } },
      })),
    },
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
    // A distinguishable stand-in for the service-role client, so the assertions
    // below can prove the passport insert and the provider-key RPC do NOT run as
    // the dashboard user.
    serviceDb: { __client: "service-role", rpc, from },
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
vi.mock("@/lib/supabase", () => ({ serviceClient: vi.fn(() => mocks.serviceDb) }));
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
import {
  DEFAULT_CLIENT_MODELS,
  DISCOVERED_MODEL_SUGGESTION_LIMIT,
  preferredClientModel,
  routableDiscoveredModels,
} from "@/lib/agent-connect";
import { LIMITS } from "@/lib/validate";

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
    ["gemini", "AIza-test-not-a-real-key"],
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
    // Gemini's compat base already ends in a version segment, so the listing is
    // `/models`, NOT `/v1/models` — the doubled-version trap.
    ["gemini", "https://generativelanguage.googleapis.com/v1beta/openai/models"],
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
    // Service-role RPC, with the tenant passed explicitly. `p_user_id` is the
    // tenant boundary now that RLS is bypassed, so it must be the verified
    // server-side user id and never anything the caller supplied.
    expect(mocks.rpc).toHaveBeenCalledWith("store_provider_key_for_user", {
      p_user_id: "tenant-a",
      p_provider: "anthropic",
      p_label: "imported",
      p_plaintext: RAW_KEY,
    });
    // The tenant's provider list is cached for 5 minutes to answer "what could
    // this agent fail over to". An import that does not drop it advertises the
    // wrong set for the next five minutes.
    expect(mocks.purgeProviderKeysCache).toHaveBeenCalledWith("tenant-a");
    // The service-role client, NOT `mocks.db`. 0028 revokes INSERT on `agents`
    // from `authenticated`, because a user-scoped insert here is a request an
    // aal1 session can replay over PostgREST with its own passport_pubkey,
    // straight past the MFA gate. The tenant id stays an explicit argument
    // derived from the verified server-side user.
    expect(mocks.createAgent).toHaveBeenCalledWith(
      mocks.serviceDb,
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
  it("stores through store_provider_key_for_user, creates through fleet, and returns the chosen probed scope", async () => {
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

  it("checks the decrypted tenant even when a handoff is found in the caller's namespace", async () => {
    // This isolates the payload check from the separate Redis namespace check.
    // An absent handoff would reject before decrypting and cannot guard this.
    const handoffId = "payload-tenant-mismatch";
    mocks.stash.set(`tenant-a:${handoffId}`, "sealed-foreign-payload");
    mocks.open.mockResolvedValueOnce(JSON.stringify({
      version: 1,
      userId: "tenant-b",
      provider: "anthropic",
      key: RAW_KEY,
      expiresAt: NOW + 60_000,
    }));
    const pending = completeKeyImport({
      handoff: handoffId,
      provider: "anthropic",
      label: "foreign",
      name: "Imported agent",
      passportPubkey: PASSPORT_ID,
      models: ["claude-a"],
    });
    await expect(pending).rejects.toThrow("This key import has expired. Start again.");
    expect(mocks.open).toHaveBeenCalledWith("sealed-foreign-payload");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });

  // Names the gate it actually exercises. It used to claim the DECRYPTED payload's
  // tenant binding, and it never reached it: nothing is stashed under this id, so
  // `takeKeyImport` returns null and the rejection is for absence. The queued
  // `open` value below was never consumed. Deleting `handoff.userId !== user.id`
  // from the action left this test green — the false gate the assertion on `open`
  // now closes. The payload check has its own test above.
  it("rejects a handoff id absent from the caller's namespace, without decrypting anything", async () => {
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

    // The line that distinguishes the two gates: an unknown id must be refused
    // before any ciphertext is opened, so this rejection cannot be evidence
    // about the payload check.
    expect(mocks.open).not.toHaveBeenCalled();
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

describe("the import probe's outbound leg", () => {
  it("refuses to follow a redirect while carrying the pasted key", async () => {
    // This fetch carries the user's key BEFORE it reaches Vault, with the same
    // `authHeaders()` shape the proxy uses — so it has the same `x-api-key`
    // exposure on a cross-origin hop, and needs the same guard.
    const fetchMock = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://attacker.test/collect" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeProviderKey({ provider: "anthropic", key: RAW_KEY });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "manual" })
    );
    // A 3xx is neither a working key nor a model list: degrade to manual, which
    // is what every other unhelpful upstream answer already does.
    expect(result).toMatchObject({ ok: true, mode: "manual", models: [] });
    expect(JSON.stringify(result)).not.toContain(RAW_KEY);
  });
});

/**
 * Discovery describes the key. It does not authorize the agent.
 *
 * The probe used to stop collecting ids at exactly 50, and `LIMITS.models` — the
 * most patterns one scope entry may carry — is also exactly 50. Nothing in the
 * code linked the two numbers, but the onramp pasted the probe's list straight
 * into the grant, so OpenAI's listing filled a scope to the validator's ceiling
 * before the operator had chosen anything. Adding one more legitimate model then
 * failed with "Invalid models in scope." — and the model in question was
 * `gpt-5-mini`, which this project's own integration defaults tell people to
 * call.
 *
 * These tests hold the two numbers apart.
 */
describe("provider model discovery is informational, not a grant", () => {
  function listing(ids: string[]) {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("no longer stops at the scope validator's ceiling", async () => {
    const ids = Array.from({ length: 63 }, (_, i) => `gpt-model-${i}`);
    listing(ids);

    const result = await probeProviderKey({ provider: "openai", key: RAW_KEY });

    if (!result.ok) throw new Error("expected a successful probe");
    // The old code returned exactly 50 here — LIMITS.models — and the operator
    // could not then add a 51st model of their own.
    expect(result.models).toHaveLength(63);
    expect(result.models).not.toHaveLength(LIMITS.models);
    expect(result.modelsTotal).toBe(63);
  });

  it("reports the true total so a truncated list is never shown as complete", async () => {
    const ids = Array.from({ length: 260 }, (_, i) => `gpt-model-${i}`);
    listing(ids);

    const result = await probeProviderKey({ provider: "openai", key: RAW_KEY });

    if (!result.ok) throw new Error("expected a successful probe");
    expect(result.models).toHaveLength(200);
    // The count is the honest one, so the UI can say "showing 200 of 260"
    // instead of implying 200 is everything the key reaches.
    expect(result.modelsTotal).toBe(260);
  });

  it("keeps discovery well clear of what one scope entry may hold", async () => {
    // The relationship that matters, asserted rather than assumed: these are
    // answers to different questions and must not be one number again.
    listing(["gpt-5-mini"]);
    const result = await probeProviderKey({ provider: "openai", key: RAW_KEY });

    if (!result.ok) throw new Error("expected a successful probe");
    expect(result.modelsTotal).toBe(1);
    expect(LIMITS.models).toBe(50);
  });
});

/**
 * What the onramp actually pre-fills.
 *
 * OpenAI's listing leads with `text-embedding-ada-002`, and the old UI took the
 * first usable id as "Model to call" — so the field that decides what is really
 * sent to a chat endpoint defaulted to an embedding model.
 */
describe("the models offered from a provider listing", () => {
  // The exact shape of the openai listing that produced the reported bug.
  const OPENAI_LISTING = [
    "text-embedding-ada-002",
    "whisper-1",
    "gpt-3.5-turbo",
    "tts-1",
    "dall-e-3",
    "omni-moderation-latest",
    "gpt-4.1-nano",
    "gpt-5-mini",
    "gpt-image-1",
  ];

  it("offers only models this gateway's endpoints can actually route", () => {
    const routable = routableDiscoveredModels("openai", OPENAI_LISTING);

    // Embeddings, audio, image and moderation have no route through the
    // endpoint allowlist; granting them authorizes a call that cannot be made.
    expect(routable).not.toContain("text-embedding-ada-002");
    expect(routable).not.toContain("whisper-1");
    expect(routable).not.toContain("tts-1");
    expect(routable).not.toContain("dall-e-3");
    expect(routable).not.toContain("omni-moderation-latest");
    expect(routable).toContain("gpt-5-mini");
    expect(routable).toContain("gpt-4.1-nano");
  });

  it("prefers our own documented model over whatever the provider listed first", () => {
    // Not `text-embedding-ada-002`, which is what `find(clientModelIsUsable)`
    // returned for this exact listing.
    expect(preferredClientModel("openai", OPENAI_LISTING)).toBe("gpt-5-mini");
  });

  it("falls back to a routable discovered model when ours is not on the key", () => {
    expect(preferredClientModel("openai", ["whisper-1", "gpt-4.1-nano"])).toBe("gpt-4.1-nano");
  });

  it("falls back to the documented default when nothing discovered is routable", () => {
    // NOT `whisper-1`. The picker widens to the whole listing rather than show
    // nothing; the one model actually sent to the provider does not, because
    // widening it is the original bug.
    expect(preferredClientModel("openai", ["whisper-1", "tts-1"])).toBe(
      DEFAULT_CLIENT_MODELS.openai
    );
    expect(routableDiscoveredModels("openai", ["whisper-1", "tts-1"])).toEqual([
      "whisper-1",
      "tts-1",
    ]);
  });

  it("never hands back more than one scope entry may hold", () => {
    // The pre-fill is one model and the suggestions are capped, so no discovery
    // result can walk an operator into "Invalid models in scope."
    const many = Array.from({ length: 300 }, (_, i) => `gpt-${i}`);
    expect(DISCOVERED_MODEL_SUGGESTION_LIMIT).toBeLessThan(LIMITS.models);
    expect(routableDiscoveredModels("openai", many).slice(0, DISCOVERED_MODEL_SUGGESTION_LIMIT))
      .toHaveLength(DISCOVERED_MODEL_SUGGESTION_LIMIT);
  });

  it("leaves every other provider's listing on the same rule", () => {
    // Driven off each provider's own default pattern, not a hand-kept table.
    expect(routableDiscoveredModels("anthropic", ["claude-haiku-4-5", "whisper-1"])).toEqual([
      "claude-haiku-4-5",
    ]);
    expect(routableDiscoveredModels("groq", ["llama-3.3-70b-versatile", "whisper-large-v3"])).toEqual([
      "llama-3.3-70b-versatile",
    ]);
  });

  /**
   * The default pattern describes what we DOCUMENT, not what a provider serves.
   * Measured: `gemini-*` matches none of Google's OpenAI-compat listing, which
   * spells its ids `models/gemini-2.5-flash`. Filtering on it left the picker
   * EMPTY on a key that reaches real models — a worse failure than showing a few
   * the gateway cannot route.
   */
  it("never returns an empty picker for a key that found models", () => {
    const listings: Array<[ProviderId, string[]]> = [
      ["openai", ["text-embedding-ada-002", "whisper-1", "gpt-5-mini"]],
      ["anthropic", ["claude-haiku-4-5", "claude-sonnet-4-5"]],
      ["groq", ["llama-3.3-70b-versatile", "whisper-large-v3"]],
      ["mistral", ["mistral-small-latest", "codestral-latest"]],
      ["together", ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo"]],
      ["deepseek", ["deepseek-chat", "deepseek-reasoner"]],
      ["gemini", ["models/gemini-2.5-flash", "models/gemini-2.5-pro"]],
    ];
    for (const [provider, listing] of listings) {
      expect(routableDiscoveredModels(provider, listing).length).toBeGreaterThan(0);
    }
  });

  it("hands back the whole listing when the default pattern matches none of it", () => {
    // gemini's real compat listing. The pattern is what was wrong, not the key.
    const listing = ["models/gemini-2.5-flash", "models/gemini-2.5-pro"];
    expect(routableDiscoveredModels("gemini", listing)).toEqual(listing);
  });

  it("still filters where the pattern genuinely describes the listing", () => {
    // The fallback must not become a way of never filtering at all: OpenAI is
    // where the filter earns its place.
    expect(
      routableDiscoveredModels("openai", ["whisper-1", "tts-1", "gpt-5-mini"])
    ).toEqual(["gpt-5-mini"]);
  });
});
