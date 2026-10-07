// OpenAI server-side tools through the proxy (owner decision, 2026-09-27): a
// request that could incur a hosted-tool fee is refused before any reservation or
// provider contact, and a failover into OpenAI is skipped for it.
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
    { provider: "openai", models: ["gpt-*"] },
    { provider: "groq", models: ["llama-*"] },
  ],
};

function request(path: string[], body: Record<string, unknown>, provider = "openai") {
  return new Request(`https://gateway.test/api/v1/${provider}/${path.join("/")}`, {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function call(path: string[], body: Record<string, unknown>, provider = "openai") {
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
  readProvidersWithKeysMock.mockResolvedValue(["openai", "groq"]);
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify({
        id: "resp_1",
        object: "response",
        status: "completed",
        usage: { input_tokens: 37, output_tokens: 11, total_tokens: 48 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    )
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

const CHAT_OK = JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } });

describe("OpenAI hosted tools: priced ones pass, the rest are refused", () => {
  it("forwards a Responses web search and charges each web_search_call it reports", async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse(
        JSON.stringify({
          status: "completed",
          usage: { input_tokens: 37, output_tokens: 11, total_tokens: 48 },
          output: [{ type: "web_search_call", action: { type: "search" }, status: "completed" }, { type: "message" }],
        })
      )
    );
    const body = { model: "gpt-4.1", input: "hi", max_output_tokens: 64, tools: [{ type: "web_search" }] };
    const res = await call(["v1", "responses"], body);
    await res.text();
    await flushPending();
    expect(res.status).toBe(200);
    // No dollar limit here, so no cap is added.
    // The tools go out as sent; `service_tier: "auto"` is added so OpenAI reports the
    // tier it used (tests/openai-service-tier.test.ts).
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ ...body, service_tier: "auto" });
    const settled = settleHoldMock.mock.calls.at(-1)?.[0];
    expect(settled.microcents).toBeGreaterThanOrEqual(1_000_000);
  });

  it.each([
    ["Responses image_generation", ["v1", "responses"], { model: "gpt-4.1", input: "hi", tools: [{ type: "image_generation" }] }],
    ["Responses remote MCP", ["v1", "responses"], { model: "gpt-4.1", input: "hi", tools: [{ type: "mcp", server_label: "s", server_url: "https://x" }] }],
    ["a stored prompt", ["v1", "responses"], { model: "gpt-4.1", prompt: { id: "pmpt_1" } }],
    ["chat web_search_options", ["v1", "chat", "completions"], { model: "gpt-4.1", messages: [], web_search_options: {} }],
  ])("refuses %s with 400 before any reservation or provider contact", async (_name, path, body) => {
    const res = await call(path as string[], body);
    await flushPending();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "server_side_tools_unsupported" });
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    // Answered like invalid_body: a malformed request is not an audit row.
    expect(writeLogMock).not.toHaveBeenCalled();
  });

  it("forwards function tools unchanged", async () => {
    const body = { model: "gpt-4.1", input: "hi", max_output_tokens: 64, tools: [{ type: "function", name: "f", parameters: { type: "object" } }] };
    const res = await call(["v1", "responses"], body);
    await res.text();
    expect(res.status).toBe(200);
    // The tools go out as sent; `service_tier: "auto"` is added so OpenAI reports the
    // tier it used (tests/openai-service-tier.test.ts).
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ ...body, service_tier: "auto" });
  });

  it("refuses a search model as blocked_endpoint, and records it", async () => {
    const res = await call(["v1", "chat", "completions"], { model: "gpt-4o-search-preview", messages: [] });
    await flushPending();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_endpoint" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked_endpoint" }));
  });

  it("does not fail a groq call carrying web_search_options over to OpenAI", async () => {
    readFallbacksMock.mockResolvedValue([{ provider: "openai", model: "gpt-4.1" }]);
    fetchMock.mockImplementation(async () => jsonResponse('{"error":"overloaded"}', 503));
    const res = await call(
      ["v1", "chat", "completions"],
      { model: "llama-3.3-70b", messages: [], web_search_options: {} },
      "groq"
    );
    await res.text();
    await flushPending();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("api.groq.com");
  });

  it("does not fail over into an OpenAI search model", async () => {
    readFallbacksMock.mockResolvedValue([{ provider: "openai", model: "gpt-4o-search-preview" }]);
    fetchMock.mockImplementation(async () => jsonResponse('{"error":"overloaded"}', 503));
    const res = await call(["v1", "chat", "completions"], { model: "llama-3.3-70b", messages: [] }, "groq");
    await res.text();
    await flushPending();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("still fails a plain groq call over to OpenAI", async () => {
    readFallbacksMock.mockResolvedValue([{ provider: "openai", model: "gpt-4.1" }]);
    fetchMock
      .mockImplementationOnce(async () => jsonResponse('{"error":"overloaded"}', 503))
      .mockImplementationOnce(async () => jsonResponse(CHAT_OK));
    const res = await call(["v1", "chat", "completions"], { model: "llama-3.3-70b", messages: [] }, "groq");
    await res.text();
    await flushPending();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://api.openai.com/v1/chat/completions");
  });
});
