// Package 2, step 5: where an Azure key is STORED, which decides where it is sent.
//
// The proxy refuses an Azure key with no usable address (tests/proxy-azure.test.ts),
// but that is the second line. These actions are the first: an Azure key is stored
// only together with a Microsoft-owned resource address, the address is written to
// the row the store RPC created (by id), the key-import on-ramp — which has no
// address to give — refuses Azure before anything is stored or probed, and an
// Azure key's address can be changed but never cleared.
import { beforeEach, describe, expect, it, vi } from "vitest";

const RESOURCE = "https://contoso-ai.openai.azure.com/openai/v1";
const NEW_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => {
  const updates: { table: string; values: Record<string, unknown>; filters: [string, unknown][] }[] = [];
  const credentialProvider = { value: "azure" };
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: NEW_ID, error: null }));
  const from = vi.fn((table: string) => {
    const filters: [string, unknown][] = [];
    let values: Record<string, unknown> | null = null;
    const chain: Record<string, unknown> = {
      update: (v: Record<string, unknown>) => {
        values = v;
        return chain;
      },
      select: () => chain,
      limit: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return chain;
      },
      maybeSingle: async () => ({ data: { provider: credentialProvider.value }, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (values) updates.push({ table, values, filters: [...filters] });
        resolve(table === "agents" ? { data: [{ id: "agent-1" }], error: null } : { error: null });
      },
    };
    return chain;
  });
  const db = {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "tenant-a", email: "a@example.test" } } })) },
    from,
  };
  return {
    rpc,
    from,
    db,
    updates,
    credentialProvider,
    serviceDb: { rpc, from },
    purgeAgentCaches: vi.fn(async () => true),
    fetch: vi.fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => mocks.db }));
vi.mock("@/lib/supabase", () => ({ serviceClient: vi.fn(() => mocks.serviceDb) }));
vi.mock("@/lib/mfa", () => ({
  mfaAuthorizedUser: vi.fn(async () => ({ ok: true, user: { id: "tenant-a" } })),
}));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: vi.fn(async () => ({ success: true, remaining: 4 })),
  rateLimitFailClosed: vi.fn(async () => ({ success: true, remaining: 4 })),
}));
vi.mock("@/lib/state/redis", () => ({
  purgeAgentCaches: mocks.purgeAgentCaches,
  purgeAgentFallbacks: vi.fn(async () => undefined),
  purgeProviderKeysCache: vi.fn(async () => undefined),
  readSuspensionFlag: vi.fn(),
  stashKeyImport: vi.fn(),
  takeKeyImport: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ recordAdminAction: vi.fn(async () => undefined) }));
vi.mock("@/lib/seclog", () => ({ logSecurityEvent: vi.fn() }));
vi.mock("@/lib/alert", () => ({ dispatchSecurityAlert: vi.fn() }));
vi.mock("@/lib/apikeys", () => ({ generateApiKey: vi.fn() }));

import { addProviderKey, probeProviderKey, setProviderEndpoint } from "@/app/dashboard/actions";

beforeEach(() => {
  mocks.rpc.mockClear();
  mocks.from.mockClear();
  mocks.purgeAgentCaches.mockClear();
  mocks.updates.length = 0;
  mocks.credentialProvider.value = "azure";
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
  delete process.env.PROVIDER_ENDPOINT_MODE;
});

const endpointWrites = () => mocks.updates.filter((u) => "endpoint_base_url" in u.values);

describe("adding an Azure key", () => {
  it("stores the key and then its address on the row the RPC created", async () => {
    await addProviderKey({ provider: "azure", label: "prod", key: "az-key-material-0123456789", endpoint: RESOURCE });

    expect(mocks.rpc).toHaveBeenCalledWith("store_provider_key_for_user", expect.objectContaining({ p_provider: "azure" }));
    const writes = endpointWrites();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.values).toEqual({ endpoint_base_url: RESOURCE });
    // By id AND tenant, never "the newest Azure row".
    expect(writes[0]!.filters).toEqual(expect.arrayContaining([["id", NEW_ID], ["user_id", "tenant-a"]]));
    // A call in the gap cached "no address"; that is cleared.
    expect(mocks.purgeAgentCaches).toHaveBeenCalledWith("agent-1", ["azure"]);
  });

  it("works with custom endpoints OFF, as on hosted Cloud", async () => {
    await addProviderKey({ provider: "azure", label: "prod", key: "az-key-material-0123456789", endpoint: RESOURCE });
    expect(endpointWrites()).toHaveLength(1);
  });

  it.each([
    ["no address", undefined],
    ["an empty address", ""],
    ["a non-Azure host", "https://api.openai.com/v1"],
    ["a private server", "http://10.1.2.3:8000/v1"],
  ])("refuses %s before anything is stored", async (_label, endpoint) => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    await expect(
      addProviderKey({ provider: "azure", label: "prod", key: "az-key-material-0123456789", endpoint })
    ).rejects.toThrow(/Azure key needs its resource's v1 address/);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("names the exact address when given the portal's bare endpoint", async () => {
    await expect(
      addProviderKey({
        provider: "azure",
        label: "prod",
        key: "az-key-material-0123456789",
        endpoint: "https://contoso-ai.openai.azure.com/",
      })
    ).rejects.toThrow(`Use ${RESOURCE}.`);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("leaves every other provider's add exactly as it was: no address written", async () => {
    await addProviderKey({ provider: "openai", label: "prod", key: "sk-proj-0123456789abcdef", endpoint: RESOURCE });
    expect(mocks.rpc).toHaveBeenCalled();
    expect(endpointWrites()).toHaveLength(0);
  });
});

describe("the key-import on-ramp", () => {
  it("refuses Azure before probing anything: it has no address to probe", async () => {
    const result = await probeProviderKey({ provider: "azure", key: "az-key-material-0123456789" });
    expect(result).toMatchObject({ ok: false, error: "endpoint_required" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe("changing an Azure key's address", () => {
  it("accepts another resource, with custom endpoints off", async () => {
    await setProviderEndpoint({ credentialId: NEW_ID, endpoint: "https://fabrikam.services.ai.azure.com/openai/v1" });
    expect(endpointWrites()[0]!.values).toEqual({
      endpoint_base_url: "https://fabrikam.services.ai.azure.com/openai/v1",
    });
  });

  it("cannot clear it: an Azure key has no provider host to return to", async () => {
    await expect(setProviderEndpoint({ credentialId: NEW_ID, endpoint: "" })).rejects.toThrow(/resource's v1 address/);
    expect(endpointWrites()).toHaveLength(0);
  });

  it("cannot point it at a non-Azure host, even where self-host allows any address", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    await expect(
      setProviderEndpoint({ credentialId: NEW_ID, endpoint: "http://10.1.2.3:8000/v1" })
    ).rejects.toThrow(/resource's v1 address/);
    expect(endpointWrites()).toHaveLength(0);
  });

  it("does not let an Azure address onto another provider's key while the gate is off", async () => {
    mocks.credentialProvider.value = "openai";
    await expect(setProviderEndpoint({ credentialId: NEW_ID, endpoint: RESOURCE })).rejects.toThrow(
      /Custom endpoints are not enabled/
    );
  });
});
