// Package 2, step 2+3: OpenAI embeddings through the governed proxy.
//
// What is under test is the proxy's choices: the embeddings estimate (no output
// reserved), the ceiling exemption, the stream refusal, and a response that is
// FORWARDED AS A STREAM with usage read from its top-level `usage` — never the
// buffered JSON path, which holds and re-serialises the whole body.
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

const EMBEDDINGS_BODY = JSON.stringify({
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: [0.01, -0.02, 0.03] }],
  model: "text-embedding-3-small",
  usage: { prompt_tokens: 12, total_tokens: 12 },
});

function jsonResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

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
    { provider: "openai", models: ["text-embedding-3-*", "gpt-4.1"] },
    { provider: "groq", models: ["llama-*"] },
    { provider: "anthropic", models: ["claude-*"] },
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
  readProvidersWithKeysMock.mockResolvedValue(["openai", "groq", "anthropic"]);
  fetchMock.mockImplementation(async () => jsonResponse(EMBEDDINGS_BODY));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const EMBED = { model: "text-embedding-3-small", input: "hello world" };

describe("governed OpenAI embeddings", () => {
  it.each([[["embeddings"]], [["v1", "embeddings"]]])(
    "governs POST /%s through reserve, key injection, reconciliation, log and receipt",
    async (path) => {
      const res = await call(path, EMBED);
      const text = await res.text();
      await flushPending();

      expect(res.status).toBe(200);
      expect(text).toBe(EMBEDDINGS_BODY);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(res.headers.get("x-passcontrol-receipt-id")).toEqual(expect.any(String));
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.openai.com/v1/embeddings",
        expect.objectContaining({ method: "POST" })
      );
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect((init.headers as Headers).get("authorization")).toBe("Bearer provider-key");
      // Forwarded as the client sent it: no stream_options injected.
      expect(JSON.parse(init.body as string)).toEqual(EMBED);
      expect(settleHoldMock).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "complete", tokens: 12 })
      );
      expect(writeLogMock).toHaveBeenCalledWith(
        expect.objectContaining({ inputTokens: 12, outputTokens: 0, status: "ok" })
      );
      expect(signReceiptMock).toHaveBeenCalledWith(
        expect.objectContaining({ inputTokens: 12, outputTokens: 0, status: "ok" })
      );
    }
  );

  it("reserves the input alone: no output tokens, priced at the embedding rate (E1)", async () => {
    await call(["v1", "embeddings"], EMBED);
    await flushPending();
    // "hello world" is 13 JSON characters → 4 tokens; $0.02/1M = 2 µ¢ per token.
    // The chat estimate would have added 1024 output tokens.
    expect(openHoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ estimate: 4, estimateMicrocents: 8 })
    );
  });

  it("counts toward a daily spend limit at the embedding price (K1)", async () => {
    readPolicyMock.mockResolvedValue({
      policy: {},
      shadow: null,
      budget: { known: true, tokens: null, cents: null },
      budgetState: { epoch: "epoch-1", established: true },
      period: { known: true, kind: "day", cents: 25 },
    });
    await call(["v1", "embeddings"], EMBED);
    await flushPending();
    expect(openHoldMock).toHaveBeenCalledWith(
      expect.objectContaining({
        estimate: 4,
        estimateMicrocents: 8,
        periodLimit: { mode: "set", kind: "day", capMicrocents: 25_000_000 },
      })
    );
  });

  it("refuses an embeddings call over its daily spend limit before provider contact", async () => {
    readPolicyMock.mockResolvedValue({
      policy: {},
      shadow: null,
      budget: { known: true, tokens: null, cents: null },
      budgetState: { epoch: "epoch-1", established: true },
      period: { known: true, kind: "day", cents: 0 },
    });
    openHoldMock.mockResolvedValueOnce({ ok: false, reason: "period" });
    const res = await call(["v1", "embeddings"], EMBED);
    await flushPending();
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "blocked_budget_period" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forwards the body as it arrives instead of waiting for all of it", async () => {
    let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    fetchMock.mockImplementationOnce(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            upstreamController = controller;
            controller.enqueue(encoder.encode('{"object":"list","data":['));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const res = await call(["v1", "embeddings"], EMBED);
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    // The rest of the body has not been sent yet; a buffering path could not
    // have produced this.
    expect(new TextDecoder().decode(first.value)).toBe('{"object":"list","data":[');

    upstreamController.enqueue(encoder.encode('],"usage":{"prompt_tokens":5,"total_tokens":5}}'));
    upstreamController.close();
    let rest = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toBe('],"usage":{"prompt_tokens":5,"total_tokens":5}}');
    await flushPending();
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 5, outputTokens: 0, status: "ok" })
    );
  });

  it.each([
    ["no usage", JSON.stringify({ object: "list", data: [] })],
    ["malformed usage", JSON.stringify({ object: "list", data: [], usage: { prompt_tokens: -1 } })],
    ["a cut-off body", '{"object":"list","usage":{"prompt_tokens":12},"data":['],
  ])("settles %s as usage_unknown, never as a known zero (E2)", async (_name, body) => {
    fetchMock.mockImplementationOnce(async () => jsonResponse(body));
    const res = await call(["v1", "embeddings"], EMBED);
    await res.text();
    await flushPending();
    expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "usage_unknown" }));
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "usage_unknown" }));
  });

  it("refuses stream: true before any reservation or provider contact", async () => {
    const res = await call(["v1", "embeddings"], { ...EMBED, stream: true });
    await flushPending();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "stream_unsupported" });
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    // Matches invalid_body: a malformed request is answered, not logged.
    expect(writeLogMock).not.toHaveBeenCalled();
  });

  it("admits an embeddings call from an agent with an output ceiling (E3)", async () => {
    readPolicyMock.mockResolvedValue({
      policy: { max_output_tokens: 30 },
      shadow: null,
      budget: { known: false },
    });
    const res = await call(["v1", "embeddings"], EMBED);
    await res.text();
    await flushPending();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("still checks the model against scope", async () => {
    const res = await call(["v1", "embeddings"], { ...EMBED, model: "text-embedding-ada-002" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_scope" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an embeddings call that names no model", async () => {
    const res = await call(["v1", "embeddings"], { input: "hi" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_scope" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["groq", "llama-3"],
    ["anthropic", "claude-x"],
  ])("refuses embeddings on %s, which has no embeddings row", async (provider, model) => {
    const res = await call(["v1", "embeddings"], { model, input: "hi" }, provider);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_endpoint" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fail an embeddings call over to a provider that cannot embed", async () => {
    readFallbacksMock.mockResolvedValue([{ provider: "groq", model: "llama-3" }]);
    fetchMock.mockImplementation(async () => jsonResponse('{"error":"overloaded"}', 503));
    const res = await call(["v1", "embeddings"], EMBED);
    await res.text();
    await flushPending();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/embeddings");
  });

  it("redacts the provider key when the provider echoes it, even split across chunks", async () => {
    const key = "sk-proj-Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z-EMBED_ECHO";
    getCachedKeyMock.mockResolvedValue(key);
    const encoder = new TextEncoder();
    const body = `{"object":"list","data":[],"note":"${key}","usage":{"prompt_tokens":3}}`;
    const splitAt = body.indexOf(key) + 10;
    fetchMock.mockImplementationOnce(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(body.slice(0, splitAt)));
            controller.enqueue(encoder.encode(body.slice(splitAt)));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const res = await call(["v1", "embeddings"], EMBED);
    const text = await res.text();
    await flushPending();
    expect(text).not.toContain(key);
    expect(text).not.toContain(key.slice(0, 20));
    // The usage after the redacted value is still read.
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 3, status: "ok" }));
  });
});

// Mistral's embeddings response (docs.mistral.ai/api/endpoint/embeddings, read
// 2026-09-27): `usage` is required and carries `prompt_tokens`,
// `completion_tokens` and `total_tokens` (plus `prompt_audio_seconds`).
const MISTRAL_EMBEDDINGS_BODY = JSON.stringify({
  id: "embd-1",
  object: "list",
  data: [{ object: "embedding", index: 0, embedding: [0.01, -0.02, 0.03] }],
  model: "mistral-embed",
  usage: { prompt_tokens: 9, completion_tokens: 0, total_tokens: 9, prompt_audio_seconds: null },
});

describe("governed Mistral embeddings", () => {
  beforeEach(() => {
    verifyVisaMock.mockResolvedValue({
      ...claims,
      scope: [...claims.scope, { provider: "mistral", models: ["mistral-embed*", "codestral-embed*"] }],
    });
    fetchMock.mockImplementation(async () => jsonResponse(MISTRAL_EMBEDDINGS_BODY));
  });

  it.each([[["embeddings"]], [["v1", "embeddings"]]])(
    "governs POST /%s at api.mistral.ai/v1/embeddings and settles on the reported tokens",
    async (path) => {
      const body = { model: "mistral-embed", input: ["hello world"], output_dtype: "float" };
      const res = await call(path, body, "mistral");
      const text = await res.text();
      await flushPending();

      expect(res.status).toBe(200);
      expect(text).toBe(MISTRAL_EMBEDDINGS_BODY);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.mistral.ai/v1/embeddings",
        expect.objectContaining({ method: "POST" })
      );
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(init.body as string)).toEqual(body);
      expect(settleHoldMock).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "complete", tokens: 9 })
      );
      expect(writeLogMock).toHaveBeenCalledWith(
        expect.objectContaining({ inputTokens: 9, outputTokens: 0, status: "ok" })
      );
    }
  );

  it("reserves input only, at Mistral Embed's rate", async () => {
    await call(["v1", "embeddings"], { model: "mistral-embed", input: "hello world" }, "mistral");
    await flushPending();
    // 13 JSON characters → 4 tokens; $0.1/1M = 10 µ¢ per token.
    expect(openHoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ estimate: 4, estimateMicrocents: 40 })
    );
  });

  it("refuses Together embeddings before anything is reserved or sent", async () => {
    verifyVisaMock.mockResolvedValue({
      ...claims,
      scope: [...claims.scope, { provider: "together", models: ["*"] }],
    });
    const res = await call(["v1", "embeddings"], { model: "BAAI/bge-large-en-v1.5", input: "hi" }, "together");
    await flushPending();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(expect.objectContaining({ error: "blocked_endpoint" }));
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// A fallback runs with ITS OWN model. For chat that trades one answer for
// another; for embeddings it returns vectors from a different model — a
// different space, usually a different size — with a 200, so an index built on
// the primary model is silently corrupted. An embeddings call therefore never
// fails over: the primary's own result reaches the agent.
describe("embeddings never fail over", () => {
  const FAILED = () => jsonResponse(JSON.stringify({ error: { message: "overloaded" } }), 503);

  it.each([
    ["another OpenAI embedding model", { provider: "openai", model: "text-embedding-3-large" }],
    ["Mistral's embedding model", { provider: "mistral", model: "mistral-embed" }],
  ])("does not try %s after the primary fails", async (_name, fallback) => {
    verifyVisaMock.mockResolvedValue({
      ...claims,
      scope: [...claims.scope, { provider: "mistral", models: ["mistral-embed*"] }],
    });
    readProvidersWithKeysMock.mockResolvedValue(["openai", "mistral"]);

    fetchMock.mockImplementation(async () => FAILED());
    readFallbacksMock.mockResolvedValue([]);
    const baseline = await call(["v1", "embeddings"], EMBED);
    const baselineBody = await baseline.text();
    await flushPending();
    const baselineFetches = fetchMock.mock.calls.length;
    expect(baselineFetches).toBe(1);

    fetchMock.mockClear();
    fetchMock.mockImplementation(async () =>
      fetchMock.mock.calls.length === 1 ? FAILED() : jsonResponse(MISTRAL_EMBEDDINGS_BODY)
    );
    readFallbacksMock.mockResolvedValue([fallback]);
    const res = await call(["v1", "embeddings"], EMBED);
    const body = await res.text();
    await flushPending();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/embeddings");
    expect(res.status).toBe(baseline.status);
    expect(body).toBe(baselineBody);
  });

  it("still fails a chat call over, so the rule is about embeddings only", async () => {
    let n = 0;
    fetchMock.mockImplementation(async () =>
      ++n === 1
        ? FAILED()
        : jsonResponse(
            JSON.stringify({
              id: "c",
              object: "chat.completion",
              model: "llama-3.3-70b",
              choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
            })
          )
    );
    readFallbacksMock.mockResolvedValue([{ provider: "groq", model: "llama-3.3-70b" }]);
    const res = await call(["v1", "chat", "completions"], {
      model: "gpt-4.1",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 5,
    });
    await res.text();
    await flushPending();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });
});
