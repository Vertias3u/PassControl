// A cached Anthropic call, end to end through the proxy.
//
// Anthropic reports a cached prompt across three fields, and `input_tokens` is
// only the UNCACHED remainder. An agent with an 18k-token cached prefix — which
// is every serious coding agent, since prompt caching is how they stay
// affordable — therefore reports `input_tokens: 12` for a call that really
// consumed ~18k. The proxy read only that field, so:
//
//   * a token budget under-counted by three orders of magnitude, and the cap an
//     operator set in the dashboard did not hold;
//   * the recorded cost was a fraction of the real Anthropic bill;
//   * and because `reconcile_agent_spend` recomputes authoritative spend from
//     `agent_logs.input_tokens + output_tokens`, the under-count was permanent,
//     not merely late.
//
// These cases sit at the ROUTE because the arithmetic is only wrong once it
// reaches the budget and the audit row. They also pin the deliberate split
// between what the receipt records and what the log row records — see the
// comments in the proxy's reconcile().
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
import { costMicrocentsForUsage } from "@/lib/pricing";

const MODEL = "claude-opus-4-5";

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
  scope: [{ provider: "anthropic", models: [MODEL] }],
};

// A steady-state cached call: a large cached prefix, a tiny new question.
const CACHED = { input: 12, cacheRead: 18_000, cacheWrite: 1_200, output: 200 };
const TOTAL_TOKENS = CACHED.input + CACHED.output + CACHED.cacheRead + CACHED.cacheWrite;
const FOLDED_INPUT = CACHED.input + CACHED.cacheRead + CACHED.cacheWrite;
const EXPECTED_COST = costMicrocentsForUsage(
  {
    inputTokens: CACHED.input,
    outputTokens: CACHED.output,
    cacheReadTokens: CACHED.cacheRead,
    cacheWriteTokens: CACHED.cacheWrite,
  },
  MODEL,
  "anthropic"
);

async function callProxy(stream: boolean) {
  const req = new Request("https://gateway.test/api/v1/anthropic/v1/messages", {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      ...(stream ? { stream: true } : {}),
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  return POST(req, {
    params: Promise.resolve({ provider: "anthropic", path: ["v1", "messages"] }),
  });
}

function anthropicJson() {
  return new Response(
    JSON.stringify({
      usage: {
        input_tokens: CACHED.input,
        cache_read_input_tokens: CACHED.cacheRead,
        cache_creation_input_tokens: CACHED.cacheWrite,
        output_tokens: CACHED.output,
      },
      content: [{ type: "text", text: "hello" }],
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function anthropicStream() {
  const enc = new TextEncoder();
  const chunks = [
    `data: {"type":"message_start","message":{"usage":{"input_tokens":${CACHED.input},"cache_read_input_tokens":${CACHED.cacheRead},"cache_creation_input_tokens":${CACHED.cacheWrite},"output_tokens":1}}}\n\n`,
    `data: {"type":"message_delta","usage":{"output_tokens":${CACHED.output}}}\n\n`,
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } }
  );
}

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

describe.each([
  ["buffered", anthropicJson],
  ["streamed", anthropicStream],
])("a cached Anthropic call (%s)", (_label, upstream) => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(upstream());
  });

  it("keeps a truthful linked row when settlement fails before Redis executes", async () => {
    settleHoldMock.mockRejectedValue(new Error("transport unavailable before execution"));
    await drain(await callProxy(upstream === anthropicStream));
    await flushDeferred();
    const row = writeLogMock.mock.calls[0]?.[0];
    expect(row.attemptId).toEqual(expect.any(String));
    expect(row.attemptId).toBe(openHoldMock.mock.calls[0]?.[0]?.attemptId);
    expect(row.enforcedTokens).toBeUndefined();
    expect(row.enforcedMicrocents).toBeUndefined();
    expect(row.inputTokens + row.outputTokens).toBe(TOTAL_TOKENS);
    expect(row.costMicrocents).toBe(EXPECTED_COST);
  });

  it.each(["conflict", "anomaly"] as const)(
    "does not turn a %s settlement into a free ledger row",
    async (reason) => {
      settleHoldMock.mockResolvedValue({
        applied: false, appliedTokens: 0, appliedMicrocents: 0, [reason]: true,
      });
      await drain(await callProxy(upstream === anthropicStream));
      await flushDeferred();

      expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({
        outcome: expect.stringMatching(/^(complete|usage_unknown)$/),
        tokens: TOTAL_TOKENS, microcents: EXPECTED_COST,
      }));
      const row = writeLogMock.mock.calls[0]?.[0];
      expect(row).toMatchObject({
        status: expect.stringMatching(/^(ok|usage_unknown)$/), costMicrocents: EXPECTED_COST,
      });
      expect(row.inputTokens + row.outputTokens).toBe(TOTAL_TOKENS);
      // Migration 0055 reads COALESCE(enforced, observed). A refused or
      // missing settlement cannot certify that this provider call was free.
      // Assert the spend readers' result without prescribing a repair shape.
      expect.soft(row.enforcedTokens ?? row.inputTokens + row.outputTokens).toBe(TOTAL_TOKENS);
      expect.soft(row.enforcedMicrocents ?? row.costMicrocents).toBe(EXPECTED_COST);
    }
  );

  it("charges the budget for every token the prompt consumed, not just the uncached remainder", async () => {
    await drain(await callProxy(upstream === anthropicStream));
    await flushDeferred();

    expect(settleHoldMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-id",
        tokens: TOTAL_TOKENS, // 19,412 — not 212
      })
    );
    // The bug in one assertion: the old figure would have been the input+output
    // pair alone, which is a rounding error against the real consumption.
    const call = settleHoldMock.mock.calls[0]?.[0];
    expect(call.tokens).toBeGreaterThan((CACHED.input + CACHED.output) * 90);
  });

  it("charges the cost of the cache traffic too", async () => {
    await drain(await callProxy(upstream === anthropicStream));
    await flushDeferred();

    expect(settleHoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ microcents: EXPECTED_COST })
    );
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ costMicrocents: EXPECTED_COST })
    );
  });

  // The audit row FOLDS, because reconcile_agent_spend sums
  // `input_tokens + output_tokens` and has no cache column to read. Splitting
  // here would drop the cache tokens back out of authoritative spend at the next
  // cron and quietly re-open the whole bug.
  it("folds the cache tokens into the audit row's input_tokens", async () => {
    await drain(await callProxy(upstream === anthropicStream));
    await flushDeferred();

    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: FOLDED_INPUT, // 19,212
        outputTokens: CACHED.output,
      })
    );
    // What the spend checkpoint will compute from this row.
    const row = writeLogMock.mock.calls[0]?.[0];
    expect(row.inputTokens + row.outputTokens).toBe(TOTAL_TOKENS);
  });

  // The link migration 0056 rests on. Without it in the audit row, an operator
  // recovering an abandoned attempt has nothing to collide with, and the insert
  // that is supposed to bounce lands instead — charging the same attempt twice.
  // An id that is merely PRESENT is not enough; it has to be this attempt's.
  it("stamps the audit row with the attempt id the hold was opened under", async () => {
    await drain(await callProxy(upstream === anthropicStream));
    await flushDeferred();

    const opened = openHoldMock.mock.calls[0]?.[0]?.attemptId;
    expect(opened).toBeTruthy();
    expect(writeLogMock.mock.calls[0]?.[0]?.attemptId).toBe(opened);
  });

  it("mirrors the same total to the dashboard, so the two cannot disagree", async () => {
    await drain(await callProxy(upstream === anthropicStream));
    await flushDeferred();

    expect(mirrorSpendMock).toHaveBeenCalledWith("agent-id", TOTAL_TOKENS, EXPECTED_COST);
  });
});

describe("an uncached call is unaffected", () => {
  it("still records exactly input and output", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ usage: { input_tokens: 900, output_tokens: 100 }, content: [] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await drain(await callProxy(false));
    await flushDeferred();

    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 900, outputTokens: 100 })
    );
    expect(settleHoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ tokens: 1_000 })
    );
    expect(mirrorSpendMock).toHaveBeenCalledWith("agent-id", 1_000, expect.any(Number));
  });
});


describe("Session 02 — genuine zero discovery accounting", () => {
  it("logs measured zero for discovery even when settlement never executes", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    settleHoldMock.mockRejectedValue(new Error("transport unavailable before execution"));
    const res = await GET(new Request("https://gateway.test/api/v1/anthropic/v1/models", {
      method: "GET", headers: { authorization: "Bearer visa" },
    }), { params: Promise.resolve({ provider: "anthropic", path: ["v1", "models"] }) });
    expect(res.status).toBe(200);
    await drain(res);
    await flushDeferred();
    expect(settleHoldMock).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "complete", tokens: 0, microcents: 0,
    }));
    const row = writeLogMock.mock.calls[0]?.[0];
    expect(row).toMatchObject({ status: "ok", inputTokens: 0, outputTokens: 0, costMicrocents: 0 });
    expect(row.enforcedTokens).toBeUndefined();
    expect(row.enforcedMicrocents).toBeUndefined();
    expect(row.attemptId).toEqual(expect.any(String));
    expect(row.attemptId).toBe(openHoldMock.mock.calls[0]?.[0]?.attemptId);
  });
});
