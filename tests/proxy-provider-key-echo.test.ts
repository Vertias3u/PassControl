// C3 (S-02) — an upstream that echoes the injected provider key must not hand
// it back to the agent. Invariant 4 says the key is never put in a response;
// before this, the proxy forwarded provider error bodies verbatim, success JSON
// re-serialised, and SSE bytes unchanged, so a reflecting upstream (a custom
// endpoint, a misbehaving proxy in front of a provider, a debugging echo)
// returned the tenant's real key to whoever held the agent credential.
//
// Harness copied from tests/proxy-upstream-error.test.ts, with a key long
// enough to be a real one (the redactor ignores values too short to be keys).
import { beforeEach, describe, expect, it, vi } from "vitest";
const PROVIDER_KEY = "sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z-ECHO_TEST";
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
  readProvidersWithKeysMock,
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
    readProvidersWithKeysMock: vi.fn(),
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
const captureSecurityEventMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/observability")>()),
  captureSecurityEvent: (...args: unknown[]) => captureSecurityEventMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...args: unknown[]) => rateLimitMock(...args) }));
// Only the tenant lookup is mocked. classifyUpstreamFailure and buildAlternatives
// run for real here on purpose: the point of these cases is that the proxy wires
// the real classifier to the real alternatives builder, which a mock would hide.
vi.mock("@/lib/providers/available", () => ({
  readProvidersWithKeys: (...args: unknown[]) => readProvidersWithKeysMock(...args),
}));

import { POST } from "@/app/api/v1/[provider]/[...path]/route";

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
  scope: [{ provider: "openai", models: ["gpt-4o-mini"] }],
};

function request() {
  return new Request("https://gateway.test/api/v1/openai/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

async function callProxy() {
  return POST(request(), {
    params: Promise.resolve({ provider: "openai", path: ["chat", "completions"] }),
  });
}

/**
 * The provider gave a DEFINITIVE answer and did no work for it — a 4xx, a
 * redirect, a refusal for credit. The hold is fully released and nothing is
 * charged.
 */
function expectReleasedWithoutSpend() {
  const attemptId = openHoldMock.mock.calls[0]?.[0]?.attemptId;
  expect(attemptId).toEqual(expect.any(String));
  expect(settleHoldMock).toHaveBeenCalledWith(
    expect.objectContaining({
      agentId: "agent-id",
      attemptId,
      outcome: "complete",
      tokens: 0,
      microcents: 0,
    })
  );
  expect(writeLogMock).toHaveBeenCalledWith(
    expect.objectContaining({
      jti: "jti-1",
      status: "upstream_error",
      inputTokens: 0,
      outputTokens: 0,
      costMicrocents: 0,
    })
  );
  expect(mirrorSpendMock).not.toHaveBeenCalled();
}

/**
 * The attempt MAY have been billed and nobody can say for how much, so the
 * estimate stands and the hold closes rather than releasing.
 *
 * This reverses what this file used to assert, and the reversal is the point.
 * A 5xx can arrive after the provider has generated and billed a whole answer,
 * and a `fetch` that throws cannot be told apart from one that was served and
 * then lost its connection. Releasing the hold in either case refunded real
 * money on the gateway's guess that nothing had happened.
 */
function expectChargedAsUnknown(status: number) {
  const attemptId = openHoldMock.mock.calls[0]?.[0]?.attemptId;
  expect(attemptId).toEqual(expect.any(String));
  expect(settleHoldMock).toHaveBeenCalledWith(
    expect.objectContaining({ agentId: "agent-id", attemptId, outcome: "usage_unknown" })
  );
  expect(writeLogMock).toHaveBeenCalledWith(
    expect.objectContaining({
      jti: "jti-1",
      // NOT `upstream_error`. That status means a call we know produced
      // nothing; this one we cannot say that about, and 0055's spend view
      // counts the two differently for exactly that reason.
      status: "usage_unknown",
    })
  );
  expect(status).toBeGreaterThan(0);
}

beforeEach(() => {
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
  readProvidersWithKeysMock.mockReset();
  readProvidersWithKeysMock.mockResolvedValue([]);

  verifyVisaMock.mockResolvedValue(baseClaims);
  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: PROVIDER_KEY, error: null })),
  });
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1 });
  settleHoldMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue(null);
  setCachedKeyMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null }));
  setCachedAgentPolicyMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, tenantKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  vi.stubGlobal("fetch", fetchMock);
});


function streamOf(parts: string[], init: ResponseInit) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    }),
    init
  );
}

async function bodyOf(res: Response) {
  return await res.text();
}

describe("the proxy does not return the provider key an upstream echoes", () => {
  beforeEach(() => captureSecurityEventMock.mockReset());

  it("sends the real key upstream (the thing being protected)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    await callProxy();
    const sent = new Headers((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers);
    expect(sent.get("authorization")).toBe(`Bearer ${PROVIDER_KEY}`);
  });

  it("redacts a 401 error body passed through as a stream", async () => {
    fetchMock.mockResolvedValueOnce(
      streamOf([`{"error":{"message":"Incorrect API key provided: ${PROVIDER_KEY.slice(0, 20)}`, `${PROVIDER_KEY.slice(20)}"}}`], {
        status: 401,
        headers: { "content-type": "application/json" },
      })
    );
    const res = await callProxy();
    expect(res.status).toBe(401);
    const text = await bodyOf(res);
    expect(text).not.toContain(PROVIDER_KEY);
    expect(text).toContain("[REDACTED_PROVIDER_KEY]");
    expect(() => JSON.parse(text)).not.toThrow();
    expectReleasedWithoutSpend();
    expect(captureSecurityEventMock).toHaveBeenCalledWith(
      "proxy.provider_key_reflected",
      expect.objectContaining({ provider: "openai", agentId: "agent-id" })
    );
    expect(JSON.stringify(captureSecurityEventMock.mock.calls)).not.toContain(PROVIDER_KEY);
  });

  it("redacts an inspected (buffered) 429 error body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: `slow down, ${PROVIDER_KEY}` } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      })
    );
    const res = await callProxy();
    const text = await bodyOf(res);
    expect(res.status).toBe(429);
    expect(text).not.toContain(PROVIDER_KEY);
    expect(text).toContain("[REDACTED_PROVIDER_KEY]");
  });

  it("redacts a 500 error body", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(`upstream crashed; auth header was Bearer ${PROVIDER_KEY}`, { status: 500, headers: { "content-type": "text/plain" } })
    );
    const res = await callProxy();
    const text = await bodyOf(res);
    expect(text).not.toContain(PROVIDER_KEY);
    expect(text).toContain("Bearer [REDACTED_PROVIDER_KEY]");
  });

  it("redacts a 200 JSON answer and still accounts for its usage", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "c1",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: `your key is ${PROVIDER_KEY}` }, finish_reason: "stop" }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const res = await callProxy();
    const json = JSON.parse(await bodyOf(res));
    expect(json.choices[0].message.content).toBe("your key is [REDACTED_PROVIDER_KEY]");
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "ok", inputTokens: 7, outputTokens: 3 }));
  });

  it("redacts a key split across SSE chunks and keeps the usage event", async () => {
    const event = (o: object) => `data: ${JSON.stringify(o)}\n\n`;
    const leak = event({ choices: [{ index: 0, delta: { content: PROVIDER_KEY } }] });
    const cut = leak.indexOf(PROVIDER_KEY) + 11;
    fetchMock.mockResolvedValueOnce(
      streamOf(
        [
          event({ choices: [{ index: 0, delta: { role: "assistant", content: "key: " } }] }),
          leak.slice(0, cut),
          leak.slice(cut),
          event({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }),
          "data: [DONE]\n\n",
        ],
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    );
    const res = await callProxy();
    const text = await bodyOf(res);
    expect(text).not.toContain(PROVIDER_KEY);
    expect(text).toContain("[REDACTED_PROVIDER_KEY]");
    expect(text).toContain("data: [DONE]");
    // The usage transform still saw the provider's report.
    expect(text).toContain('"prompt_tokens":5');
  });

  it("leaves a response that never mentions the key byte-identical and raises no event", async () => {
    const original = JSON.stringify({ error: { message: "model not found", type: "invalid_request_error" } });
    fetchMock.mockResolvedValueOnce(new Response(original, { status: 404, headers: { "content-type": "application/json" } }));
    const res = await callProxy();
    expect(await bodyOf(res)).toBe(original);
    expect(captureSecurityEventMock).not.toHaveBeenCalledWith("proxy.provider_key_reflected", expect.anything());
  });
});
