// Local models (1.2.0): the dashboard actions behind "Use Ollama" and the agent
// wizard's model suggestions.
//
// "Use Ollama" stores a `local` credential with no key and Ollama's address, in
// one click, and only after Ollama has answered: a credential pointing at a
// server that is not running would make every agent call fail with a gateway
// error that does not say why. Both actions answer to the operator gate, so on
// hosted Cloud (gate off) neither sends anything nor stores anything.
import { beforeEach, describe, expect, it, vi } from "vitest";

const NEW_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => {
  const updates: { table: string; values: Record<string, unknown>; filters: [string, unknown][] }[] = [];
  const localRows: { value: Record<string, unknown>[] } = { value: [] };
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
      order: () => chain,
      limit: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return chain;
      },
      maybeSingle: async () => ({ data: localRows.value[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => void) => {
        if (values) {
          updates.push({ table, values, filters: [...filters] });
          resolve({ error: null });
        } else {
          resolve({ data: localRows.value, error: null });
        }
      },
    };
    return chain;
  });
  const db = {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "tenant-a", email: "a@example.test" } } })) },
    from,
  };
  return { rpc, from, db, updates, localRows, serviceDb: { rpc, from }, fetch: vi.fn() };
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
  purgeAgentCaches: vi.fn(async () => true),
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

import { addProviderKey, connectOllama, listLocalModelsForAgents } from "@/app/dashboard/actions-client";
import { LOCAL_NO_KEY } from "@/lib/providers";

const OLLAMA = "http://localhost:11434/v1";
const listing = (ids: string[]) =>
  new Response(JSON.stringify({ object: "list", data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const stored = () => mocks.rpc.mock.calls.filter(([name]) => name === "store_provider_key_for_user");
const endpointWrites = () => mocks.updates.filter((u) => "endpoint_base_url" in u.values);

beforeEach(() => {
  mocks.rpc.mockClear();
  mocks.from.mockClear();
  mocks.updates.length = 0;
  mocks.localRows.value = [];
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
  delete process.env.PROVIDER_ENDPOINT_MODE;
});

describe("Use Ollama", () => {
  it("is refused where the operator gate is off, without asking Ollama or storing anything", async () => {
    await expect(connectOllama()).rejects.toThrow(/not enabled on this deployment/);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(0);
  });

  it("stores nothing when Ollama is not answering, and says how to start it", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    mocks.fetch.mockRejectedValue(new TypeError("fetch failed"));
    await expect(connectOllama()).rejects.toThrow(/Ollama is not answering/);
    expect(stored()).toHaveLength(0);
  });

  it("stores a keyless local credential at Ollama's address and returns its models", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    mocks.fetch.mockResolvedValue(listing(["qwen2.5:0.5b"]));
    const result = await connectOllama();

    expect(result).toEqual({ models: ["qwen2.5:0.5b"], alreadyConnected: false });
    expect(stored()).toHaveLength(1);
    expect(stored()[0]![1]).toEqual(
      expect.objectContaining({ p_user_id: "tenant-a", p_provider: "local", p_label: "ollama", p_plaintext: LOCAL_NO_KEY })
    );
    expect(endpointWrites()).toHaveLength(1);
    expect(endpointWrites()[0]!.values).toEqual({ endpoint_base_url: OLLAMA });
    expect(endpointWrites()[0]!.filters).toEqual(expect.arrayContaining([["user_id", "tenant-a"], ["id", NEW_ID]]));
  });

  it("does not store a second credential when one already points at Ollama", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    mocks.localRows.value = [{ id: "c1", endpoint_base_url: OLLAMA, is_active: true }];
    mocks.fetch.mockResolvedValue(listing(["qwen2.5:0.5b", "llama3.2:latest"]));
    const result = await connectOllama();

    expect(result).toEqual({ models: ["qwen2.5:0.5b", "llama3.2:latest"], alreadyConnected: true });
    expect(stored()).toHaveLength(0);
  });
});

describe("the agent wizard's local model suggestions", () => {
  it("are empty where the gate is off, and nothing is sent", async () => {
    mocks.localRows.value = [{ id: "c1", endpoint_base_url: OLLAMA, is_active: true }];
    expect(await listLocalModelsForAgents()).toEqual({ state: "disabled", models: [] });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("are empty when there is no local credential", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    expect(await listLocalModelsForAgents()).toEqual({ state: "none", models: [] });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("come from the selected local credential's server", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    mocks.localRows.value = [{ id: "c1", endpoint_base_url: "http://localhost:1234/v1", is_active: true }];
    mocks.fetch.mockResolvedValue(listing(["lmstudio-model"]));
    expect(await listLocalModelsForAgents()).toEqual({ state: "ok", models: ["lmstudio-model"] });
    expect(String(mocks.fetch.mock.calls[0]![0])).toBe("http://localhost:1234/v1/models");
  });
});

describe("adding a local credential by hand", () => {
  it("needs its server's address, and says so in local terms", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    await expect(addProviderKey({ provider: "local", label: "lm", key: "" })).rejects.toThrow(
      /needs its server's address/
    );
    expect(stored()).toHaveLength(0);
  });

  it("is refused where the gate is off, naming the setting", async () => {
    await expect(addProviderKey({ provider: "local", label: "lm", key: "", endpoint: OLLAMA })).rejects.toThrow(
      /PROVIDER_ENDPOINT_MODE/
    );
    expect(stored()).toHaveLength(0);
  });
});
