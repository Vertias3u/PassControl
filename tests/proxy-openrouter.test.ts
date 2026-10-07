// 1.3.0 #4: OpenRouter through the governed proxy (plans/openrouter.md; DECISIONS
// 2026-10-07, OpenRouter). The hold is priced at the model's dearest endpoint from
// OpenRouter's own listing, the same rates go out as `provider.max_price`, the charge
// is the cost OpenRouter reports, and PassControl's attribution headers replace the
// client's. Upstream and the listing are mocks here; the live check is in TEAMSHARE.
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
  priceCache,
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
  priceCache: new Map<string, string>(),
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
  // OpenRouter's price cache (lib/providers/openrouter-price.ts), as a Map.
  redis: () => ({
    get: async (key: string) => priceCache.get(key) ?? null,
    set: async (key: string, value: string) => {
      priceCache.set(key, value);
      return "OK";
    },
  }),
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
import llama from "./fixtures/openrouter/meta-llama_llama-3.3-70b-instruct.endpoints.json";

function jsonResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

const LLAMA = "meta-llama/llama-3.3-70b-instruct";
const LISTING_URL = `https://openrouter.ai/api/v1/models/${LLAMA}/endpoints`;
const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

const USAGE = {
  prompt_tokens: 20,
  completion_tokens: 5,
  total_tokens: 25,
  cost: 0.0000123,
  is_byok: false,
  prompt_tokens_details: { cached_tokens: 0 },
  cost_details: { upstream_inference_cost: null },
};
const COMPLETION = JSON.stringify({
  id: "gen-1",
  object: "chat.completion",
  model: LLAMA,
  provider: "DeepInfra",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: USAGE,
});

const claims = {
  sub: "passport-id",
  agid: "agent-id",
  uid: "user-id",
  jti: "jti-1",
  bt: 100_000,
  bc: null as number | null,
  st: 0,
  sc: 0,
  ver: 1,
  scope: [
    { provider: "openrouter", models: ["meta-llama/*", "openrouter/*", "openai/*", "~openai/*"] },
  ],
};

function request(path: string[], body: Record<string, unknown> | null, method = "POST", headers: Record<string, string> = {}) {
  return new Request(`https://gateway.test/api/v1/openrouter/${path.join("/")}`, {
    method,
    headers: { authorization: "Bearer visa", "content-type": "application/json", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function call(body: Record<string, unknown>, opts: { bc?: number | null; headers?: Record<string, string> } = {}) {
  verifyVisaMock.mockResolvedValue({ ...claims, bc: opts.bc ?? null });
  const path = ["v1", "chat", "completions"];
  return POST(request(path, body, "POST", opts.headers), { params: Promise.resolve({ provider: "openrouter", path }) });
}

async function flushPending() {
  for (;;) {
    const batch = pending.splice(0);
    if (batch.length === 0) return;
    await Promise.all(batch);
  }
}

function upstreamCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url) === CHAT_URL);
}
function listingCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/endpoints"));
}
function forwarded() {
  const init = upstreamCalls()[0]?.[1] as RequestInit;
  return { body: JSON.parse(init.body as string), headers: init.headers as Headers };
}

beforeEach(() => {
  pending.length = 0;
  priceCache.clear();
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
  getCachedKeyMock.mockResolvedValue("sk-or-v1-provider-key");
  readKillStateMock.mockResolvedValue({ platformKill: false, tenantKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  readPolicyMock.mockResolvedValue({ policy: {}, shadow: null, budget: { known: false } });
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  signReceiptMock.mockReturnValue("signed-receipt");
  readFallbacksMock.mockResolvedValue([]);
  readProvidersWithKeysMock.mockResolvedValue(["openrouter"]);
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url) === LISTING_URL) return jsonResponse(JSON.stringify({ data: llama }));
    if (String(url).includes("/endpoints")) return jsonResponse(JSON.stringify({ data: { endpoints: [] } }));
    return jsonResponse(COMPLETION);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ASK = { model: LLAMA, messages: [{ role: "user", content: "hi" }], max_tokens: 100 };

describe("an OpenRouter call", () => {
  it("goes to openrouter.ai with the key, PassControl's attribution, and is charged OpenRouter's reported cost", async () => {
    const res = await call(ASK, {
      headers: { "http-referer": "https://client.example", "x-title": "ClientApp" },
    });
    expect(res.status).toBe(200);
    await res.text();
    await flushPending();

    const { body, headers } = forwarded();
    expect(headers.get("authorization")).toBe("Bearer sk-or-v1-provider-key");
    expect(headers.get("http-referer")).toBe("https://github.com/Vertias3u/PassControl");
    expect(headers.get("x-title")).toBe("PassControl");
    expect(body.model).toBe(LLAMA);
    // 0.0000123 USD = 1230 µ¢.
    expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "complete", tokens: 25, microcents: 1230 }));
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 20, outputTokens: 5, status: "ok" }));
  });

  it("with no dollar limit injects no ceiling, but still prices the hold", async () => {
    const res = await call(ASK);
    await res.text();
    await flushPending();
    expect(listingCalls()).toHaveLength(1);
    expect(forwarded().body.provider).toBeUndefined();
    const hold = openHoldMock.mock.calls[0]?.[0] as { estimateMicrocents: number };
    expect(hold.estimateMicrocents).toBeGreaterThanOrEqual(100 * 226);
  });

  // Every other provider charges its estimate when a call ends without a usage report.
  // An OpenRouter call with no dollar limit used to reserve 0 µ¢, so the same ending
  // recorded a priced $0 for a call OpenRouter may well have billed.
  it("with no dollar limit, a call that reports no cost keeps a priced estimate, not $0", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url) === LISTING_URL) return jsonResponse(JSON.stringify({ data: llama }));
      return new Response(
        `data: ${JSON.stringify({ id: "gen-1", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: "gen-1", error: { code: 502, message: "Provider returned error" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] })}\n\n` +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });
    const res = await call({ ...ASK, stream: true });
    await res.text();
    await flushPending();
    const hold = openHoldMock.mock.calls[0]?.[0] as { estimateMicrocents: number };
    expect(hold.estimateMicrocents).toBeGreaterThan(0);
    expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "usage_unknown" }));
  });

  it("with no dollar limit, an unreadable listing does not refuse the call", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/endpoints")) throw new TypeError("network down");
      return jsonResponse(COMPLETION);
    });
    const res = await call(ASK);
    expect(res.status).toBe(200);
    await res.text();
    expect(upstreamCalls()).toHaveLength(1);
  });
});

describe("under a dollar limit", () => {
  it("holds at the dearest endpoint and sends that ceiling as max_price", async () => {
    const res = await call(ASK, { bc: 500 });
    expect(res.status).toBe(200);
    await res.text();
    await flushPending();

    expect(listingCalls()).toHaveLength(1);
    expect(forwarded().body.provider).toEqual({ max_price: { prompt: 1.04, completion: 2.26 } });
    const hold = openHoldMock.mock.calls[0]?.[0] as { estimateMicrocents: number; estimate: number };
    // Dearest endpoint: 104 µ¢ in, 226 µ¢ out (ceil of $2.253/M), max_tokens 100.
    expect(hold.estimateMicrocents).toBeGreaterThanOrEqual(100 * 226);
    expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "complete", microcents: 1230 }));
  });

  it("keeps a lower max_price the client set", async () => {
    const res = await call({ ...ASK, provider: { order: ["DeepInfra"], max_price: { prompt: 0.2 } } }, { bc: 500 });
    await res.text();
    expect(forwarded().body.provider).toEqual({ order: ["DeepInfra"], max_price: { prompt: 0.2, completion: 2.26 } });
  });

  it("caches the price: the second call reads no listing", async () => {
    await (await call(ASK, { bc: 500 })).text();
    await (await call(ASK, { bc: 500 })).text();
    expect(listingCalls()).toHaveLength(1);
  });

  it("refuses 402 unpriced_model a model the listing cannot price, and sends nothing", async () => {
    const res = await call({ ...ASK, model: "~openai/gpt-luna-latest" }, { bc: 500 });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "unpriced_model" });
    await flushPending();
    expect(upstreamCalls()).toHaveLength(0);
    expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "not_dispatched" }));
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked_unpriced_model" }));
  });

  it("refuses when the listing cannot be read at all", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/endpoints")) throw new TypeError("network down");
      return jsonResponse(COMPLETION);
    });
    const res = await call(ASK, { bc: 500 });
    expect(res.status).toBe(402);
    expect(upstreamCalls()).toHaveLength(0);
  });

  it("prices the free router at zero without a lookup", async () => {
    const res = await call({ ...ASK, model: "openrouter/free" }, { bc: 500 });
    expect(res.status).toBe(200);
    await res.text();
    expect(listingCalls()).toHaveLength(0);
    expect(forwarded().body.provider).toEqual({ max_price: { prompt: 0, completion: 0 } });
  });

  it("keeps the hold when the response reported no cost", async () => {
    const { cost: _c, ...noCost } = USAGE;
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url) === LISTING_URL) return jsonResponse(JSON.stringify({ data: llama }));
      return jsonResponse(JSON.stringify({ ...JSON.parse(COMPLETION), usage: noCost }));
    });
    const res = await call(ASK, { bc: 500 });
    await res.text();
    await flushPending();
    expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "usage_unknown" }));
  });
});

describe("refused before anything is held or sent", () => {
  it.each([
    [{ models: ["openai/gpt-5"] }, "models"],
    [{ route: "fallback" }, "route"],
    [{ preset: "@preset/mine" }, "preset"],
    [{ debug: { echo_upstream_body: true } }, "debug"],
  ])("400 model_selection_unsupported for %j", async (extra, field) => {
    const res = await call({ ...ASK, ...extra });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "model_selection_unsupported", field });
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([["openrouter/auto"], [`${LLAMA}@preset/mine`]])("403 blocked_endpoint for the router %s, though in scope", async (model) => {
    const res = await call({ ...ASK, model });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "blocked_endpoint" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("400 for OpenRouter's own server tools and plugins", async () => {
    for (const extra of [{ tools: [{ type: "openrouter:web_search" }] }, { plugins: [{ id: "web" }] }]) {
      const res = await call({ ...ASK, ...extra });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "server_side_tools_unsupported" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403 for the :online suffix", async () => {
    const res = await call({ ...ASK, model: "openai/gpt-5-mini:online" });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403 for a management endpoint", async () => {
    verifyVisaMock.mockResolvedValue(claims);
    const path = ["v1", "keys"];
    const res = await POST(request(path, { name: "new" }), { params: Promise.resolve({ provider: "openrouter", path }) });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("OpenRouter's failure shapes", () => {
  it("is out of credits on 402", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(JSON.stringify({ error: { code: 402, message: "Insufficient credits. Add more using https://openrouter.ai/credits" } }), 402)
    );
    const res = await call(ASK);
    await res.text();
    await flushPending();
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "provider_exhausted" }));
  });

  it("keeps the hold on a stream that ended on an error chunk", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(
        ": OPENROUTER PROCESSING\n\n" +
          `data: ${JSON.stringify({ id: "gen-1", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ id: "gen-1", error: { code: 502, message: "Provider returned error" }, choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }] })}\n\n` +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    );
    const res = await call({ ...ASK, stream: true });
    await res.text();
    await flushPending();
    expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "usage_unknown" }));
  });

  it("charges a streamed call its reported cost", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(
        ": OPENROUTER PROCESSING\n\n" +
          `data: ${JSON.stringify({ id: "gen-1", choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: "stop" }] })}\n\n` +
          `data: ${JSON.stringify({ id: "gen-1", choices: [], usage: USAGE })}\n\n` +
          "data: [DONE]\n\n",
        { status: 200, headers: { "content-type": "text/event-stream" } }
      )
    );
    const res = await call({ ...ASK, stream: true });
    await res.text();
    await flushPending();
    expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "complete", tokens: 25, microcents: 1230 }));
  });
});
