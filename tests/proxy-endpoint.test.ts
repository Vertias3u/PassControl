import { beforeEach, describe, expect, it, vi } from "vitest";

import { PROVIDERS, usesOpenAiUsageShape } from "@/lib/providers";

const {
  verifyVisaMock,
  serviceClientMock,
  reserveBudgetMock,
  reconcileBudgetMock,
  getCachedKeyMock,
  setCachedKeyMock,
  getCachedAgentPolicyMock,
  setCachedAgentPolicyMock,
  readKillStateMock,
  isSuspendedMock,
  writeLogMock,
  mirrorSpendMock,
  rateLimitMock,
  fetchMock,
} = vi.hoisted(() => {
  return {
    verifyVisaMock: vi.fn(),
    serviceClientMock: vi.fn(),
    reserveBudgetMock: vi.fn(),
    reconcileBudgetMock: vi.fn(),
    getCachedKeyMock: vi.fn(),
    setCachedKeyMock: vi.fn(),
    getCachedAgentPolicyMock: vi.fn(),
    setCachedAgentPolicyMock: vi.fn(),
    readKillStateMock: vi.fn(),
    isSuspendedMock: vi.fn(),
    writeLogMock: vi.fn(),
    mirrorSpendMock: vi.fn(),
    rateLimitMock: vi.fn(),
    fetchMock: vi.fn(),
  };
});

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/auth/visa", () => ({
  extractVisaToken: (headers: Headers) => headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
  verifyVisa: (...args: unknown[]) => verifyVisaMock(...args),
}));
vi.mock("@/lib/state/killswitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/killswitch")>();
  return {
    ...actual,
    readKillState: (...args: unknown[]) => readKillStateMock(...args),
  };
});
vi.mock("@/lib/state/redis", () => ({
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  reserveBudget: (...args: unknown[]) => reserveBudgetMock(...args),
  reconcileBudget: (...args: unknown[]) => reconcileBudgetMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
  setCachedKey: (...args: unknown[]) => setCachedKeyMock(...args),
  getCachedAgentPolicy: (...args: unknown[]) => getCachedAgentPolicyMock(...args),
  setCachedAgentPolicy: (...args: unknown[]) => setCachedAgentPolicyMock(...args),
  seedSpent: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: async () => "sealed", open: async (v: string) => v }));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...args: unknown[]) => rateLimitMock(...args) }));

import { POST, GET } from "@/app/api/v1/[provider]/[...path]/route";

const baseClaims = {
  sub: "passport-id",
  agid: "agent-id",
  uid: "user-id",
  jti: "jti-1",
  bt: null,
  bc: null,
  st: 0,
  sc: 0,
  ver: 1,
};

function req(body: unknown) {
  return new Request("https://gateway.test/api/v1/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callProxy(provider: string, path: string[], model: string) {
  verifyVisaMock.mockResolvedValue({
    ...baseClaims,
    scope: [{ provider, models: [model] }],
  });
  return POST(req({ model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }), {
    params: Promise.resolve({ provider, path }),
  });
}

// A GET with no body/model (e.g. /v1/models). Scope is [] on purpose — the model
// listing endpoint must NOT depend on the per-model scope.
function getReq() {
  return new Request("https://gateway.test/api/v1/openai/v1/models", {
    method: "GET",
    headers: { authorization: "Bearer visa" },
  });
}
async function getProxy(provider: string, path: string[]) {
  verifyVisaMock.mockResolvedValue({ ...baseClaims, scope: [{ provider, models: ["nothing-*"] }] });
  return GET(getReq(), { params: Promise.resolve({ provider, path }) });
}

beforeEach(() => {
  verifyVisaMock.mockReset();
  serviceClientMock.mockReset();
  reserveBudgetMock.mockReset();
  reconcileBudgetMock.mockReset();
  getCachedKeyMock.mockReset();
  setCachedKeyMock.mockReset();
  getCachedAgentPolicyMock.mockReset();
  setCachedAgentPolicyMock.mockReset();
  readKillStateMock.mockReset();
  isSuspendedMock.mockReset();
  writeLogMock.mockReset();
  mirrorSpendMock.mockReset();
  rateLimitMock.mockReset();
  fetchMock.mockReset();

  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
  });
  reserveBudgetMock.mockResolvedValue({ ok: true, reserved: 1 });
  reconcileBudgetMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue(null);
  setCachedKeyMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null }));
  setCachedAgentPolicyMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, tenantKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});

describe("proxy endpoint allowlist", () => {
  it("blocks an OpenAI chat-scoped visa from /v1/files", async () => {
    const res = await callProxy("openai", ["v1", "files"], "gpt-4o-mini");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_endpoint" });
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked_endpoint" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reserveBudgetMock).not.toHaveBeenCalled();
  });

  it("blocks an Anthropic chat-scoped visa from a non-messages endpoint", async () => {
    const res = await callProxy("anthropic", ["v1", "complete"], "claude-haiku-4-5");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_endpoint" });
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked_endpoint" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reserveBudgetMock).not.toHaveBeenCalled();
  });

  it("allows the OpenAI chat-completions endpoint", async () => {
    const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("allows the Anthropic messages endpoint", async () => {
    const res = await callProxy("anthropic", ["v1", "messages"], "claude-haiku-4-5");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({ method: "POST" })
    );
  });

  it.each([
    ["groq", ["v1", "chat", "completions"], "llama-3.3-70b-versatile", "https://api.groq.com/openai/v1/chat/completions"],
    ["mistral", ["v1", "chat", "completions"], "mistral-small-latest", "https://api.mistral.ai/v1/chat/completions"],
    ["together", ["v1", "chat", "completions"], "openai/gpt-oss-20b", "https://api.together.ai/v1/chat/completions"],
    ["deepseek", ["chat", "completions"], "deepseek-v4-flash", "https://api.deepseek.com/chat/completions"],
  ])("allows %s chat on its fixed upstream host", async (provider, path, model, upstream) => {
    const res = await callProxy(provider, path, model);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(upstream, expect.objectContaining({ method: "POST" }));
  });

  // Real clients disagree about where "/v1" lives. An SDK configured with
  // baseURL=".../api/v1/openai" appends "chat/completions"; a desktop GUI that
  // asks for a host instead appends the whole "v1/chat/completions". Both are
  // the same call, so every OpenAI-shape provider must accept both — deepseek
  // accepted only the first, so pointing a GUI at it returned blocked_endpoint.
  //
  // Driven off usesOpenAiUsageShape rather than a typed list: a provider added
  // later is covered here the day it is added, without anyone remembering to.
  // Deepseek's own upstream has no /v1, so the invariant is NOT "both end at
  // /v1/chat/completions" — it is "both client shapes reach the SAME upstream".
  // That is what the allowlist's upstreamPath indirection exists to do.
  it.each(PROVIDERS.filter(usesOpenAiUsageShape))(
    "accepts %s chat whichever side of the base URL /v1 lands on",
    async (provider) => {
      const bare = await callProxy(provider, ["chat", "completions"], "test-model");
      const bareUrl = fetchMock.mock.calls.at(-1)?.[0];
      const prefixed = await callProxy(provider, ["v1", "chat", "completions"], "test-model");
      const prefixedUrl = fetchMock.mock.calls.at(-1)?.[0];

      expect(bare.status).toBe(200);
      expect(prefixed.status).toBe(200);
      expect(prefixedUrl).toBe(bareUrl);
    }
  );

  it.each(["groq", "mistral", "together", "deepseek"])(
    "blocks %s from non-allowlisted file endpoints",
    async (provider) => {
      const res = await callProxy(provider, ["v1", "files"], "gpt-oss-20b");

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "blocked_endpoint" });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  // ── Hardening: bypass attempts + method-aware model listing ──────────────────

  it("blocks a suffix-appended chat path (exact match, not prefix)", async () => {
    // /v1/chat/completions/x must NOT be treated as the allowed chat endpoint.
    const res = await callProxy("openai", ["v1", "chat", "completions", "x"], "gpt-4o-mini");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_endpoint" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks a path-traversal bypass toward another endpoint", async () => {
    // /v1/chat/completions/../files is rejected by the traversal guard (400)
    // before it can be reshaped — it never reaches upstream either way.
    const res = await callProxy("openai", ["v1", "chat", "completions", "..", "files"], "gpt-4o-mini");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_path" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows GET /v1/models without a per-model scope match", async () => {
    // Scope is deliberately unrelated ("nothing-*"); the model-listing endpoint
    // must be reachable anyway (it carries no model), gated only by GET allowlist.
    const res = await getProxy("openai", ["v1", "models"]);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("blocks POST to /v1/models (models is GET-only)", async () => {
    const res = await callProxy("openai", ["v1", "models"], "gpt-4o-mini");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_endpoint" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── Retrieving one model's metadata ────────────────────────────────────────
  //
  // `GET /v1/models/{id}` is what an agent's "detect context length" probe calls.
  // It used to miss the exact-length listing rule and come back blocked_endpoint
  // around every prompt. Proven here through the real handler, not just the
  // matcher, because the scope step is the part that could still refuse it: the
  // visa's scope below is deliberately "nothing-*".
  it("allows GET /v1/models/{id} without a per-model scope match", async () => {
    const res = await getProxy("openai", ["v1", "models", "gpt-4.1"]);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models/gpt-4.1",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("forwards the retrieve for anthropic, the shape that surfaced this", async () => {
    const res = await getProxy("anthropic", ["v1", "models", "claude-haiku-4-5-20251001"]);

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models/claude-haiku-4-5-20251001",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("refuses to let the model segment escape into another endpoint", async () => {
    // The one real risk in admitting a parameterised path: the segment is joined
    // into the upstream URL, so it must never be able to reach /v1/fine_tuning.
    // Two independent guards refuse it and the OUTER one wins — the route's
    // traversal check runs before the allowlist, so this is 400 invalid_path,
    // not 403. The matcher refuses it too (tests/scope-glob.test.ts), which is
    // what keeps this safe if the order ever changes.
    const res = await getProxy("openai", ["v1", "models", ".."]);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_path" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a deeper path under models", async () => {
    const res = await getProxy("openai", ["v1", "models", "a", "b"]);

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks POST to /v1/models/{id} — retrieve stays read-only", async () => {
    const res = await callProxy("openai", ["v1", "models", "gpt-4.1"], "gpt-4o-mini");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_endpoint" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ── Discovery is bounded by the visa ─────────────────────────────────────────
describe("model listing is narrowed to the visa's scope", () => {
  const upstreamList = () =>
    new Response(
      JSON.stringify({
        object: "list",
        data: [{ id: "gpt-4.1" }, { id: "gpt-3.5-turbo" }, { id: "dall-e-3" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  async function listWithScope(models: string[]) {
    fetchMock.mockResolvedValue(upstreamList());
    verifyVisaMock.mockResolvedValue({ ...baseClaims, scope: [{ provider: "openai", models }] });
    const res = await GET(getReq(), {
      params: Promise.resolve({ provider: "openai", path: ["v1", "models"] }),
    });
    return { res, body: (await res.json()) as any };
  }

  it("returns only the models this visa may actually call", async () => {
    // The provider key reaches the tenant's whole account; the visa is one
    // agent's capability. Before this, the picker offered all three.
    const { res, body } = await listWithScope(["gpt-4*"]);

    expect(res.status).toBe(200);
    expect(body.data.map((m: any) => m.id)).toEqual(["gpt-4.1"]);
    // Still the provider's own row, untouched.
    expect(body.data[0]).toEqual({ id: "gpt-4.1" });
    expect(body.object).toBe("list");
  });

  it("still forwards upstream — this narrows a real answer, it does not invent one", async () => {
    await listWithScope(["gpt-4*"]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("returns an empty list when the visa permits none of them", async () => {
    const { res, body } = await listWithScope(["nothing-*"]);

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
  });

  it("leaves the single-model retrieve unnarrowed", async () => {
    // Discovery is scoped; an explicit lookup is not. The caller already knows
    // the name, so hiding it would only replace an answer with a confusion —
    // and the gate still refuses to CALL it.
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "dall-e-3", object: "model" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    verifyVisaMock.mockResolvedValue({
      ...baseClaims,
      scope: [{ provider: "openai", models: ["nothing-*"] }],
    });
    const res = await GET(getReq(), {
      params: Promise.resolve({ provider: "openai", path: ["v1", "models", "dall-e-3"] }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "dall-e-3", object: "model" });
  });

  it("does not narrow a chat completion response", async () => {
    // The filter keys on `data`, and a chat response has none — but this pins it
    // rather than trusting that, because silently reshaping an inference
    // response would be the worst possible bug in this file.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          choices: [{ message: { content: "hi" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.choices[0].message.content).toBe("hi");
  });
});
