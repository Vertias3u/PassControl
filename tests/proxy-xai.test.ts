// Package 2, step 4: xAI through the governed proxy — Responses only, billed as
// total − input, server-side tools refused, the output ceiling read from
// `max_output_tokens`. Upstream is a mock: no paid call was made (owner, P2-1).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const establishBudgetStateMock = vi.fn();

const {
  pending,
  verifyVisaMock,
  serviceClientMock,
  openHoldMock,
  settleHoldMock,
  getCachedKeyMock,
  readKillStateMock,
  isSuspendedMock,
  readPolicyMock,
  writeLogMock,
  mirrorSpendMock,
  rateLimitMock,
  signReceiptMock,
  fetchMock,
  readFallbacksMock,
  readProvidersWithKeysMock,
} = vi.hoisted(() => ({
  pending: [] as Promise<unknown>[],
  verifyVisaMock: vi.fn(),
  serviceClientMock: vi.fn(),
  openHoldMock: vi.fn(),
  settleHoldMock: vi.fn(),
  getCachedKeyMock: vi.fn(),
  readKillStateMock: vi.fn(),
  isSuspendedMock: vi.fn(),
  readPolicyMock: vi.fn(),
  writeLogMock: vi.fn(),
  mirrorSpendMock: vi.fn(),
  rateLimitMock: vi.fn(),
  signReceiptMock: vi.fn(),
  fetchMock: vi.fn(),
  readFallbacksMock: vi.fn(),
  readProvidersWithKeysMock: vi.fn(),
}));

// The proxy now reaches lib/demo/identity.ts to tell the seeded PUBLIC demo
// passport apart from a tenant that holds a demo scope. That module is
// `server-only`, which Next enforces at build time and vitest cannot resolve
// at all — same stub tests/site-demo-routes.test.ts already uses.
// The Cloud allowance resolver sits on the enforcement path and fails CLOSED, so
// an unmocked one refuses every request here with a 503 instead of exercising
// what this file is about.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/state/fallbacks", () => ({
  readCurrentAgentFallbacks: (...args: unknown[]) => readFallbacksMock(...args),
}));
vi.mock("@/lib/providers/available", () => ({
  readProvidersWithKeys: (...args: unknown[]) => readProvidersWithKeysMock(...args),
}));
vi.mock("@vercel/functions", () => ({
  waitUntil: (promise: Promise<unknown>) => pending.push(Promise.resolve(promise)),
}));
vi.mock("@/lib/auth/visa", () => ({
  extractVisaToken: (headers: Headers) =>
    headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
  verifyVisa: (...args: unknown[]) => verifyVisaMock(...args),
}));
vi.mock("@/lib/state/killswitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/killswitch")>();
  return { ...actual, readKillState: (...args: unknown[]) => readKillStateMock(...args) };
});
vi.mock("@/lib/state/redis", () => ({
  purgeAgentPolicy: vi.fn(),
  // The proxy reads this before the endpoint row and again before dispatch.
  // Omitted, it is undefined, the call throws, and the route 500s.
  readCredentialFence: vi.fn(async () => null),
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
  setCachedKey: vi.fn(async () => undefined),
  touchLastSeen: vi.fn(async () => undefined),
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
vi.mock("@/lib/state/policy", () => ({
  readCurrentAgentPolicyAndShadow: (...args: unknown[]) => readPolicyMock(...args),
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("@/lib/crypto/aesgcm", () => ({
  seal: async () => "sealed",
  open: async (value: string) => value,
}));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/receipt", () => ({
  signReceipt: (...args: unknown[]) => signReceiptMock(...args),
}));
vi.mock("@/lib/owner/current", () => ({ readCurrentOwner: async () => null }));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: (...args: unknown[]) => rateLimitMock(...args),
  rateLimitFailClosed: vi.fn(),
}));
vi.mock("@/lib/observability", () => ({
  captureError: vi.fn(async () => undefined),
  captureSecurityEvent: vi.fn(async () => undefined),
  logFailOpen: vi.fn(),
}));
import { POST } from "@/app/api/v1/[provider]/[...path]/route";

function jsonResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

const XAI_BODY = JSON.stringify({
  id: "resp_1",
  object: "response",
  status: "completed",
  usage: {
    input_tokens: 32,
    input_tokens_details: { cached_tokens: 8 },
    output_tokens: 9,
    output_tokens_details: { reasoning_tokens: 110 },
    total_tokens: 151,
    num_sources_used: 0,
    num_server_side_tools_used: 0,
  },
});

const claims = {
  sub: "passport-id",
  agid: "agent-id",
  uid: "user-id",
  jti: "jti-1",
  bt: 10_000,
  bc: null,
  st: 0,
  sc: 0,
  ver: 1,
  scope: [
    { provider: "xai", models: ["grok-*"] },
    { provider: "openai", models: ["gpt-4.1"] },
  ],
};

function request(path: string[], body: Record<string, unknown>, provider = "xai") {
  return new Request(`https://gateway.test/api/v1/${provider}/${path.join("/")}`, {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function call(path: string[], body: Record<string, unknown>, provider = "xai") {
  return POST(request(path, body, provider), {
    params: Promise.resolve({ provider, path }),
  });
}

async function flushPending() {
  for (;;) {
    const batch = pending.splice(0);
    if (batch.length === 0) return;
    await Promise.all(batch);
  }
}

beforeEach(() => {
  pending.length = 0;
  for (const mock of [
    verifyVisaMock,
    serviceClientMock,
    openHoldMock,
    settleHoldMock,
    getCachedKeyMock,
    readKillStateMock,
    isSuspendedMock,
    readPolicyMock,
    writeLogMock,
    mirrorSpendMock,
    rateLimitMock,
    signReceiptMock,
    fetchMock,
    readFallbacksMock,
    readProvidersWithKeysMock,
  ]) {
    mock.mockReset();
  }

  verifyVisaMock.mockResolvedValue(claims);
  serviceClientMock.mockReturnValue({ rpc: vi.fn(async () => ({ data: "provider-key" })) });
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1, reservedMicrocents: 0 });
  settleHoldMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue("provider-key");
  readKillStateMock.mockResolvedValue({ platformKill: false, tenantKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  readPolicyMock.mockResolvedValue({
  policy: {},
  shadow: null,
  // `known: false` = "this read could not establish the caps", which is what
  // every rung below the newest returns, and makes the proxy keep the visa's
  // own claim — the behaviour that shipped before S3-04.
  budget: { known: false },
});
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  signReceiptMock.mockReturnValue("signed-receipt");
  readFallbacksMock.mockResolvedValue([]);
  readProvidersWithKeysMock.mockResolvedValue(["openai", "xai"]);
  fetchMock.mockImplementation(async () => jsonResponse(XAI_BODY));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ASK = { model: "grok-4.3", input: "hi", max_output_tokens: 200 };

describe("governed xAI Responses", () => {
  it.each([[["responses"]], [["v1", "responses"]]])(
    "governs POST /%s and bills output as total − input",
    async (path) => {
      const res = await call(path, ASK);
      expect(await res.text()).toBe(XAI_BODY);
      await flushPending();

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.x.ai/v1/responses",
        expect.objectContaining({ method: "POST" })
      );
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect((init.headers as Headers).get("authorization")).toBe("Bearer provider-key");
      expect(JSON.parse(init.body as string)).toEqual(ASK);
      expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "complete", tokens: 151 }));
      expect(writeLogMock).toHaveBeenCalledWith(
        expect.objectContaining({ inputTokens: 32, outputTokens: 119, status: "ok" })
      );
    }
  );

  it("reads a streamed response.completed the same way and injects nothing into the body", async () => {
    const usage = JSON.parse(XAI_BODY).usage;
    fetchMock.mockImplementationOnce(async () =>
      new Response(
        "event: response.completed\n" +
          `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage } })}\n\n` +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    );
    const res = await call(["v1", "responses"], { ...ASK, stream: true });
    await res.text();
    await flushPending();
    const forwarded = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
    expect(forwarded).not.toHaveProperty("stream_options");
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 32, outputTokens: 119, status: "ok" })
    );
  });

  it("settles a report with no total_tokens as usage_unknown", async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(JSON.stringify({ status: "completed", usage: { input_tokens: 32, output_tokens: 9 } }))
    );
    const res = await call(["v1", "responses"], ASK);
    await res.text();
    await flushPending();
    expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "usage_unknown" }));
  });

  it.each([[["chat", "completions"]], [["v1", "chat", "completions"]]])(
    "refuses xAI's legacy Chat Completions at /%s",
    async (path) => {
      const res = await call(path, { model: "grok-4.3", messages: [] });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "blocked_endpoint" });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["web search", { tools: [{ type: "web_search" }] }],
    ["X search", { tools: [{ type: "x_search" }] }],
    ["search_parameters", { search_parameters: { mode: "auto" } }],
  ])("refuses %s before any reservation or provider contact", async (_name, extra) => {
    const res = await call(["v1", "responses"], { ...ASK, ...extra });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "server_side_tools_unsupported" });
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards function tools, which the agent runs itself", async () => {
    const body = { ...ASK, tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] };
    const res = await call(["v1", "responses"], body);
    await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual(body);
  });

  // OpenAI now refuses its own hosted tools at the primary, so the case that
  // reaches a fallback is a tool OpenAI runs client-side but xAI does not
  // document as one: a `custom` tool.
  it("does not fail over into xAI with a tool xAI's rule refuses", async () => {
    verifyVisaMock.mockResolvedValue({
      ...claims,
      scope: [
        { provider: "openai", models: ["gpt-4.1"] },
        { provider: "xai", models: ["grok-*"] },
      ],
    });
    readFallbacksMock.mockResolvedValue([{ provider: "xai", model: "grok-4.3" }]);
    fetchMock.mockImplementation(async () => jsonResponse('{"error":"overloaded"}', 503));
    const res = await call(
      ["v1", "responses"],
      { model: "gpt-4.1", input: "hi", tools: [{ type: "custom", name: "grammar" }] },
      "openai"
    );
    await res.text();
    await flushPending();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/responses");
  });

  it("does fail over into xAI with a request it can serve", async () => {
    verifyVisaMock.mockResolvedValue({
      ...claims,
      scope: [
        { provider: "openai", models: ["gpt-4.1"] },
        { provider: "xai", models: ["grok-*"] },
      ],
    });
    readFallbacksMock.mockResolvedValue([{ provider: "xai", model: "grok-4.3" }]);
    fetchMock
      .mockImplementationOnce(async () => jsonResponse('{"error":"overloaded"}', 503))
      .mockImplementationOnce(async () => jsonResponse(XAI_BODY));
    const res = await call(["v1", "responses"], { model: "gpt-4.1", input: "hi" }, "openai");
    await res.text();
    await flushPending();
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "https://api.openai.com/v1/responses",
      "https://api.x.ai/v1/responses",
    ]);
  });

  describe("with an output ceiling of 1000", () => {
    beforeEach(() => {
      readPolicyMock.mockResolvedValue({ policy: { max_output_tokens: 1000 }, shadow: null, budget: { known: false } });
    });

    it("admits max_output_tokens under the ceiling", async () => {
      const res = await call(["v1", "responses"], ASK);
      await res.text();
      expect(res.status).toBe(200);
    });

    it("refuses a call that states only max_tokens, which xAI Responses ignores", async () => {
      const res = await call(["v1", "responses"], { model: "grok-4.3", input: "hi", max_tokens: 10 });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "blocked_policy", rule: "max_output_tokens" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
