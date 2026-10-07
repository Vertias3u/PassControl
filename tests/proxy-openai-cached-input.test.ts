// A cached OpenAI call, end to end through the proxy (owner, 2026-10-07).
//
// OpenAI's input count already INCLUDES the tokens it served from its prompt
// cache (`prompt_tokens_details.cached_tokens` on Chat Completions,
// `input_tokens_details.cached_tokens` on Responses), and it bills those at a
// tenth of the input rate or less. They were charged at the full rate. A coding
// agent resends its whole conversation every turn, so its turns are mostly cache:
// live, a Codex turn of 15,525 input tokens had 14,592 cached, and the recorded
// cost was several times OpenAI's bill.
//
// The cached count is a pricing input only. The token budget, the audit row's
// input_tokens and the receipt still count every token the prompt consumed.
import { beforeEach, describe, expect, it, vi } from "vitest";
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
} = vi.hoisted(() => ({
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
}));

// Collected, not discarded: the reconcile and the audit row both happen inside a
// waitUntil after the response is already committed, so a no-op mock would make
// every assertion here unreachable.
const deferred: Promise<unknown>[] = [];
// The proxy now reaches lib/demo/identity.ts to tell the seeded PUBLIC demo
// passport apart from a tenant that holds a demo scope. That module is
// `server-only`, which Next enforces at build time and vitest cannot resolve
// at all — same stub tests/site-demo-routes.test.ts already uses.
// The Cloud allowance resolver sits on the enforcement path and fails CLOSED, so
// an unmocked one refuses every request here with a 503 instead of exercising
// what this file is about.
vi.mock("server-only", () => ({}));
vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => {
    deferred.push(Promise.resolve(p));
  },
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
vi.mock("@/lib/crypto/aesgcm", () => ({
  seal: async () => "sealed",
  open: async (v: string) => v,
}));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...args: unknown[]) => rateLimitMock(...args) }));
vi.mock("@/lib/providers/available", () => ({
  readProvidersWithKeys: (...args: unknown[]) => readProvidersWithKeysMock(...args),
}));

import { GET, POST } from "@/app/api/v1/[provider]/[...path]/route";

const MODEL = "gpt-5-mini";

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
  scope: [{ provider: "openai", models: [MODEL] }],
};

// Turn 2 of the live Codex session (relay capture, 2026-10-07).
const CALL = { input: 15_525, cached: 14_592, output: 107 };
// gpt-5-mini: $0.25 in, $0.025 cached ($0.025/M rounds up to 3 µ¢), $2 out.
const EXPECTED_COST = (CALL.input - CALL.cached) * 25 + CALL.cached * 3 + CALL.output * 200; // 88,501
const FULL_RATE_COST = CALL.input * 25 + CALL.output * 200; // 409,525, the old charge

async function callProxy(api: "chat" | "responses", stream: boolean) {
  const path = api === "chat" ? ["v1", "chat", "completions"] : ["v1", "responses"];
  const body =
    api === "chat"
      ? { model: MODEL, max_completion_tokens: 1024, ...(stream ? { stream: true } : {}), messages: [{ role: "user", content: "hi" }] }
      : { model: MODEL, max_output_tokens: 1024, ...(stream ? { stream: true } : {}), input: "hi" };
  const req = new Request(`https://gateway.test/api/v1/openai/${path.join("/")}`, {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return POST(req, { params: Promise.resolve({ provider: "openai", path }) });
}

const chatUsage = {
  prompt_tokens: CALL.input,
  completion_tokens: CALL.output,
  total_tokens: CALL.input + CALL.output,
  prompt_tokens_details: { cached_tokens: CALL.cached },
};
const responsesUsage = {
  input_tokens: CALL.input,
  input_tokens_details: { cache_write_tokens: 0, cached_tokens: CALL.cached },
  output_tokens: CALL.output,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: CALL.input + CALL.output,
};

const json = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

function sse(events: unknown[], done: boolean) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        if (done) controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } }
  );
}

const completedResponse = { id: "resp_1", status: "completed", output: [], usage: responsesUsage };

const UPSTREAMS = {
  "chat, buffered": { api: "chat", stream: false, make: () => json({ choices: [{ finish_reason: "stop" }], usage: chatUsage }) },
  "chat, streamed": {
    api: "chat",
    stream: true,
    make: () => sse([{ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }, { choices: [], usage: chatUsage }], true),
  },
  "responses, buffered": { api: "responses", stream: false, make: () => json(completedResponse) },
  "responses, streamed": {
    api: "responses",
    stream: true,
    make: () => sse([{ type: "response.completed", response: completedResponse }], false),
  },
} as const;

async function drain(res: Response) {
  if (!res.body) return;
  const reader = res.body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

async function flushDeferred() {
  for (let i = 0; i < 5 && deferred.length; i++) {
    const pending = deferred.splice(0, deferred.length);
    await Promise.all(pending.map((p) => p.catch(() => undefined)));
  }
}

beforeEach(() => {
  deferred.length = 0;
  for (const m of [
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
  ]) {
    m.mockReset();
  }
  readProvidersWithKeysMock.mockResolvedValue([]);
  verifyVisaMock.mockResolvedValue(baseClaims);
  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
  });
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1_000 });
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

describe.each(Object.entries(UPSTREAMS))("a cached OpenAI call (%s)", (_label, upstream) => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(upstream.make());
  });

  it("charges the cached part of the input at OpenAI's cached rate", async () => {
    await drain(await callProxy(upstream.api, upstream.stream));
    await flushDeferred();

    expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "complete", microcents: EXPECTED_COST }));
    const row = writeLogMock.mock.calls[0]?.[0];
    expect(row.costMicrocents).toBe(EXPECTED_COST);
    expect(row.costMicrocents).toBeLessThan(FULL_RATE_COST / 4);
    expect(mirrorSpendMock).toHaveBeenCalledWith("agent-id", CALL.input + CALL.output, EXPECTED_COST);
  });

  it("still counts every input token against the token budget and in the audit row", async () => {
    await drain(await callProxy(upstream.api, upstream.stream));
    await flushDeferred();

    expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ tokens: CALL.input + CALL.output }));
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: CALL.input, outputTokens: CALL.output }));
  });
});

describe("a call with no cache report", () => {
  it("is charged at the full input rate, as before", async () => {
    const { prompt_tokens_details: _, ...plain } = chatUsage;
    fetchMock.mockResolvedValue(json({ choices: [{ finish_reason: "stop" }], usage: plain }));
    await drain(await callProxy("chat", false));
    await flushDeferred();
    expect(writeLogMock.mock.calls[0]?.[0]?.costMicrocents).toBe(FULL_RATE_COST);
  });
});

// GPT-6 / GPT-5.6 settle at the context tier OpenAI billed (tests/openai-context-tiers.test.ts):
// short-context rates for a standard-tier call under 272K input, though the hold
// stays at the long-context rates.
describe("a gpt-6-sol Responses call under 272K input, standard tier", () => {
  const SOL = { input: 16_235, cached: 15_872, output: 1_059 };
  const solResponse = (service_tier: string | undefined) => ({
    id: "resp_2",
    status: "completed",
    ...(service_tier ? { service_tier } : {}),
    output: [],
    usage: {
      input_tokens: SOL.input,
      input_tokens_details: { cache_write_tokens: 0, cached_tokens: SOL.cached },
      output_tokens: SOL.output,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: SOL.input + SOL.output,
    },
  });
  const solCall = async () =>
    POST(
      new Request("https://gateway.test/api/v1/openai/v1/responses", {
        method: "POST",
        headers: { authorization: "Bearer visa", "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-6-sol", max_output_tokens: 2048, stream: true, input: "hi" }),
      }),
      { params: Promise.resolve({ provider: "openai", path: ["v1", "responses"] }) }
    );

  beforeEach(() => {
    verifyVisaMock.mockResolvedValue({ ...baseClaims, scope: [{ provider: "openai", models: ["gpt-6-sol"] }] });
  });

  it("settles at the short-context rates", async () => {
    fetchMock.mockResolvedValue(sse([{ type: "response.completed", response: solResponse("default") }], false));
    await drain(await solCall());
    await flushDeferred();
    const expected = 363 * 200 + SOL.cached * 20 + SOL.output * 1_000; // 1,449,040
    expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "complete", microcents: expected, tokens: SOL.input + SOL.output }));
    expect(writeLogMock.mock.calls[0]?.[0]).toMatchObject({ costMicrocents: expected, inputTokens: SOL.input });
  });

  it("stays at the long-context rates when the response states no tier", async () => {
    fetchMock.mockResolvedValue(sse([{ type: "response.completed", response: solResponse(undefined) }], false));
    await drain(await solCall());
    await flushDeferred();
    expect(writeLogMock.mock.calls[0]?.[0]?.costMicrocents).toBe(363 * 500 + SOL.cached * 40 + SOL.output * 1_500);
  });
});

// The forwarded body carries `service_tier: "auto"` when the client set none, so
// OpenAI reports the tier it used (tests/openai-service-tier.test.ts).
describe("the tier OpenAI is asked to report", () => {
  const sentBody = () => JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"));

  it.each(["chat", "responses"] as const)("is requested on a %s call that names none", async (api) => {
    fetchMock.mockResolvedValue(api === "chat" ? json({ choices: [{ finish_reason: "stop" }], usage: chatUsage }) : json(completedResponse));
    await drain(await callProxy(api, false));
    await flushDeferred();
    expect(sentBody().service_tier).toBe("auto");
  });

  it("is the client's own when it names one", async () => {
    fetchMock.mockResolvedValue(json(completedResponse));
    const req = new Request("https://gateway.test/api/v1/openai/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer visa", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_output_tokens: 64, input: "hi", service_tier: "flex" }),
    });
    await drain(await POST(req, { params: Promise.resolve({ provider: "openai", path: ["v1", "responses"] }) }));
    await flushDeferred();
    expect(sentBody().service_tier).toBe("flex");
  });
});
