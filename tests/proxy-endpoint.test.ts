import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const establishBudgetStateMock = vi.fn();

import { PROVIDERS, usesOpenAiUsageShape } from "@/lib/providers";

const {
  verifyVisaMock,
  serviceClientMock,
  openHoldMock,
  settleHoldMock,
  getCachedKeyMock,
  getCachedEndpointMock,
  setCachedEndpointMock,
  setCachedKeyMock,
  getCachedAgentPolicyMock,
  setCachedAgentPolicyMock,
  readKillStateMock,
  isSuspendedMock,
  writeLogMock,
  mirrorSpendMock,
  rateLimitMock,
  readCredentialFenceMock,
  fetchMock,
} = vi.hoisted(() => {
  return {
    verifyVisaMock: vi.fn(),
    serviceClientMock: vi.fn(),
    openHoldMock: vi.fn(),
    settleHoldMock: vi.fn(),
    getCachedKeyMock: vi.fn(),
    getCachedEndpointMock: vi.fn(),
    setCachedEndpointMock: vi.fn(),
    setCachedKeyMock: vi.fn(),
    getCachedAgentPolicyMock: vi.fn(),
    setCachedAgentPolicyMock: vi.fn(),
    readKillStateMock: vi.fn(),
    isSuspendedMock: vi.fn(),
    writeLogMock: vi.fn(),
    mirrorSpendMock: vi.fn(),
    rateLimitMock: vi.fn(),
    readCredentialFenceMock: vi.fn(),
    fetchMock: vi.fn(),
  };
});

// The proxy now reaches lib/demo/identity.ts to tell the seeded PUBLIC demo
// passport apart from a tenant that holds a demo scope. That module is
// `server-only`, which Next enforces at build time and vitest cannot resolve
// at all — same stub tests/site-demo-routes.test.ts already uses.
// The Cloud allowance resolver sits on the enforcement path and fails CLOSED, so
// an unmocked one refuses every request here with a 503 instead of exercising
// what this file is about.
vi.mock("server-only", () => ({}));
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
  purgeAgentPolicy: vi.fn(),
  // The proxy reads this before the endpoint row and again before dispatch.
  // Omitted, it is undefined, the call throws, and the route 500s.
  //
  // Controllable per call, because the SECOND read is a decision point: equal
  // means dispatch, different means the operator rotated, and UNREADABLE means
  // neither has been established (T4-04).
  readCredentialFence: (...args: unknown[]) => readCredentialFenceMock(...args),
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
  getCachedEndpoint: (...args: unknown[]) => getCachedEndpointMock(...args),
  setCachedEndpoint: (...args: unknown[]) => setCachedEndpointMock(...args),
  setCachedKey: (...args: unknown[]) => setCachedKeyMock(...args),
  getCachedAgentPolicy: (...args: unknown[]) => getCachedAgentPolicyMock(...args),
  setCachedAgentPolicy: (...args: unknown[]) => setCachedAgentPolicyMock(...args),
  // Mocked explicitly. Left out it is undefined, the call throws, policy.ts
  // catches it, and the fence silently becomes null in every assertion below.
  readPolicyFence: async () => null,
}));
/**
 * The attempt-lifecycle boundary, mocked as a MODULE rather than re-implemented.
 *
 * tests/reserve-id.test.ts used to hand-copy the reserve Lua into TypeScript and
 * the copy drifted — it collapsed the -1/-2 return codes, so one whole branch of
 * the money boundary was covered by a test that could not fail on it. Mocking
 * the boundary removes that hazard: what the real scripts DO is Tier A's job
 * (tests/holds.redis.test.ts, real Lua on real Redis); what this file asserts is
 * WHICH transition the route chooses and with WHAT arguments.
 *
 * The three settle entry points funnel into one spy carrying an `outcome` tag,
 * because the choice between them IS the behaviour under test.
 */
vi.mock("@/lib/state/holds", () => {
  const settle = async (outcome: string, p: Record<string, unknown>) => {
    const r = await settleHoldMock({ ...p, outcome });
    // A test that does not care about the applied figures gets a realistic
    // settlement rather than `undefined`, which the route would then read
    // fields off. Tests that DO care override the return.
    return (
      r ?? {
        applied: true,
        appliedTokens: Number(p.tokens ?? 0),
        appliedMicrocents: Number(p.microcents ?? 0),
      }
    );
  };
  return {
    openHold: (...args: unknown[]) => openHoldMock(...args),
    // Always granted here: these suites assert what the proxy does AROUND the
    // dispatch boundary, not the boundary itself (tests/proxy-dispatch-permission.test.ts).
    consumeDispatchPermission: async () => ({ granted: true }),
    settleKnown: (p: Record<string, unknown>) => settle("complete", p),
    settleUnknown: (p: Record<string, unknown>) => settle("usage_unknown", p),
    releaseUndispatched: (p: Record<string, unknown>) => settle("not_dispatched", p),
    establishBudgetState: (...args: unknown[]) => establishBudgetStateMock(...args),
  };
});
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
  openHoldMock.mockReset();
  settleHoldMock.mockReset();
  getCachedKeyMock.mockReset();
  getCachedEndpointMock.mockReset();
  setCachedEndpointMock.mockReset();
  setCachedKeyMock.mockReset();
  getCachedAgentPolicyMock.mockReset();
  setCachedAgentPolicyMock.mockReset();
  readKillStateMock.mockReset();
  isSuspendedMock.mockReset();
  writeLogMock.mockReset();
  mirrorSpendMock.mockReset();
  rateLimitMock.mockReset();
  readCredentialFenceMock.mockReset();
  readCredentialFenceMock.mockResolvedValue(null);
  fetchMock.mockReset();

  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
  });
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1 });
  settleHoldMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue(null);
  getCachedEndpointMock.mockResolvedValue(null);
  setCachedEndpointMock.mockResolvedValue(undefined);
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
    expect(openHoldMock).not.toHaveBeenCalled();
  });

  it("blocks an Anthropic chat-scoped visa from a non-messages endpoint", async () => {
    const res = await callProxy("anthropic", ["v1", "complete"], "claude-haiku-4-5");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_endpoint" });
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked_endpoint" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openHoldMock).not.toHaveBeenCalled();
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

  it("settles a usage-free model listing at known zero", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ object: "list", data: [{ id: "gpt-4.1" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const res = await getProxy("openai", ["v1", "models"]);

    expect(res.status).toBe(200);
    expect(settleHoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "complete", tokens: 0 })
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

/**
 * Where the credential actually goes. The gate is OFF by default, so the first
 * test here is the one that matters most: a stored endpoint changes nothing
 * until an operator opts the deployment in.
 */
describe("custom provider endpoints", () => {
  afterEach(() => {
    delete process.env.PROVIDER_ENDPOINT_MODE;
  });

  const target = () => String(fetchMock.mock.calls.at(-1)?.[0]);

  it("ignores a stored endpoint entirely while the gate is off", async () => {
    getCachedEndpointMock.mockResolvedValue("cccccccc-cccc-4ccc-8ccc-cccccccccccc|http://10.1.2.3:8000/v1");
    const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    expect(res.status).toBe(200);
    expect(target()).toBe("https://api.openai.com/v1/chat/completions");
    // Not merely disabled — the feature is absent, so it costs no read at all.
    expect(getCachedEndpointMock).not.toHaveBeenCalled();
  });

  it("sends the call to a self-hosted endpoint, base path and all", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue("cccccccc-cccc-4ccc-8ccc-cccccccccccc|http://10.1.2.3:8000/openai/v1");
    const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    expect(res.status).toBe(200);
    // The operator's `/openai/v1` survives — `new URL` would have eaten it — and
    // it is NOT followed by a second `v1`. A custom base owns its own version
    // segment, exactly as every OpenAI-shaped SDK's `base_url` does.
    expect(target()).toBe("http://10.1.2.3:8000/openai/v1/chat/completions");
  });

  // Re-validated on read, not trusted from the row. An operator who narrows the
  // gate must not keep serving endpoints that were legal when they were stored.
  it("falls back to the built-in host when the stored value is no longer admitted", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "gateway.company.com";
    getCachedEndpointMock.mockResolvedValue("cccccccc-cccc-4ccc-8ccc-cccccccccccc|http://10.1.2.3:8000/v1");
    const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    expect(res.status).toBe(200);
    expect(target()).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("still speaks the credential's own protocol, not the endpoint's", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue("cccccccc-cccc-4ccc-8ccc-cccccccccccc|http://10.1.2.3:8000/v1");
    await callProxy("anthropic", ["v1", "messages"], "claude-3-5-haiku-20241022");

    // The endpoint moves; the wire format does not. An Anthropic credential
    // pointed at a local server still sends Anthropic's headers.
    const init = fetchMock.mock.calls.at(-1)?.[1] as { headers: Headers };
    expect(init.headers.get("x-api-key")).toBe("provider-key");
    expect(init.headers.get("authorization")).toBeNull();
  });

  it("logs the call as unpriced when it did not go to the provider's own host", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue("cccccccc-cccc-4ccc-8ccc-cccccccccccc|http://10.1.2.3:8000/v1");
    await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalled());
    const logged = writeLogMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // Tokens are real and still counted; the money is UNKNOWN, and null is how
    // this column has always said that. A zero here is a claim that the call was
    // free, which is a different statement and one nobody can stand behind for a
    // proxy that may mark up, re-route or alias.
    expect(logged.costMicrocents).toBeNull();
    expect(Number(logged.inputTokens) + Number(logged.outputTokens)).toBeGreaterThan(0);
  });

  /**
   * S3-03, AND A DELIBERATE BEHAVIOUR CHANGE — see TEAMSHARE and
   * plans/updates-pending.md. A cost cap on a custom endpoint used to be
   * enforced with the BUILT-IN PROVIDER'S RETAIL PRICE: `attemptWithHold`
   * computes its estimate before the endpoint is resolved, so `costMicrocents`
   * was called without one and selected the OpenAI/Anthropic table. Settlement
   * then charged that estimate, because an unpriced call settles at zero and
   * releasing the whole reservation meant a cost cap could never advance.
   *
   * Both halves were deliberate. Together they enforce a dollar limit with a
   * number that has nothing to do with the bill: a gateway that marks up, or
   * aliases `gpt-4o-mini` onto something expensive, spends past the cap while
   * the counter reports the cheap retail figure. The audit row said `null` and
   * `unpriced` the whole time — the enforcement and the reporting contradicted
   * each other, and only the reporting half was honest.
   *
   * Unknown must stay unknown at an enforcement boundary, so the call is now
   * refused. Token caps are unaffected: provider-reported token counts are real
   * wherever the call went.
   */
  it("refuses a cost-capped call to a custom endpoint rather than pricing it from the retail table", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue("cccccccc-cccc-4ccc-8ccc-cccccccccccc|http://10.1.2.3:8000/v1");
    verifyVisaMock.mockResolvedValue({
      ...baseClaims,
      scope: [{ provider: "openai", models: ["gpt-4o-mini"] }],
      bc: 500,
    });

    const res = await POST(
      req({ model: "gpt-4o-mini", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
      { params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }) }
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "unpriced_endpoint" });
    // Never sent. The refusal is a configuration answer, not a spend answer.
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalled());
    expect(writeLogMock.mock.calls.at(-1)?.[0]?.status).toBe("blocked_unpriced_endpoint");
  });

  it("still allows a TOKEN-capped call to a custom endpoint", async () => {
    // Tokens are counted by the provider and are real wherever the call went.
    // Only the money is unknowable, so only the money cap refuses.
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue("cccccccc-cccc-4ccc-8ccc-cccccccccccc|http://10.1.2.3:8000/v1");
    verifyVisaMock.mockResolvedValue({
      ...baseClaims,
      scope: [{ provider: "openai", models: ["gpt-4o-mini"] }],
      bt: 10_000,
      bc: null,
    });

    const res = await POST(
      req({ model: "gpt-4o-mini", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
      { params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }) }
    );
    expect(res.status).toBe(200);
  });

  it("still allows a cost-capped call to the provider's own host", async () => {
    // The control. A cost cap is enforceable wherever PassControl knows the
    // price, which is every built-in endpoint — this must not have become a
    // blanket refusal of cost caps.
    verifyVisaMock.mockResolvedValue({
      ...baseClaims,
      scope: [{ provider: "openai", models: ["gpt-4o-mini"] }],
      bc: 500,
    });
    const res = await POST(
      req({ model: "gpt-4o-mini", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
      { params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }) }
    );
    expect(res.status).toBe(200);
  });

  it("still records a real number when the call went to the provider itself", async () => {
    await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalled());
    const logged = writeLogMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    // The control for the test above: unknown is a narrow case, not the default.
    expect(typeof logged.costMicrocents).toBe("number");
  });
});

/**
 * A redirect is where an allowlist stops being a control.
 *
 * `isEndpointAllowed` decides where the request is AIMED. Left at fetch's default
 * `follow`, the runtime decides where it LANDS — and the Fetch spec deletes only
 * `Authorization`, `Cookie` and `Proxy-Authorization` across a cross-origin hop.
 * Anthropic's credential rides `x-api-key` (lib/providers.ts), so it survives:
 * measured in both undici and the Next-compiled Edge runtime, one 302 hands the
 * real Vault key to a host no operator ever reviewed. Every other provider is
 * protected only by the accident of using a bearer token.
 *
 * So the guard is the `redirect: "manual"` option, and it is asserted directly —
 * a mocked fetch cannot demonstrate not-following. The status assertions cover
 * the second half: what the gateway does once a hop is refused.
 */
describe("upstream redirects", () => {
  const redirecting = () =>
    fetchMock.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "https://attacker.test/collect" } })
    );

  it("never gives the runtime permission to follow one", async () => {
    redirecting();
    await callProxy("anthropic", ["v1", "messages"], "claude-haiku-4-5");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: "manual" })
    );
  });

  it("refuses the call rather than handing back a bare 3xx", async () => {
    redirecting();
    const res = await callProxy("anthropic", ["v1", "messages"], "claude-haiku-4-5");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "upstream_redirect" });
  });

  it("never repeats the redirect target back to the caller", async () => {
    redirecting();
    const res = await callProxy("anthropic", ["v1", "messages"], "claude-haiku-4-5");

    // The Location can name an internal address. It is not the agent's business,
    // and echoing it would turn a refused hop into a disclosure of its own.
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).not.toContain("attacker.test");
  });

  it("bills nothing for a call that never reached a provider", async () => {
    redirecting();
    await callProxy("anthropic", ["v1", "messages"], "claude-haiku-4-5");

    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalled());
    const logged = writeLogMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(logged.status).toBe("upstream_error");
    expect(logged.costMicrocents).toBe(0);
  });
});

/**
 * What the gateway does when it cannot find out where the credential goes.
 *
 * supabase-js reports a query failure by RETURNING `{ data: null, error }`, not
 * by throwing — so an ignored `error` is indistinguishable from "this credential
 * has no endpoint", and the consequence of that guess is to send a real provider
 * credential to the built-in host. For a credential provisioned for someone
 * else's server that is the wrong destination, not a safe default.
 *
 * These tests pin the three answers apart: a row, no row, and no answer.
 */
describe("when the endpoint read does not answer", () => {
  afterEach(() => {
    delete process.env.PROVIDER_ENDPOINT_MODE;
  });

  const target = () => String(fetchMock.mock.calls.at(-1)?.[0]);

  // A supabase-js-shaped chain whose terminal maybeSingle() returns `result`.
  const dbReturning = (result: unknown) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.maybeSingle = async () => result;
    return {
      rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
      from: () => chain,
    };
  };
  const READ_FAILED = { data: null, error: { message: "connection terminated", code: "57P01" } };

  it("honours a stored endpoint on a clean read", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    serviceClientMock.mockReturnValue(
      dbReturning({ data: { endpoint_base_url: "http://10.1.2.3:8000/v1" }, error: null })
    );
    await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    expect(target()).toBe("http://10.1.2.3:8000/v1/chat/completions");
  });

  // ── The key and the address must name the same credential (S-01) ──────────
  //
  // The endpoint is read BEFORE the budget reserve (a custom endpoint is
  // unpriced, and the reconcile closure prices the call) and the secret AFTER it
  // (the check order puts the decrypt last, so a call about to be refused is
  // never decrypted for). Separated in time, deliberately. What they must not be
  // is separated in IDENTITY: neither value used to name the credential it came
  // from, so an activation landing in the gap sent secret B to endpoint A.

  const CREDENTIAL_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const CREDENTIAL_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const ENDPOINT_A = "http://10.9.9.1:8000/v1";

  /** Records which RPC the proxy reached for, and answers it by name. */
  const dbPairing = (row: unknown, answers: Record<string, unknown>) => {
    const rpc = vi.fn(async (name: string) => ({ data: answers[name] ?? null, error: null }));
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.order = () => chain;
    chain.limit = () => chain;
    chain.maybeSingle = async () => ({ data: row, error: null });
    return { rpc, from: () => chain };
  };

  it("asks for the key of the credential the endpoint came from", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    const db = dbPairing(
      { id: CREDENTIAL_A, endpoint_base_url: ENDPOINT_A },
      { get_provider_key_for_credential: "sk-real-a" }
    );
    serviceClientMock.mockReturnValue(db);
    await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    expect(db.rpc).toHaveBeenCalledWith(
      "get_provider_key_for_credential",
      expect.objectContaining({ p_credential_id: CREDENTIAL_A })
    );
    expect(target()).toBe(`${ENDPOINT_A}/chat/completions`);
  });

  it("refuses instead of pairing when that credential is no longer the selected one", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    // The bound RPC returns nothing: something was activated or rotated in the
    // gap, so this id is not the agent's selected credential any more.
    serviceClientMock.mockReturnValue(
      dbPairing({ id: CREDENTIAL_A, endpoint_base_url: ENDPOINT_A }, {})
    );
    const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    expect(res.status).toBe(409);
    // Nothing was sent. The old behaviour paired the newly-selected credential's
    // secret with the address already resolved from the old one.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // T4-04. The dispatch decision was right and the EVIDENCE it emitted was not.
  //
  // The second fence read has three possible outcomes and the route collapsed
  // them into two: `let stillPaired = false` with `catch { stillPaired = false }`
  // cannot tell "I read a different generation" from "I could not read one".
  // Both answered 409 `credential_changed`, which is logged, rendered in seven
  // places and SIGNED INTO A RECEIPT — so a Redis blip became a durable public
  // statement that the operator rotated a credential mid-call, and sent whoever
  // read it to look at a rotation that never happened.
  describe("the second credential-fence read", () => {
    /**
     * The gap the pairing check exists to cover, driven at its real seam.
     *
     * The route reads this fence three times: once resolving the endpoint (that
     * one becomes the value everything is compared against), once immediately
     * before decrypting the key, and once before dispatch. `whenKeyFetched`
     * changes what the fence answers DURING the key RPC — which is exactly when
     * a rotation, or a Redis failure, would land in production. Driving it by
     * call index instead would encode how many reads the route happens to make
     * today and pass for the wrong reason the day that changes.
     */
    const dbBound = (whenKeyFetched?: () => void) => {
      const db = dbPairing(
        { id: CREDENTIAL_A, endpoint_base_url: ENDPOINT_A },
        { get_provider_key_for_credential: "sk-real-a" }
      );
      const inner = db.rpc as (name: string, args?: unknown) => Promise<unknown>;
      db.rpc = vi.fn(async (name: string, args?: unknown) => {
        const out = await inner(name, args);
        whenKeyFetched?.();
        return out;
      }) as typeof db.rpc;
      return db;
    };

    it("dispatches when the generation is unchanged", async () => {
      process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
      readCredentialFenceMock.mockResolvedValue("gen-a");
      serviceClientMock.mockReturnValue(dbBound());
      const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalled();
    });

    it("says the credential changed only when it actually observed a different one", async () => {
      process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
      readCredentialFenceMock.mockResolvedValue("gen-a");
      serviceClientMock.mockReturnValue(
        dbBound(() => readCredentialFenceMock.mockResolvedValue("gen-b"))
      );
      const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "credential_changed" });
      expect(writeLogMock.mock.calls.at(-1)?.[0]).toMatchObject({ status: "credential_changed" });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not claim a rotation when it could not read the generation at all", async () => {
      process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
      readCredentialFenceMock.mockResolvedValue("gen-a");
      serviceClientMock.mockReturnValue(
        dbBound(() => readCredentialFenceMock.mockRejectedValue(new Error("redis unavailable")))
      );
      const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

      // Still refuses, and still fails closed — that half was never wrong.
      expect(fetchMock).not.toHaveBeenCalled();
      // But it is a PassControl-side read failure, not a configuration event.
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "credential_state_unavailable" });
      expect(writeLogMock.mock.calls.at(-1)?.[0]).toMatchObject({
        status: "credential_state_unavailable",
      });
    });

    it("treats a null generation the same way — absent is not equal", async () => {
      // `null` back from Redis is not evidence of the same generation either. It
      // used to compare unequal and be reported as a rotation for the same
      // reason a throw was.
      process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
      readCredentialFenceMock.mockResolvedValue("gen-a");
      serviceClientMock.mockReturnValue(
        dbBound(() => readCredentialFenceMock.mockResolvedValue(null))
      );
      const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.status).toBe(503);
    });
  });

  it("does not use a cached key that was sealed for a different credential", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    // A bundle left by the previously selected credential: same agent, same
    // provider, same TTL window, wrong secret for this address.
    getCachedKeyMock.mockResolvedValue(JSON.stringify({ c: CREDENTIAL_B, k: "sk-stale-b" }));
    const db = dbPairing(
      { id: CREDENTIAL_A, endpoint_base_url: ENDPOINT_A },
      { get_provider_key_for_credential: "sk-real-a" }
    );
    serviceClientMock.mockReturnValue(db);
    await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    expect(db.rpc).toHaveBeenCalledWith(
      "get_provider_key_for_credential",
      expect.objectContaining({ p_credential_id: CREDENTIAL_A })
    );
    const init = JSON.stringify(fetchMock.mock.calls.at(-1)?.[1] ?? {});
    const headers = JSON.stringify(
      Object.fromEntries(new Headers((fetchMock.mock.calls.at(-1)?.[1] as RequestInit)?.headers))
    );
    expect(headers + init).toContain("sk-real-a");
    expect(headers + init).not.toContain("sk-stale-b");
  });

  it("leaves the gate-off path on the unbound RPC, exactly as it was", async () => {
    // No custom endpoints means no pairing to keep: the endpoint read does not
    // happen at all, there is no id to bind to, and Cloud's hot path is untouched.
    const db = dbPairing(null, { get_provider_key: "sk-plain" });
    serviceClientMock.mockReturnValue(db);
    await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    expect(db.rpc).toHaveBeenCalledWith("get_provider_key", expect.anything());
    expect(target()).toBe("https://api.openai.com/v1/chat/completions");
  });

  // ── The read has to be one PostgREST can actually plan ────────────────────
  //
  // The mock above answers whatever the test tells it to, whatever was asked —
  // which is how an unplannable query stayed green for nine days. This asserts
  // the SHAPE of the read instead of its result: `provider_credentials` and
  // `agents` have no foreign key between them (both reference `users`), so a
  // sibling-table embed is not something PostgREST can resolve. It answers
  // PGRST200 / HTTP 400, the resolver correctly reads that as "unknown", and
  // every call 502s. Tenant scope comes from the credential's own `user_id`.
  //
  // `.maybeSingle()` is safe here because of 0027's partial unique index on
  // `(user_id, provider) where is_active` — at most one active credential per
  // tenant per provider, guaranteed by the database rather than by hope.

  it("reads the credential by its own tenant column, not a relationship that does not exist", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    // Every read is recorded separately: the handler makes several, and the one
    // under test is the one that asks for the endpoint.
    type Read = {
      table: string;
      columns: string;
      filters: Array<[string, unknown]>;
      order: string[];
    };
    const reads: Read[] = [];
    serviceClientMock.mockReturnValue({
      rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
      from: (name: string) => {
        const read: Read = { table: name, columns: "", filters: [], order: [] };
        reads.push(read);
        const chain: Record<string, unknown> = {};
        chain.select = (cols: string) => {
          read.columns = cols;
          return chain;
        };
        chain.eq = (column: string, value: unknown) => {
          read.filters.push([column, value]);
          return chain;
        };
        chain.order = (column: string) => {
          read.order.push(column);
          return chain;
        };
        chain.limit = () => chain;
        chain.maybeSingle = async () => ({ data: { endpoint_base_url: null }, error: null });
        chain.single = async () => ({ data: null, error: null });
        return chain;
      },
    });

    await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    const endpointRead = reads.find((read) => read.columns.includes("endpoint_base_url"));
    if (!endpointRead) throw new Error("the endpoint read never happened");
    const { table, columns, filters, order } = endpointRead;
    expect(table).toBe("provider_credentials");
    // One column, and no embed: nothing here may name another table.
    expect(columns).toBe("id, endpoint_base_url");
    expect(columns).not.toContain("!inner");
    // Tenant scope and provider — both columns of this table.
    expect(filters).toContainEqual(["user_id", "user-id"]);
    expect(filters).toContainEqual(["provider", "openai"]);
    // Selection is by the SAME ordering get_provider_key uses, not by an
    // `is_active = true` filter, which disagrees with it on the legacy path.
    expect(order).toEqual(["is_active", "created_at"]);
    // A dotted filter is a filter on an embedded table, which is the shape that
    // could not be planned. There must not be one.
    expect(filters.filter(([column]) => column.includes("."))).toEqual([]);
  });

  // ── The version contract, stated once and tested from both ends ───────────
  //
  // A custom base carries its own version segment; the canonical upstream path
  // contributes the rest. `http://vllm.internal:8000/v1` is the spelling every
  // OpenAI-shaped SDK uses for `base_url` and the spelling 0050's own column
  // comment advertises, so following the documentation has to produce a URL the
  // upstream actually serves. It did not until this test existed: the composed
  // path was `/v1/v1/chat/completions`, which vLLM answers with a 404.

  it("does not double the version segment a custom base already carries", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    serviceClientMock.mockReturnValue(
      dbReturning({ data: { endpoint_base_url: "http://10.1.2.3:8000/v1" }, error: null })
    );
    await callProxy("openai", ["chat", "completions"], "gpt-4o-mini");

    // The versionless client spelling composes the same as the versioned one.
    expect(target()).toBe("http://10.1.2.3:8000/v1/chat/completions");
  });

  it("appends the versionless path to a base that carries no version either", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    serviceClientMock.mockReturnValue(
      dbReturning({ data: { endpoint_base_url: "http://10.1.2.3:4000" }, error: null })
    );
    await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    // The base owns the version, so a base without one gets a URL without one.
    // LiteLLM serves this; vLLM does not, and an operator who wants `/v1` says
    // so in the endpoint. The rule is the same either way, which is the point:
    // the gateway never invents a version segment the operator did not write.
    expect(target()).toBe("http://10.1.2.3:4000/chat/completions");
  });

  it("applies the same contract to model listing and to anthropic", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    serviceClientMock.mockReturnValue(
      dbReturning({ data: { endpoint_base_url: "http://10.1.2.3:8000/v1" }, error: null })
    );
    await getProxy("openai", ["v1", "models"]);
    expect(target()).toBe("http://10.1.2.3:8000/v1/models");
  });

  it("still treats an empty result as a real answer meaning no endpoint", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    serviceClientMock.mockReturnValue(dbReturning({ data: null, error: null }));
    const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    // No row is not a failure: this credential genuinely has no endpoint, the
    // provider's own host is right, and caching the absence is what keeps the
    // common case off the database.
    expect(res.status).toBe(200);
    expect(target()).toBe("https://api.openai.com/v1/chat/completions");
    // The cached value now names the credential it came from, before the `|`.
    // No row means no credential and no endpoint, which is still a real answer
    // and still worth caching — that is what keeps the common case off the DB.
    // The fifth argument is the credential fence, read before the row. Null here
    // because this mock records no invalidation — its PRESENCE is the assertion.
    expect(setCachedEndpointMock).toHaveBeenCalledWith("agent-id", "openai", "|", 60, null);
  });

  it("refuses the call when the read fails, instead of re-aiming the credential", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    serviceClientMock.mockReturnValue(dbReturning(READ_FAILED));
    const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "endpoint_unavailable" });
    // Nothing was forwarded anywhere, to any host.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses before the provider key is ever decrypted", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    const db = dbReturning(READ_FAILED);
    serviceClientMock.mockReturnValue(db);
    await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    // If we do not know where a credential is going, there is no reason to go
    // and get it. `get_provider_key` is the only decrypt path in the product.
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("never caches a failed read as an authoritative absence", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    serviceClientMock.mockReturnValue(dbReturning(READ_FAILED));
    await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    // Caching "" here would pin the wrong destination for the whole TTL, so one
    // blip would outlive itself by a minute.
    expect(setCachedEndpointMock).not.toHaveBeenCalled();
  });

  it("refuses a read that throws, the same as one that returns an error", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    serviceClientMock.mockReturnValue({
      rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
      from: () => {
        throw new Error("network down");
      },
    });
    const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "endpoint_unavailable" });
  });

  it("says who refused, so nobody debugs a provider that was never contacted", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    serviceClientMock.mockReturnValue(dbReturning(READ_FAILED));
    await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalled());
    const logged = writeLogMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(logged.status).toBe("endpoint_unavailable");
    expect(logged.costMicrocents).toBe(0);
  });

  it("does not read the database at all while the gate is off", async () => {
    const db = dbReturning(READ_FAILED);
    serviceClientMock.mockReturnValue(db);
    const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    // A deployment that never opted in cannot be refused by a feature it does
    // not have. This is the default, and it is Cloud today.
    expect(res.status).toBe(200);
    expect(target()).toBe("https://api.openai.com/v1/chat/completions");
  });
});

/**
 * The router's own parameters must never reach a provider.
 *
 * ── Why these tests build an UGLY url on purpose ─────────────────────────────
 *
 * Every other request in this file is constructed with a tidy URL, and that is
 * exactly why none of them caught this. Next does not deliver a dynamic route's
 * parameters through `ctx.params` alone: it carries them in the query string
 * under its `nxtP` prefix, and the edge adapter strips the prefix and
 * re-appends them as ORDINARY parameters before the handler runs. So the real
 * `req.url` for a `POST /api/v1/openai/v1/chat/completions` reads
 *
 *   ...chat/completions?provider=openai&path=v1&path=chat&path=completions
 *
 * The proxy forwarded that search verbatim onto the upstream URL, so OpenAI
 * received `path` three times and refused the call:
 *
 *   Duplicate parameter: 'path'. You provided multiple values for this
 *   parameter, whereas only one is allowed.
 *
 * Anthropic, Groq, Mistral, Together, DeepSeek and Gemini ignored the junk
 * instead of rejecting it, which is why heavy Anthropic testing never saw it.
 * The leak was framework-level and identical for all of them.
 *
 * `injected()` below reproduces the URL shape observed from a running Next
 * server. A regression here is a test that stops using it.
 */
describe("framework routing parameters never reach the provider", () => {
  const target = () => String(fetchMock.mock.calls.at(-1)?.[0]);

  /** The URL Next actually hands the handler, client query and all. */
  function injected(provider: string, path: string[], clientQuery?: string): string {
    const routing = [`provider=${provider}`, ...path.map((seg) => `path=${seg}`)].join("&");
    const search = clientQuery ? `${clientQuery}&${routing}` : routing;
    return `https://gateway.test/api/v1/${provider}/${path.join("/")}?${search}`;
  }

  async function post(provider: string, path: string[], model: string, clientQuery?: string) {
    verifyVisaMock.mockResolvedValue({ ...baseClaims, scope: [{ provider, models: [model] }] });
    return POST(
      new Request(injected(provider, path, clientQuery), {
        method: "POST",
        headers: { authorization: "Bearer visa", "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
      }),
      { params: Promise.resolve({ provider, path }) }
    );
  }

  async function get(provider: string, path: string[], clientQuery?: string) {
    verifyVisaMock.mockResolvedValue({ ...baseClaims, scope: [{ provider, models: ["nothing-*"] }] });
    return GET(
      new Request(injected(provider, path, clientQuery), {
        method: "GET",
        headers: { authorization: "Bearer visa" },
      }),
      { params: Promise.resolve({ provider, path }) }
    );
  }

  // The exact call the OpenAI Python SDK makes for
  // client.chat.completions.parse(model="gpt-5-mini", response_format=…) against
  // base_url=".../api/v1/openai/v1".
  it("sends OpenAI chat with no query string at all", async () => {
    const res = await post("openai", ["v1", "chat", "completions"], "gpt-5-mini");

    expect(res.status).toBe(200);
    expect(target()).toBe("https://api.openai.com/v1/chat/completions");
  });

  // The other half of the same call: an SDK configured with
  // base_url=".../api/v1/openai" appends "chat/completions" without the version.
  it("sends OpenAI chat clean on the versionless client spelling too", async () => {
    const res = await post("openai", ["chat", "completions"], "gpt-5-mini");

    expect(res.status).toBe(200);
    expect(target()).toBe("https://api.openai.com/v1/chat/completions");
  });

  // Provider-agnostic, because the injection is. Only the symptom differed.
  it.each([
    ["anthropic", ["v1", "messages"], "claude-haiku-4-5", "https://api.anthropic.com/v1/messages"],
    ["groq", ["v1", "chat", "completions"], "llama-3.3-70b-versatile", "https://api.groq.com/openai/v1/chat/completions"],
    ["mistral", ["v1", "chat", "completions"], "mistral-small-latest", "https://api.mistral.ai/v1/chat/completions"],
    ["together", ["v1", "chat", "completions"], "openai/gpt-oss-20b", "https://api.together.ai/v1/chat/completions"],
    ["deepseek", ["chat", "completions"], "deepseek-chat", "https://api.deepseek.com/chat/completions"],
    ["gemini", ["chat", "completions"], "gemini-2.5-flash", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"],
  ])("sends %s clean as well", async (provider, path, model, upstream) => {
    const res = await post(provider, path, model);

    expect(res.status).toBe(200);
    expect(target()).toBe(upstream);
  });

  it("keeps a real client query parameter while dropping the routing ones", async () => {
    // Anthropic's model listing really does page with `limit` / `after_id`.
    // Dropping the whole query string would have been a different bug.
    const res = await get("anthropic", ["v1", "models"], "limit=5&after_id=m_1");

    expect(res.status).toBe(200);
    expect(target()).toBe("https://api.anthropic.com/v1/models?limit=5&after_id=m_1");
  });

  it("does not leak the routing parameters to a custom endpoint either", async () => {
    // Same code path, and the one where a leak is least excusable: the operator
    // named this host, so the gateway must send it exactly what was asked for —
    // and still no `/v1/v1/`.
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue("cccccccc-cccc-4ccc-8ccc-cccccccccccc|http://10.1.2.3:8000/v1");
    try {
      const res = await post("openai", ["v1", "chat", "completions"], "gpt-5-mini");

      expect(res.status).toBe(200);
      expect(target()).toBe("http://10.1.2.3:8000/v1/chat/completions");
    } finally {
      delete process.env.PROVIDER_ENDPOINT_MODE;
    }
  });

  it("still refuses an endpoint that is not on the allowlist", async () => {
    // The fix removes parameters; it must not have widened what is reachable.
    const res = await post("openai", ["v1", "files"], "gpt-5-mini");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_endpoint" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("carries the single-model retrieve segment but none of the routing ones", async () => {
    const res = await get("openai", ["v1", "models", "gpt-5-mini"]);

    expect(res.status).toBe(200);
    expect(target()).toBe("https://api.openai.com/v1/models/gpt-5-mini");
  });
});
