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
    fetchMock: vi.fn(),
  };
});

// The proxy now reaches lib/demo/identity.ts to tell the seeded PUBLIC demo
// passport apart from a tenant that holds a demo scope. That module is
// `server-only`, which Next enforces at build time and vitest cannot resolve
// at all — same stub tests/site-demo-routes.test.ts already uses.
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
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
  getCachedEndpoint: (...args: unknown[]) => getCachedEndpointMock(...args),
  setCachedEndpoint: (...args: unknown[]) => setCachedEndpointMock(...args),
  setCachedKey: (...args: unknown[]) => setCachedKeyMock(...args),
  getCachedAgentPolicy: (...args: unknown[]) => getCachedAgentPolicyMock(...args),
  setCachedAgentPolicy: (...args: unknown[]) => setCachedAgentPolicyMock(...args),
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
    getCachedEndpointMock.mockResolvedValue("http://10.1.2.3:8000/v1");
    const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    expect(res.status).toBe(200);
    expect(target()).toBe("https://api.openai.com/v1/chat/completions");
    // Not merely disabled — the feature is absent, so it costs no read at all.
    expect(getCachedEndpointMock).not.toHaveBeenCalled();
  });

  it("sends the call to a self-hosted endpoint, base path and all", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue("http://10.1.2.3:8000/openai/v1");
    const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    expect(res.status).toBe(200);
    // The operator's `/openai/v1` survives. `new URL` would have eaten it.
    expect(target()).toBe("http://10.1.2.3:8000/openai/v1/v1/chat/completions");
  });

  // Re-validated on read, not trusted from the row. An operator who narrows the
  // gate must not keep serving endpoints that were legal when they were stored.
  it("falls back to the built-in host when the stored value is no longer admitted", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "gateway.company.com";
    getCachedEndpointMock.mockResolvedValue("http://10.1.2.3:8000/v1");
    const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");

    expect(res.status).toBe(200);
    expect(target()).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("still speaks the credential's own protocol, not the endpoint's", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue("http://10.1.2.3:8000/v1");
    await callProxy("anthropic", ["v1", "messages"], "claude-3-5-haiku-20241022");

    // The endpoint moves; the wire format does not. An Anthropic credential
    // pointed at a local server still sends Anthropic's headers.
    const init = fetchMock.mock.calls.at(-1)?.[1] as { headers: Headers };
    expect(init.headers.get("x-api-key")).toBe("provider-key");
    expect(init.headers.get("authorization")).toBeNull();
  });

  it("logs the call as unpriced when it did not go to the provider's own host", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue("http://10.1.2.3:8000/v1");
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

    expect(target()).toBe("http://10.1.2.3:8000/v1/v1/chat/completions");
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
    expect(setCachedEndpointMock).toHaveBeenCalledWith("agent-id", "openai", "", 60);
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
