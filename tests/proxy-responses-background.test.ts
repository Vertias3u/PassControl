import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const establishBudgetStateMock = vi.fn();

const {
  verifyVisaMock,
  serviceClientMock,
  openHoldMock,
  settleHoldMock,
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
  pendingTasks,
  captureSecurityEventMock,
} = vi.hoisted(() => {
  return {
    verifyVisaMock: vi.fn(),
    serviceClientMock: vi.fn(),
    openHoldMock: vi.fn(),
    settleHoldMock: vi.fn(),
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
    captureSecurityEventMock: vi.fn(),
    pendingTasks: [] as Promise<unknown>[],
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
vi.mock("@vercel/functions", () => ({
  waitUntil: (task: Promise<unknown>) => { pendingTasks.push(task); },
}));
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
  // Cloud review A1: the proxy reads the stored endpoint on every deployment now.
  // A warm "no stored address" answer keeps this file on the plain key path.
  getCachedEndpoint: async () => "|",
  purgeAgentPolicy: vi.fn(),
  // The proxy reads this before the endpoint row and again before dispatch.
  // Omitted, it is undefined, the call throws, and the route 500s.
  readCredentialFence: vi.fn(async () => null),
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
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

vi.mock("@/lib/observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/observability")>(),
  captureSecurityEvent: (...args: unknown[]) => captureSecurityEventMock(...args),
}));

import { GET, POST } from "@/app/api/v1/[provider]/[...path]/route";

const GATEWAY = "https://gateway.test";
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

beforeEach(() => {
  pendingTasks.length = 0;
  captureSecurityEventMock.mockReset();
  verifyVisaMock.mockReset();
  serviceClientMock.mockReset();
  openHoldMock.mockReset();
  settleHoldMock.mockReset();
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
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1 });
  settleHoldMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue(null);
  setCachedKeyMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null }));
  setCachedAgentPolicyMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
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

const providers = [
  ["openai", "gpt-4o-mini", "https://api.openai.com/v1/responses"],
  ["xai", "grok-4.3", "https://api.x.ai/v1/responses"],
] as const;

function requestBody(model: string, stream: boolean) {
  // Explicit tier prevents the normal OpenAI service_tier default from making
  // a whole-body equality assertion confuse unrelated mutations with background.
  return { model, input: "hi", max_output_tokens: 10, background: true, stream, service_tier: "auto" };
}

async function drainTasks() {
  // Await real route reconciliation/audit promises, including SSE completion.
  for (let i = 0; i < pendingTasks.length; i++) await pendingTasks[i];
}

afterEach(async () => {
  await drainTasks();
  vi.unstubAllGlobals();
});

describe.each(providers)("%s background Responses through the real route", (provider, model) => {
  it("refuses retrieval of a queued response before upstream dispatch", async () => {
    verifyVisaMock.mockResolvedValue({ ...baseClaims, scope: [{ provider, models: ["*"] }] });
    const res = await GET(new Request(`${GATEWAY}/api/v1/${provider}/v1/responses/resp_background`, {
      headers: { authorization: "Bearer visa" },
    }), { params: Promise.resolve({ provider, path: ["v1", "responses", "resp_background"] }) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "blocked_endpoint" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openHoldMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("refuses background:true before hold/key/fetch with stream:%s", async (stream) => {
    await assertBackgroundRefused(provider, model, true, stream);
  });
});

async function postBody(provider: string, model: string, body: Record<string, unknown>) {
  verifyVisaMock.mockResolvedValue({ ...baseClaims, scope: [{ provider, models: [model] }] });
  return POST(new Request(`${GATEWAY}/api/v1/${provider}/v1/responses`, {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ provider, path: ["v1", "responses"] }) });
}

async function assertBackgroundRefused(provider: string, model: string, background: unknown, stream: boolean) {
  const res = await postBody(provider, model, { ...requestBody(model, stream), background });
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({
    error: "background_not_supported",
    message: "Background responses are not supported through PassControl because a stop could not reach them. Send the request without background.",
  });
  const receiptId = res.headers.get("x-passcontrol-receipt-id");
  expect(receiptId).toBeTruthy();
  await drainTasks();
  expect(openHoldMock).not.toHaveBeenCalled();
  expect(settleHoldMock).not.toHaveBeenCalled();
  expect(getCachedKeyMock).not.toHaveBeenCalled();
  const rpc = serviceClientMock.mock.results[0]!.value.rpc;
  expect(rpc.mock.calls.filter(([name]: [string]) =>
    name === "get_provider_key" || name === "get_provider_key_for_credential")).toEqual([]);
  expect(fetchMock).not.toHaveBeenCalled();
  expect(writeLogMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    id: receiptId, agentId: "agent-id", userId: "user-id", provider, model,
    status: "blocked_policy",
  }));
  expect(mirrorSpendMock).not.toHaveBeenCalled();
  expect(captureSecurityEventMock).toHaveBeenCalledExactlyOnceWith("proxy.background_not_supported", {
    route: "api.proxy", method: "POST", status: 400, provider,
    agentId: "agent-id", jti: "jti-1", code: "background_not_supported", controlScope: undefined,
  });
}

describe.each([
  ["openai", "gpt-4o-mini"],
  ["xai", "grok-4.3"],
  ["azure", "deployment-name"],
])("%s fail-closed background field", (provider, model) => {
  for (const background of [true, "true", 1, 0, "", [], {}]) {
    for (const stream of [false, true]) {
      it(`refuses background:${JSON.stringify(background)} with stream:${stream} before hold/key/fetch`, async () => {
        await assertBackgroundRefused(provider, model, background, stream);
      });
    }
  }
});

describe.each(providers)("%s foreground Responses", (provider, model, upstream) => {
  for (const stream of [false, true]) {
    for (const background of [false, null, undefined]) {
      it(`still forwards background:${background} with stream:${stream}`, async () => {
        const body = { ...requestBody(model, stream), background };
        const wire = JSON.stringify({ status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
        fetchMock.mockResolvedValue(new Response(wire, { headers: { "content-type": "application/json" } }));
        const res = await postBody(provider, model, body);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe(wire);
        await drainTasks();
        expect(openHoldMock).toHaveBeenCalledTimes(1);
        expect(getCachedKeyMock).toHaveBeenCalledTimes(1);
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(upstream, expect.objectContaining({
          method: "POST", body: JSON.stringify(body),
        }));
        expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "complete" }));
        expect(captureSecurityEventMock).not.toHaveBeenCalled();
      });
    }
  }
});
