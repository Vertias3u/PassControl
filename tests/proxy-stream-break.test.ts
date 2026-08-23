// A streamed call whose upstream body breaks mid-answer.
//
// The provider accepted the call, answered 200, streamed part of an answer, and
// then the connection dropped — Anthropic overloading mid-stream, a load-balancer
// drop, a provider restart. Before the fix this settled nothing: the usage promise
// the reconcile awaited never resolved, so the call left NO audit row, NO receipt,
// and its budget reservation held until the 960s marker TTL expired.
//
// These cases live at the ROUTE, not at the transform, because the transform can
// only report how the stream ended — it is the route that has to turn that into a
// status. A transform-level test passes just as happily against a route that logs
// a broken stream as `ok`, which would trade a missing audit row for a lying one.
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
  waitUntilMock,
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
  waitUntilMock: vi.fn(),
}));

// Unlike the other proxy suites, waitUntil is COLLECTED rather than discarded.
// Everything this file asserts on — the reconcile and the audit row — happens
// inside a waitUntil after the response headers are already committed, so a
// no-op mock would make every assertion here vacuously unreachable.
const deferred: Promise<unknown>[] = [];
vi.mock("@vercel/functions", () => ({
  waitUntil: (p: Promise<unknown>) => {
    deferred.push(Promise.resolve(p));
    waitUntilMock(p);
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

async function callProxy(signal?: AbortSignal) {
  const req = new Request("https://gateway.test/api/v1/openai/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      stream: true,
      max_tokens: 50,
      messages: [{ role: "user", content: "hi" }],
    }),
    ...(signal ? { signal } : {}),
  });
  return POST(req, {
    params: Promise.resolve({ provider: "openai", path: ["chat", "completions"] }),
  });
}

/** An SSE body that delivers every chunk and THEN breaks, one chunk per pull. */
function sseThatBreaks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[i++];
      if (next !== undefined) {
        controller.enqueue(enc.encode(next));
        return;
      }
      controller.error(new Error("upstream connection reset"));
    },
  });
}

function sseResponse(body: ReadableStream<Uint8Array>) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

/** Read the proxied stream to its end, reporting how it ended. */
async function drain(res: Response): Promise<{ end: "closed" | "errored"; text: string }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { end: "closed", text };
      text += dec.decode(value, { stream: true });
    }
  } catch {
    return { end: "errored", text };
  }
}

/** Let every waitUntil task the route registered actually run. */
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
    waitUntilMock,
  ]) {
    m.mockReset();
  }
  readProvidersWithKeysMock.mockResolvedValue([]);
  verifyVisaMock.mockResolvedValue(baseClaims);
  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
  });
  reserveBudgetMock.mockResolvedValue({ ok: true, reserved: 60 });
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

const PARTIAL_STREAM = [
  'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":31,"completion_tokens":9}}\n\n',
];

describe("a streamed call whose upstream breaks mid-answer", () => {
  it("writes an audit row instead of vanishing", async () => {
    fetchMock.mockResolvedValue(sseResponse(sseThatBreaks(PARTIAL_STREAM)));

    const res = await callProxy();
    expect(res.status).toBe(200);
    await drain(res);
    await flushDeferred();

    expect(writeLogMock).toHaveBeenCalledTimes(1);
  });

  it("records it as a provider error, not as a successful call", async () => {
    fetchMock.mockResolvedValue(sseResponse(sseThatBreaks(PARTIAL_STREAM)));

    await drain(await callProxy());
    await flushDeferred();

    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ jti: "jti-1", status: "upstream_error" })
    );
  });

  it("bills the partial tokens the provider produced before the break", async () => {
    fetchMock.mockResolvedValue(sseResponse(sseThatBreaks(PARTIAL_STREAM)));

    await drain(await callProxy());
    await flushDeferred();

    // The usage chunk arrived before the break, so it is real spend and the
    // reservation must be reconciled against it — not released as if nothing
    // had been consumed.
    expect(reconcileBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-id",
        reserveId: reserveBudgetMock.mock.calls[0]?.[0]?.reserveId,
        actualTokens: 40,
      })
    );
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 31, outputTokens: 9 })
    );
  });

  it("hands the client a broken stream rather than a clean truncated one", async () => {
    fetchMock.mockResolvedValue(sseResponse(sseThatBreaks(PARTIAL_STREAM)));

    const { end, text } = await drain(await callProxy());

    // Closing cleanly here would present half an answer as a whole one.
    expect(end).toBe("errored");
    expect(text).toContain("hel");
  });

  it("still settles when the break comes before any usage was reported", async () => {
    fetchMock.mockResolvedValue(sseResponse(sseThatBreaks([PARTIAL_STREAM[0]!])));

    await drain(await callProxy());
    await flushDeferred();

    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "upstream_error", inputTokens: 0, outputTokens: 0 })
    );
    expect(reconcileBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({ actualTokens: 0 })
    );
  });

  it("does not mirror a broken stream into the dashboard spend", async () => {
    fetchMock.mockResolvedValue(sseResponse(sseThatBreaks(PARTIAL_STREAM)));

    await drain(await callProxy());
    await flushDeferred();

    // mirrorSpend is the `ok`-only best-effort mirror. A broken stream is not ok.
    expect(mirrorSpendMock).not.toHaveBeenCalled();
  });
});

// One client disconnect fires BOTH endings from the same event: the platform
// cancels the response body the route returned, and `req.signal` aborts the
// upstream fetch, whose body then errors under the transform's reader. Whichever
// settles first wins, so without discriminating on the signal the status for an
// ordinary stop-button press would be a coin flip between `ok` and
// `upstream_error` — and on the `upstream_error` side the call's real tokens
// would drop out of both mirrorSpend and the `ok`-only spend checkpoint.
//
// These cases pin the classification, not the race: they drive the ending that
// would be misread and assert the status is decided by the signal, so they hold
// whichever racer happens to win on a given host.
describe("a streamed call the client disconnects from", () => {
  it("is recorded as ok even when the ending arrives as a stream error", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(sseResponse(sseThatBreaks(PARTIAL_STREAM)));

    const res = await callProxy(controller.signal);
    controller.abort(); // the client went away
    await drain(res);
    await flushDeferred();

    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok", inputTokens: 31, outputTokens: 9 })
    );
    expect(writeLogMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "upstream_error" })
    );
  });

  it("still calls a genuine provider break an upstream error when nobody aborted", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(sseResponse(sseThatBreaks(PARTIAL_STREAM)));

    await drain(await callProxy(controller.signal));
    await flushDeferred();

    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "upstream_error" })
    );
  });
});

describe("a streamed call that completes normally", () => {
  it("is still logged as ok with its full usage", async () => {
    const enc = new TextEncoder();
    fetchMock.mockResolvedValue(
      sseResponse(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const c of PARTIAL_STREAM) controller.enqueue(enc.encode(c));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            controller.close();
          },
        })
      )
    );

    const { end } = await drain(await callProxy());
    await flushDeferred();

    expect(end).toBe("closed");
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok", inputTokens: 31, outputTokens: 9 })
    );
    expect(mirrorSpendMock).toHaveBeenCalled();
  });
});
