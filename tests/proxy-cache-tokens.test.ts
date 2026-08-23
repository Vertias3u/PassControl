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

const {
  verifyVisaMock,
  serviceClientMock,
  reserveBudgetMock,
  reconcileBudgetMock,
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
  reserveBudgetMock: vi.fn(),
  reconcileBudgetMock: vi.fn(),
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
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  reserveBudget: (...args: unknown[]) => reserveBudgetMock(...args),
  reconcileBudget: (...args: unknown[]) => reconcileBudgetMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
  setCachedKey: (...args: unknown[]) => setCachedKeyMock(...args),
  getCachedAgentPolicy: (...args: unknown[]) => getCachedAgentPolicyMock(...args),
  setCachedAgentPolicy: (...args: unknown[]) => setCachedAgentPolicyMock(...args),
  seedSpent: vi.fn(),
}));
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

import { POST } from "@/app/api/v1/[provider]/[...path]/route";
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
    reserveBudgetMock,
    reconcileBudgetMock,
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
  reserveBudgetMock.mockResolvedValue({ ok: true, reserved: 1_000 });
  reconcileBudgetMock.mockResolvedValue(undefined);
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

  it("charges the budget for every token the prompt consumed, not just the uncached remainder", async () => {
    await drain(await callProxy(upstream === anthropicStream));
    await flushDeferred();

    expect(reconcileBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-id",
        actualTokens: TOTAL_TOKENS, // 19,412 — not 212
      })
    );
    // The bug in one assertion: the old figure would have been the input+output
    // pair alone, which is a rounding error against the real consumption.
    const call = reconcileBudgetMock.mock.calls[0]?.[0];
    expect(call.actualTokens).toBeGreaterThan((CACHED.input + CACHED.output) * 90);
  });

  it("charges the cost of the cache traffic too", async () => {
    await drain(await callProxy(upstream === anthropicStream));
    await flushDeferred();

    expect(reconcileBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({ actualMicrocents: EXPECTED_COST })
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
    expect(reconcileBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({ actualTokens: 1_000 })
    );
    expect(mirrorSpendMock).toHaveBeenCalledWith("agent-id", 1_000, expect.any(Number));
  });
});
