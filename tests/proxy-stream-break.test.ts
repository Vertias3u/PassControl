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
  waitUntilMock,
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
  waitUntilMock: vi.fn(),
}));

// Unlike the other proxy suites, waitUntil is COLLECTED rather than discarded.
// Everything this file asserts on — the reconcile and the audit row — happens
// inside a waitUntil after the response headers are already committed, so a
// no-op mock would make every assertion here vacuously unreachable.
const deferred: Promise<unknown>[] = [];
// The proxy now reaches lib/demo/identity.ts to tell the seeded PUBLIC demo
// passport apart from a tenant that holds a demo scope. That module is
// `server-only`, which Next enforces at build time and vitest cannot resolve
// at all — same stub tests/site-demo-routes.test.ts already uses.
vi.mock("server-only", () => ({}));
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
  purgeAgentPolicy: vi.fn(),
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
  setCachedKey: (...args: unknown[]) => setCachedKeyMock(...args),
  getCachedAgentPolicy: (...args: unknown[]) => getCachedAgentPolicyMock(...args),
  setCachedAgentPolicy: (...args: unknown[]) => setCachedAgentPolicyMock(...args),
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
    waitUntilMock,
  ]) {
    m.mockReset();
  }
  readProvidersWithKeysMock.mockResolvedValue([]);
  verifyVisaMock.mockResolvedValue(baseClaims);
  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
  });
  openHoldMock.mockResolvedValue({ ok: true, reserved: 60 });
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

  it("records it as usage_unknown — sent, and the accounting never came back", async () => {
    fetchMock.mockResolvedValue(sseResponse(sseThatBreaks(PARTIAL_STREAM)));

    await drain(await callProxy());
    await flushDeferred();

    // NOT `upstream_error`. That status means a call we know produced nothing,
    // and it is exactly what made this bug invisible: the spend checkpoint
    // counted only `ok` rows, so a broken stream's real tokens dropped straight
    // back out of the cap at the next cron run. `usage_unknown` is counted
    // (db/migrations/0055) precisely because this call may have been billed.
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ jti: "jti-1", status: "usage_unknown" })
    );
  });

  it("settles as unknown with the observed tokens, and the row keeps what was OBSERVED", async () => {
    fetchMock.mockResolvedValue(sseResponse(sseThatBreaks(PARTIAL_STREAM)));

    await drain(await callProxy());
    await flushDeferred();

    // The route hands the settle only what it OBSERVED. The greater of that and
    // the stored estimate is chosen inside the Lua, which is where the estimate
    // actually lives — see tests/holds.redis.test.ts for that arithmetic. This
    // file's job is which transition was chosen and with what arguments; it must
    // not re-implement the script, which is how tests/reserve-id.test.ts drifted.
    expect(settleHoldMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-id",
        attemptId: openHoldMock.mock.calls[0]?.[0]?.attemptId,
        outcome: "usage_unknown",
        tokens: 40,
      })
    );
    // And the audit row still records what the provider actually reported. The
    // enforced figure is a separate column precisely so this one stays true.
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 31, outputTokens: 9 })
    );
  });

  // Step 13's headline: the enforced figure reaches the row and the mirror.
  it("records the ENFORCED figure alongside the observed one, and mirrors the enforced", async () => {
    fetchMock.mockResolvedValue(sseResponse(sseThatBreaks(PARTIAL_STREAM)));
    // What the real script would apply: max(observed 40, estimate 1200).
    settleHoldMock.mockResolvedValue({
      applied: true,
      appliedTokens: 1_200,
      appliedMicrocents: 8_000,
    });

    await drain(await callProxy());
    await flushDeferred();

    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "usage_unknown",
        // Observed stays observed…
        inputTokens: 31,
        outputTokens: 9,
        // …while the columns that say what the budget was charged carry the
        // enforced figures. A checkpoint reading only the observed pair would
        // disagree with Redis about this call.
        enforcedTokens: 1_200,
        enforcedMicrocents: 8_000,
      })
    );
    // THE MIRROR IS CALLED, and with the ENFORCED figures. This file used to
    // assert it was NOT called at all. That left agents.spent_* under-counting
    // the checkpoint, and the mirror is what the dashboard, the control graph,
    // the passport page and the decision trace all read — so an operator saw
    // "40 tokens" on an agent being refused at its cap.
    expect(mirrorSpendMock).toHaveBeenCalledWith("agent-id", 1_200, 8_000);
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

    // Zeros on the row, because zero is what was observed — and `usage_unknown`
    // is what stops those zeros being read as a measurement. Anthropic and
    // OpenAI both process the entire prompt before their first usage event, so a
    // break here means real input tokens were billed that nothing here can see.
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "usage_unknown", inputTokens: 0, outputTokens: 0 })
    );
    expect(settleHoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "usage_unknown", tokens: 0 })
    );
  });

  it("mirrors a broken stream into the dashboard spend, at the enforced figure", async () => {
    fetchMock.mockResolvedValue(sseResponse(sseThatBreaks(PARTIAL_STREAM)));
    settleHoldMock.mockResolvedValue({
      applied: true,
      appliedTokens: 1_200,
      appliedMicrocents: 8_000,
    });

    await drain(await callProxy());
    await flushDeferred();

    // The reversal, stated as its own case. The mirror used to be `ok`-only, so
    // a broken stream never reached the dashboard at all — while Redis charged
    // for it. The two disagreed about the same call, visibly.
    expect(mirrorSpendMock).toHaveBeenCalledWith("agent-id", 1_200, 8_000);
  });

  // A settle whose Redis write FAILED must not also cost the audit row. We then
  // do not know what was applied, so the enforced columns are omitted — absence
  // means "the observed figure was what was enforced", which is the least-wrong
  // reading — and the mirror is skipped rather than fed a guess.
  it("still writes the audit row when the settle itself fails", async () => {
    fetchMock.mockResolvedValue(sseResponse(sseThatBreaks(PARTIAL_STREAM)));
    settleHoldMock.mockRejectedValue(new Error("redis down"));

    await drain(await callProxy());
    await flushDeferred();

    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "usage_unknown", inputTokens: 31 })
    );
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ enforcedTokens: expect.anything() })
    );
    expect(mirrorSpendMock).not.toHaveBeenCalled();
  });
});

// THE RACE THAT USED TO DECIDE THE STATUS IS GONE, and these cases now pin its
// absence.
//
// One client disconnect fires BOTH endings from the same event: the platform
// cancels the response body the route returned, and `req.signal` aborts the
// upstream fetch, whose body then errors under the transform's reader. Whichever
// settled first decided the status, so the route discriminated on
// `req.signal.aborted` to keep an ordinary stop-button press out of
// `upstream_error` — where its real tokens would have dropped out of both
// mirrorSpend and the `ok`-only spend checkpoint.
//
// The classification no longer keys on how the stream ended, but on whether a
// usage event arrived AND the stream closed cleanly. Neither racer is a clean
// close, so both now land on `usage_unknown` — and the outcome is the same
// whichever wins. That is a stronger property than the old discrimination: there
// is no longer a coin to flip, on any host.
describe("a streamed call the client disconnects from", () => {
  it("lands on usage_unknown whichever ending wins the race", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(sseResponse(sseThatBreaks(PARTIAL_STREAM)));

    const res = await callProxy(controller.signal);
    controller.abort(); // the client went away
    await drain(res);
    await flushDeferred();

    // Not `ok`: a cancelled stream never reported a complete accounting, and the
    // provider had already generated — and billed for — what it sent.
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "usage_unknown", inputTokens: 31, outputTokens: 9 })
    );
    expect(writeLogMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "ok" })
    );
  });

  it("classifies a genuine provider break identically, with nobody aborting", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValue(sseResponse(sseThatBreaks(PARTIAL_STREAM)));

    await drain(await callProxy(controller.signal));
    await flushDeferred();

    // The same answer as the aborted case above. That the two agree is the
    // point: the status can no longer depend on which racer settled first.
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "usage_unknown" })
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
