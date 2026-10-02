// Package 2, step 5: Azure OpenAI through the governed proxy. Upstream is a mock:
// no Azure subscription was used (owner decision P2-1). The harness below is
// tests/proxy-endpoint.test.ts's, unchanged, because Azure is the custom-endpoint
// path with the gate forced on for one provider.
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


const { readFallbacksMock, readProvidersWithKeysMock } = vi.hoisted(() => ({
  readFallbacksMock: vi.fn(async (): Promise<unknown[]> => []),
  readProvidersWithKeysMock: vi.fn(async (): Promise<string[]> => ["openai", "azure"]),
}));
vi.mock("@/lib/state/fallbacks", () => ({
  readCurrentAgentFallbacks: (...args: unknown[]) => readFallbacksMock(...(args as [])),
}));
vi.mock("@/lib/providers/available", () => ({
  readProvidersWithKeys: (...args: unknown[]) => readProvidersWithKeysMock(...(args as [])),
}));

const CRED = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RESOURCE = "https://contoso-ai.openai.azure.com/openai/v1";
const target = () => String(fetchMock.mock.calls.at(-1)?.[0]);
const sentHeaders = () => (fetchMock.mock.calls.at(-1)?.[1] as { headers: Headers }).headers;
const lastLog = () => writeLogMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;

async function azureCall(path: string[] = ["chat", "completions"], body: Record<string, unknown> = {}, claims = {}) {
  verifyVisaMock.mockResolvedValue({
    ...baseClaims,
    scope: [{ provider: "azure", models: ["gpt-*"] }],
    ...claims,
  });
  return POST(
    req({ model: "gpt-4o-mini", max_tokens: 10, messages: [{ role: "user", content: "hi" }], ...body }),
    { params: Promise.resolve({ provider: "azure", path }) }
  );
}

describe("azure: the credential's address is part of the credential", () => {
  afterEach(() => {
    delete process.env.PROVIDER_ENDPOINT_MODE;
  });

  it("sends the call to the stored resource with the gate OFF, as on hosted Cloud", async () => {
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${RESOURCE}`);
    const res = await azureCall();

    expect(res.status).toBe(200);
    expect(target()).toBe("https://contoso-ai.openai.azure.com/openai/v1/chat/completions");
    // The gate being off skips the endpoint read for every other provider; for
    // Azure the address is the only destination there is, so it is always read.
    expect(getCachedEndpointMock).toHaveBeenCalled();
  });

  it("injects the key as api-key and never as a bearer token", async () => {
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${RESOURCE}`);
    await azureCall();

    expect(sentHeaders().get("api-key")).toBe("provider-key");
    expect(sentHeaders().get("authorization")).toBeNull();
  });

  it("does not follow a redirect with the key", async () => {
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${RESOURCE}`);
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }));
    const res = await azureCall();

    expect((fetchMock.mock.calls.at(-1)?.[1] as { redirect: string }).redirect).toBe("manual");
    expect(res.status).toBe(502);
  });

  it("records the call as unpriced: tokens real, cost unknown", async () => {
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${RESOURCE}`);
    await azureCall();

    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalled());
    expect(lastLog().costMicrocents).toBeNull();
    expect(Number(lastLog().inputTokens) + Number(lastLog().outputTokens)).toBeGreaterThan(0);
  });

  it("refuses a key with no stored address instead of guessing a host", async () => {
    getCachedEndpointMock.mockResolvedValue(`${CRED}|`);
    const res = await azureCall();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "endpoint_required" });
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalled());
    expect(lastLog().status).toBe("endpoint_required");
    // Refused before the key was fetched and before anything was sent: a full release.
    expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "not_dispatched" }));
  });

  it("refuses a stored address that is not an Azure resource, even where self-host admits it", async () => {
    process.env.PROVIDER_ENDPOINT_MODE = "selfhost";
    getCachedEndpointMock.mockResolvedValue(`${CRED}|http://10.1.2.3:8000/v1`);
    const res = await azureCall();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "endpoint_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when the endpoint read fails, like every custom endpoint", async () => {
    getCachedEndpointMock.mockResolvedValue(null);
    serviceClientMock.mockReturnValue({
      rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
      from: () => {
        const chain: Record<string, unknown> = {};
        for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
        chain.maybeSingle = async () => ({ data: null, error: { message: "down" } });
        return chain;
      },
    });
    const res = await azureCall();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "endpoint_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when the credential was rotated between reading its address and its key", async () => {
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${RESOURCE}`);
    readCredentialFenceMock.mockResolvedValueOnce("gen-1").mockResolvedValue("gen-2");
    const res = await azureCall();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "credential_changed" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scrubs the key if the resource echoes it back", async () => {
    // A realistic key: redaction ignores strings too short to be a secret, and
    // the harness's "provider-key" is one of those. Azure keys are 32+ chars.
    const azureKey = "0123456789abcdef0123456789abcdef";
    serviceClientMock.mockReturnValue({ rpc: vi.fn(async () => ({ data: azureKey, error: null })) });
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${RESOURCE}`);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: `bad key ${azureKey}` } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );
    const res = await azureCall();

    expect(await res.text()).not.toContain(azureKey);
  });
});

describe("azure under a dollar limit", () => {
  it("is refused as an unpriced endpoint before any hold is opened", async () => {
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${RESOURCE}`);
    const res = await azureCall(["chat", "completions"], {}, { bc: 500 });

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "unpriced_endpoint" });
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(writeLogMock).toHaveBeenCalled());
    expect(lastLog().status).toBe("blocked_unpriced_endpoint");
  });
});

describe("azure refuses what no budget can hold", () => {
  it("refuses a hosted tool on Responses before anything is reserved", async () => {
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${RESOURCE}`);
    const res = await azureCall(["responses"], { input: "hi", tools: [{ type: "web_search_preview" }] });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "server_side_tools_unsupported" });
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an endpoint off the allowlist", async () => {
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${RESOURCE}`);
    const res = await azureCall(["v1", "files"]);

    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("azure under a periodic limit alone", () => {
  // `dollarLimited` is the cost cap OR a periodic limit (K1); the docs promise both.
  it("is refused the same way when only a daily dollar limit is set", async () => {
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${RESOURCE}`);
    getCachedAgentPolicyMock.mockResolvedValue(
      JSON.stringify({
        p: {},
        s: null, be: "epoch-1", bs: true, bk: true, bt: null, bc: null,
        pdk: true, pdp: "day", pdc: 500,
      })
    );
    const res = await azureCall();

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "unpriced_endpoint" });
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("azure as a fallback", () => {
  const overloaded = () =>
    new Response(JSON.stringify({ error: { message: "overloaded" } }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  const ok = () =>
    new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const primaryCall = (claims = {}) => {
    verifyVisaMock.mockResolvedValue({
      ...baseClaims,
      scope: [
        { provider: "openai", models: ["gpt-4o-mini"] },
        { provider: "azure", models: ["gpt-*"] },
      ],
      ...claims,
    });
    return POST(
      req({ model: "gpt-4o-mini", max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
      { params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }) }
    );
  };

  beforeEach(() => {
    readFallbacksMock.mockResolvedValue([{ provider: "azure", model: "gpt-4o-mini" }]);
    readProvidersWithKeysMock.mockResolvedValue(["openai", "azure"]);
  });
  afterEach(() => {
    readFallbacksMock.mockResolvedValue([]);
  });

  it("fails over into the stored resource", async () => {
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${RESOURCE}`);
    fetchMock.mockResolvedValueOnce(overloaded()).mockResolvedValueOnce(ok());
    const res = await primaryCall();
    await res.text();

    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://api.openai.com/v1/chat/completions",
      "https://contoso-ai.openai.azure.com/openai/v1/chat/completions",
    ]);
  });

  it("skips an Azure fallback with no address and returns the primary's answer", async () => {
    getCachedEndpointMock.mockResolvedValue(`${CRED}|`);
    fetchMock.mockResolvedValue(overloaded());
    const res = await primaryCall();

    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fail over into Azure under a dollar limit, and does not answer 402 for it", async () => {
    getCachedEndpointMock.mockResolvedValue(`${CRED}|${RESOURCE}`);
    fetchMock.mockResolvedValue(overloaded());
    const res = await primaryCall({ bc: 500 });

    // The primary's own failure, not the fallback's pricing refusal.
    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
