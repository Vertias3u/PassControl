import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE ONE-USE DISPATCH PERMISSION, ASSERTED AT THE PLACE IT MATTERS: the proxy.
 *
 * `lib/state/holds.ts` has carried the whole mechanism for a while — `openHold`
 * writes `ph: 'pre_dispatch'`, `consumeDispatchPermission` advances it to
 * `dispatch_may_have_happened`, and the settle script refuses a
 * `not_dispatched` release for any hold past that line. Every piece of it is
 * covered by tests/holds.redis.test.ts against real Lua, and all of it passed.
 *
 * None of it ran. The proxy never called `consumeDispatchPermission`, so `ph`
 * sat at `pre_dispatch` for the life of every hold and the guard in the settle
 * script could not fire. The consequence is on the RECOVERY surface, not the
 * hot path: an operator resolving an abandoned hold through
 * POST /holds/{attemptId}/resolve with `not_spent` got a full refund of a
 * request that had definitely reached the provider — the one direction this
 * subsystem exists to prevent, arriving through the route whose own comment
 * says so.
 *
 * So these tests live here rather than beside the Lua. A test at the state
 * layer cannot fail on this: the state layer was already right.
 */
const establishBudgetStateMock = vi.fn();

const {
  verifyVisaMock,
  serviceClientMock,
  openHoldMock,
  settleHoldMock,
  consumeDispatchPermissionMock,
  getCachedKeyMock,
  setCachedKeyMock,
  getCachedAgentPolicyMock,
  setCachedAgentPolicyMock,
  readKillStateMock,
  isSuspendedMock,
  writeLogMock,
  mirrorSpendMock,
  rateLimitMock,
  captureSecurityEventMock,
  signReceiptMock,
  fetchMock,
} = vi.hoisted(() => ({
  verifyVisaMock: vi.fn(),
  serviceClientMock: vi.fn(),
  openHoldMock: vi.fn(),
  settleHoldMock: vi.fn(),
  consumeDispatchPermissionMock: vi.fn(),
  getCachedKeyMock: vi.fn(),
  setCachedKeyMock: vi.fn(),
  getCachedAgentPolicyMock: vi.fn(),
  setCachedAgentPolicyMock: vi.fn(),
  readKillStateMock: vi.fn(),
  isSuspendedMock: vi.fn(),
  writeLogMock: vi.fn(),
  mirrorSpendMock: vi.fn(),
  rateLimitMock: vi.fn(),
  captureSecurityEventMock: vi.fn(),
  signReceiptMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@vercel/functions", () => ({ waitUntil: (promise: unknown) => promise }));
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
vi.mock("@/lib/state/holds", () => {
  const settle = async (outcome: string, p: Record<string, unknown>) => {
    const r = await settleHoldMock({ ...p, outcome });
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
    settleKnown: (p: Record<string, unknown>) => settle("complete", p),
    settleUnknown: (p: Record<string, unknown>) => settle("usage_unknown", p),
    releaseUndispatched: (p: Record<string, unknown>) => settle("not_dispatched", p),
    consumeDispatchPermission: (...args: unknown[]) => consumeDispatchPermissionMock(...args),
    establishBudgetState: (...args: unknown[]) => establishBudgetStateMock(...args),
  };
});
vi.mock("@/lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: async () => "sealed", open: async (v: string) => v }));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/receipt", () => ({ signReceipt: (...args: unknown[]) => signReceiptMock(...args) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...args: unknown[]) => rateLimitMock(...args) }));
vi.mock("@/lib/observability", () => ({
  captureError: vi.fn(async () => undefined),
  captureSecurityEvent: (...args: unknown[]) => captureSecurityEventMock(...args),
  logFailOpen: vi.fn(),
}));

import { POST } from "@/app/api/v1/[provider]/[...path]/route";

const baseClaims = {
  sub: "passport-id",
  agid: "agent-a",
  uid: "tenant-a",
  jti: "jti-1",
  bt: null,
  bc: null,
  st: 0,
  sc: 0,
  ver: 1,
  scope: [{ provider: "openai", models: ["*"] }],
};

function request(provider = "openai") {
  return new Request(`https://gateway.test/api/v1/${provider}/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4.1",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
}

async function callProxy(provider = "openai") {
  verifyVisaMock.mockResolvedValueOnce(baseClaims);
  return POST(request(provider), {
    params: Promise.resolve({ provider, path: ["chat", "completions"] }),
  });
}

beforeEach(() => {
  for (const mock of [
    verifyVisaMock,
    serviceClientMock,
    openHoldMock,
    settleHoldMock,
    consumeDispatchPermissionMock,
    getCachedKeyMock,
    setCachedKeyMock,
    getCachedAgentPolicyMock,
    setCachedAgentPolicyMock,
    readKillStateMock,
    isSuspendedMock,
    writeLogMock,
    mirrorSpendMock,
    rateLimitMock,
    captureSecurityEventMock,
    signReceiptMock,
    fetchMock,
    establishBudgetStateMock,
  ]) {
    mock.mockReset();
  }

  serviceClientMock.mockReturnValue({
    from: vi.fn(),
    rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
  });
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1 });
  settleHoldMock.mockResolvedValue(undefined);
  // Granted is the ordinary case: a freshly minted attempt id has never
  // dispatched, so the real script returns {1} every time here.
  consumeDispatchPermissionMock.mockResolvedValue({ granted: true });
  getCachedKeyMock.mockResolvedValue("provider-key");
  setCachedKeyMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null }));
  setCachedAgentPolicyMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, tenantKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  captureSecurityEventMock.mockResolvedValue(undefined);
  signReceiptMock.mockReturnValue("signed-receipt");
  establishBudgetStateMock.mockResolvedValue(undefined);
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  delete process.env.PASSCONTROL_DEMO;
});

describe("one-use dispatch permission on the proxy's dispatch boundary", () => {
  it("consumes the attempt's permission BEFORE the provider is called", async () => {
    const res = await callProxy();
    expect(res.status).toBe(200);

    expect(consumeDispatchPermissionMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Ordering is the whole property. Consuming it AFTER the send would record
    // the phase truthfully and protect nothing: the money has already left.
    expect(consumeDispatchPermissionMock.mock.invocationCallOrder[0]!).toBeLessThan(
      fetchMock.mock.invocationCallOrder[0]!
    );
  });

  it("consumes it for the SAME attempt id the hold was opened under", async () => {
    await callProxy();

    const opened = openHoldMock.mock.calls[0]![0] as { attemptId: string; agentId: string };
    expect(consumeDispatchPermissionMock).toHaveBeenCalledWith({
      agentId: opened.agentId,
      attemptId: opened.attemptId,
    });
  });

  it.each([
    ["already_dispatched", { granted: false, reason: "already_dispatched" }],
    ["terminal", { granted: false, reason: "terminal" }],
    ["missing", { granted: false, reason: "missing" }],
  ])("does not reach the provider when permission is refused (%s)", async (_label, refusal) => {
    consumeDispatchPermissionMock.mockResolvedValue(refusal);

    const res = await callProxy();

    // NO SEND. A refusal means some other handler may already hold this
    // attempt's one send; forwarding anyway is the double-charge this exists
    // to stop.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "dispatch_unavailable" });
  });

  it("a refusal never releases the hold", async () => {
    consumeDispatchPermissionMock.mockResolvedValue({
      granted: false,
      reason: "already_dispatched",
    });

    await callProxy();

    // Retained, not refunded. The winning dispatcher owns this attempt's
    // settlement; releasing here would hand back capacity for a call that may
    // be in flight right now.
    const releases = settleHoldMock.mock.calls.filter(
      ([p]) => (p as { outcome: string }).outcome === "not_dispatched"
    );
    expect(releases).toHaveLength(0);
  });

  it("fails closed when the permission check itself throws", async () => {
    consumeDispatchPermissionMock.mockRejectedValue(new Error("redis unreachable"));

    const res = await callProxy();

    // An unreadable permission is not a granted one. Redis being unreachable
    // between the reserve and the send means we cannot know whether another
    // handler already sent, so we do not.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(503);
  });

  it("the demo path never consumes dispatch permission", async () => {
    process.env.PASSCONTROL_DEMO = "1";
    verifyVisaMock.mockResolvedValueOnce({ ...baseClaims, scope: [{ provider: "demo", models: ["*"] }] });

    await POST(
      new Request("https://gateway.test/api/v1/demo/chat/completions", {
        method: "POST",
        headers: { authorization: "Bearer visa", "content-type": "application/json" },
        body: JSON.stringify({ model: "demo-model", messages: [{ role: "user", content: "hi" }] }),
      }),
      { params: Promise.resolve({ provider: "demo", path: ["chat", "completions"] }) }
    );

    // The demo response is SYNTHESISED here — there is no provider and no
    // dispatch. Leaving its holds at `pre_dispatch` is the honest state, and it
    // keeps them fully releasable, which a dispatched hold must never be.
    expect(consumeDispatchPermissionMock).not.toHaveBeenCalled();
  });
});

/**
 * CONTRACT ITEM 1 — the generation must be DURABLE BEFORE the request goes out.
 *
 * The first budgeted call of an agent's life mints an epoch in Redis, and
 * Postgres has to learn it or the loss check can never fire: `open` only
 * refuses a lost epoch for an agent Postgres says was established. While that
 * write was scheduled through `waitUntil` it ran AFTER the response, so a call
 * could be forwarded — and billed — with the marker still unwritten. A Redis
 * flush in that window is then undetectable forever: Postgres says "never
 * established", so the next call mints a fresh epoch, seeds zero, and the
 * agent's whole spend history is gone with its budget restored.
 *
 * The acceptance criterion is two-sided: a matching durable generation is
 * confirmed, OR no upstream call occurs.
 */
describe("the accounting generation is durable before anything is forwarded", () => {
  it("waits for the epoch to LAND before the provider is called", async () => {
    openHoldMock.mockResolvedValue({ ok: true, reserved: 1, epochToPersist: "epoch-1" });

    // INVOCATION ORDER IS NOT THE PROPERTY, and asserting it would pass against
    // the bug: `waitUntil(establishBudgetState(...))` already CALLS it before
    // the fetch — it just does not wait for it. What matters is that the write
    // has completed. So the write is held open here and the send must not
    // happen while it is still in flight.
    // Driven by the call itself rather than by a guessed number of microtask
    // ticks, which would make the test depend on how many awaits happen to sit
    // upstream of this point in the route.
    let landed: () => void = () => {};
    let reached: () => void = () => {};
    const wasReached = new Promise<void>((resolve) => { reached = resolve; });
    establishBudgetStateMock.mockImplementation(() => {
      reached();
      return new Promise<void>((resolve) => { landed = () => resolve(); });
    });

    const inFlight = callProxy();
    await wasReached;
    expect(establishBudgetStateMock).toHaveBeenCalledWith("agent-a", "epoch-1");

    // A FULL MACROTASK, which drains every pending microtask. Merely observing
    // that the call has been reached proves nothing — the route has more awaits
    // between here and the send, so a fire-and-forget write would still not have
    // reached `fetch` at that instant and the assertion would pass against the
    // bug. Yielding the whole queue removes the race: with the write awaited the
    // route cannot get past it however long we wait, and without it, it does.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();

    landed();
    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not forward at all when the epoch cannot be persisted", async () => {
    openHoldMock.mockResolvedValue({ ok: true, reserved: 1, epochToPersist: "epoch-1" });
    establishBudgetStateMock.mockRejectedValue(new Error("postgres unavailable"));

    const res = await callProxy();

    // NOTHING WAS SENT. Forwarding here is what makes a later flush silent, and
    // no provider response is worth an agent whose spend history cannot be
    // shown to have been lost.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "blocked_budget_state" });
    // And the hold this attempt opened is GIVEN BACK. The attempt provably
    // never reached a provider, so leaving it open would strand the agent's
    // capacity on every transient database error until an operator resolved it
    // by hand. This is the one full release in the system, and this is a case
    // for it.
    const opened = openHoldMock.mock.calls[0]![0] as { attemptId: string };
    expect(settleHoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "not_dispatched", attemptId: opened.attemptId })
    );
  });

  it("leaves an already-established agent's hot path untouched", async () => {
    // No epochToPersist: Postgres already knows. This is every call after the
    // first, and it must not pay for a database write.
    openHoldMock.mockResolvedValue({ ok: true, reserved: 1 });

    const res = await callProxy();
    expect(res.status).toBe(200);
    expect(establishBudgetStateMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
