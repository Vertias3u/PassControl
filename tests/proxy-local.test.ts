// Local models (1.2.0): the `local` provider through the governed proxy. A
// local OpenAI-compatible server (Ollama, LM Studio, vLLM) has no host of ours,
// so `local` is Azure's shape — the address is part of the credential — with
// one difference that is the whole security argument: Azure is admitted on
// every deployment by a closed Microsoft-suffix rule, and `local` is admitted
// ONLY where the operator gate is open. On hosted Cloud (gate off) a `local`
// credential must reach nothing, and must be refused before its key is read.
//
// The harness is tests/proxy-azure.test.ts's, unchanged. Upstream is a mock.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const establishBudgetStateMock = vi.fn();

import { LOCAL_NO_KEY, PROVIDERS, usesOpenAiUsageShape } from "@/lib/providers";

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


const { readFallbacksMock, readProvidersWithKeysMock } = vi.hoisted(() => ({
  readFallbacksMock: vi.fn(async (): Promise<unknown[]> => []),
  readProvidersWithKeysMock: vi.fn(async (): Promise<string[]> => ["local"]),
}));
vi.mock("@/lib/state/fallbacks", () => ({
  readCurrentAgentFallbacks: (...args: unknown[]) => readFallbacksMock(...(args as [])),
}));
vi.mock("@/lib/providers/available", () => ({
  readProvidersWithKeys: (...args: unknown[]) => readProvidersWithKeysMock(...(args as [])),
}));


const CRED = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const OLLAMA = "http://localhost:11434/v1";
const target = () => String(fetchMock.mock.calls.at(-1)?.[0]);
const sentHeaders = () => (fetchMock.mock.calls.at(-1)?.[1] as { headers: Headers }).headers;
const lastLog = () => writeLogMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
const rpcCalls = () =>
  (serviceClientMock.mock.results.flatMap((r) => (r.value?.rpc as { mock?: { calls: unknown[][] } })?.mock?.calls ?? []));

async function localCall(path: string[] = ["v1", "chat", "completions"], body: Record<string, unknown> = {}, claims = {}) {
  verifyVisaMock.mockResolvedValue({
    ...baseClaims,
    scope: [{ provider: "local", models: ["qwen2.5:*"] }],
    ...claims,
  });
  return POST(
    req({ model: "qwen2.5:0.5b", max_tokens: 10, messages: [{ role: "user", content: "hi" }], ...body }),
    { params: Promise.resolve({ provider: "local", path }) }
  );
}

describe("local: reachable only where the operator gate is open", () => {
  afterEach(() => {
    delete process.env.PROVIDER_ENDPOINT_MODE;
  });

  it("is a provider", () => {
    expect(PROVIDERS).toContain("local");
    expect(usesOpenAiUsageShape("local")).toBe(true);
  });

  it("sends the call to the stored server in selfhost mode", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${OLLAMA}`);
    const res = await localCall();

    expect(res.status).toBe(200);
    // The stored base owns its version segment: no /v1/v1.
    expect(target()).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("accepts the versionless client spelling too", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${OLLAMA}`);
    const res = await localCall(["chat", "completions"]);

    expect(res.status).toBe(200);
    expect(target()).toBe("http://localhost:11434/v1/chat/completions");
  });

  it("with the gate OFF (hosted Cloud), refuses a stored local address before the key is read", async () => {
    // A row or cache entry written while the gate was open — or forged — must
    // not make the gateway fetch a private address once it is closed.
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${OLLAMA}`);
    const res = await localCall();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "endpoint_required" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getCachedKeyMock).not.toHaveBeenCalled();
    expect(rpcCalls().some(([name]) => String(name).startsWith("get_provider_key"))).toBe(false);
    expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "not_dispatched" }));
  });

  it("with an allowlist, refuses a local address the operator did not list", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "models.example.com";
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${OLLAMA}`);
    const res = await localCall();

    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a credential with no stored address instead of guessing a host", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue(`${CRED}|`);
    const res = await localCall();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "endpoint_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends a stored key as a bearer token", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${OLLAMA}`);
    serviceClientMock.mockReturnValue({ rpc: vi.fn(async () => ({ data: "vllm-secret-key", error: null })) });
    await localCall();

    expect(sentHeaders().get("authorization")).toBe("Bearer vllm-secret-key");
  });

  it("sends no credential at all for a keyless local server", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${OLLAMA}`);
    serviceClientMock.mockReturnValue({ rpc: vi.fn(async () => ({ data: LOCAL_NO_KEY, error: null })) });
    await localCall();

    expect(sentHeaders().get("authorization")).toBeNull();
    expect(sentHeaders().get("api-key")).toBeNull();
  });

  it("records the call as unpriced and the provider as local", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${OLLAMA}`);
    await localCall();

    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalled());
    expect(lastLog().provider).toBe("local");
    expect(lastLog().costMicrocents).toBeNull();
  });

  it("refuses an endpoint off the allowlist", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${OLLAMA}`);
    const res = await localCall(["api", "pull"]);

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("local under a dollar limit", () => {
  afterEach(() => {
    delete process.env.PROVIDER_ENDPOINT_MODE;
  });

  it("is refused as an unpriced endpoint before any hold is opened", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${OLLAMA}`);
    const res = await localCall(["v1", "chat", "completions"], {}, { bc: 500 });

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "unpriced_endpoint" });
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
