// 1.9.0 per-session caps, through the real model proxy route. The session script and the
// money cap through the real hold script run on Redis in tests/session-caps.redis.test.ts;
// this file asserts where the route asks, what it refuses, how a money cap joins the hold,
// and that an agent without the policy key, or a call with no session, costs no Redis call.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  pendingTasks,
  captureSecurityEventMock,
} = vi.hoisted(() => {
  return {
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
    captureSecurityEventMock: vi.fn(),
    pendingTasks: [] as Promise<unknown>[],
  };
});

// The proxy now reaches lib/demo/identity.ts to tell the seeded PUBLIC demo
// passport apart from a tenant that holds a demo scope. That module is
// `server-only`, which Next enforces at build time and vitest cannot resolve
// at all — same stub tests/site-demo-routes.test.ts already uses.
// The Cloud allowance resolver sits on the enforcement path and fails CLOSED, so
// an unmocked one refuses every request here with a 503 instead of exercising
// what this file is about.
vi.mock("server-only", () => ({}));
vi.mock("@vercel/functions", () => ({
  waitUntil: (task: Promise<unknown>) => { pendingTasks.push(task); },
}));
vi.mock("@/lib/auth/visa", () => ({
  extractVisaToken: (headers: Headers) => headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
  verifyVisa: (...args: unknown[]) => verifyVisaMock(...args),
}));
vi.mock("@/lib/state/killswitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/killswitch")>();
  return {
    ...actual,
    readKillState: (...args: unknown[]) => readKillStateMock(...args),
  };
});
vi.mock("@/lib/state/redis", () => ({
  // Cloud review A1: the proxy reads the stored endpoint on every deployment now.
  // A warm "no stored address" answer keeps this file on the plain key path.
  getCachedEndpoint: async () => "|",
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
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: async () => "sealed", open: async (v: string) => v }));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...args: unknown[]) => rateLimitMock(...args) }));

const loop = vi.hoisted(() => ({ check: vi.fn(), notify: vi.fn(), session: vi.fn() }));
vi.mock("@/lib/state/runaway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/state/runaway")>()),
  checkLoop: (...a: unknown[]) => loop.check(...a),
  checkSessionCaps: (...a: unknown[]) => loop.session(...a),
}));
vi.mock("@/lib/alerts/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/alerts/workspace")>()),
  notifyWorkspace: (...a: unknown[]) => loop.notify(...a),
}));

vi.mock("@/lib/observability", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/observability")>(),
  captureSecurityEvent: (...args: unknown[]) => captureSecurityEventMock(...args),
}));

import { POST } from "@/app/api/v1/[provider]/[...path]/route";

const GATEWAY = "https://gateway.test";
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
};

beforeEach(() => {
  pendingTasks.length = 0;
  captureSecurityEventMock.mockReset();
  verifyVisaMock.mockReset();
  serviceClientMock.mockReset();
  openHoldMock.mockReset();
  settleHoldMock.mockReset();
  getCachedKeyMock.mockReset();
  setCachedKeyMock.mockReset();
  getCachedAgentPolicyMock.mockReset();
  setCachedAgentPolicyMock.mockReset();
  readKillStateMock.mockReset();
  isSuspendedMock.mockReset();
  writeLogMock.mockReset();
  mirrorSpendMock.mockReset();
  rateLimitMock.mockReset();
  fetchMock.mockReset();

  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
  });
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1 });
  settleHoldMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue(null);
  setCachedKeyMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null }));
  setCachedAgentPolicyMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});


afterEach(async () => {
  for (let i = 0; i < pendingTasks.length; i++) await pendingTasks[i];
  vi.unstubAllGlobals();
});

const policy = (p: Record<string, unknown>) => getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p, s: null }));
const turn = (text: string) => ({ role: "user", content: text });

async function send(text = "hello", session: string | null = "sess-1") {
  verifyVisaMock.mockResolvedValue({ ...baseClaims, scope: [{ provider: "anthropic", models: ["*"] }] });
  return POST(new Request(`${GATEWAY}/api/v1/anthropic/v1/messages`, {
    method: "POST",
    headers: {
      authorization: "Bearer visa",
      "content-type": "application/json",
      ...(session ? { "x-claude-code-session-id": session } : {}),
    },
    body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 10, messages: [turn(text)] }),
  }), { params: Promise.resolve({ provider: "anthropic", path: ["v1", "messages"] }) });
}

beforeEach(() => {
  loop.check.mockReset();
  loop.session.mockReset();
  loop.notify.mockReset();
  loop.notify.mockResolvedValue(undefined);
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } })
  );
});

describe("per-session caps in the model proxy (1.9.0)", () => {
  it("costs nothing when the policy does not set them: no Redis call at all", async () => {
    expect((await send()).status).toBe(200);
    expect(loop.session).not.toHaveBeenCalled();
  });

  it("does nothing for a call that declares no session: there is nothing to count against", async () => {
    policy({ session_caps: { calls: 5 } });
    expect((await send("hello", null)).status).toBe(200);
    expect(loop.session).not.toHaveBeenCalled();
  });

  it("asks once per call with the declared session and the caps, then lets it through", async () => {
    policy({ session_caps: { calls: 5, minutes: 30 } });
    loop.session.mockResolvedValue({ ok: true, calls: 1 });
    expect((await send()).status).toBe(200);
    expect(loop.session).toHaveBeenCalledTimes(1);
    expect(loop.session).toHaveBeenCalledWith("agent-id", "sess-1", expect.objectContaining({ calls: 5, minutes: 30 }));
    // No money cap, so no ledger and no extra link on the hold.
    expect(loop.session.mock.calls[0]![2]).not.toHaveProperty("ledgerJti");
    expect(openHoldMock.mock.calls[0]![0]).not.toHaveProperty("delegation");
  });

  it.each([
    ["calls", /5 calls/],
    ["minutes", /30 minutes/],
    ["sessions", /new sessions this hour/],
  ] as const)("refuses past the %s cap with 403 blocked_session_cap, before any money or key", async (reason, pattern) => {
    policy({ session_caps: { calls: 5, minutes: 30 } });
    loop.session.mockResolvedValue({ ok: false, reason });
    const res = await send();
    expect(res.status).toBe(403);
    expect(res.headers.get("x-passcontrol-receipt-id")).toBeTruthy();
    const json = await res.json();
    expect(json.error).toBe("blocked_session_cap");
    expect(json.message).toMatch(pattern);
    for (let i = 0; i < pendingTasks.length; i++) await pendingTasks[i];
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked_session_cap" }));
    expect(loop.notify).toHaveBeenCalledWith(expect.objectContaining({ type: "budget", status: "blocked_session_cap" }));
  });

  it("joins a money cap to the hold as one more ledger link, so it is checked atomically with the agent's own", async () => {
    policy({ session_caps: { cents: 250 } });
    loop.session.mockResolvedValue({ ok: true, calls: 1 });
    expect((await send()).status).toBe(200);
    const opts = loop.session.mock.calls[0]![2] as { ledgerJti: string };
    expect(opts.ledgerJti).toMatch(/^ses_[0-9a-f]{40}$/);
    const hold = openHoldMock.mock.calls[0]![0] as { delegation: { links: { jti: string; capMicrocents: number }[] }; budgetState?: unknown };
    expect(hold.delegation.links).toEqual([{ jti: opts.ledgerJti, capMicrocents: 250 * 1_000_000 }]);
  });

  it("answers the hold's refusal on that link as the session's money cap, 402", async () => {
    policy({ session_caps: { cents: 250 } });
    loop.session.mockResolvedValue({ ok: true, calls: 1 });
    openHoldMock.mockResolvedValue({ ok: false, reason: "delegation", link: 1, reserved: 0, reservedMicrocents: 0 });
    const res = await send();
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json.error).toBe("blocked_session_cap");
    expect(json.message).toMatch(/\$2\.50/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers a session whose money record was lost with a 503 that says to start a new session, before any hold", async () => {
    policy({ session_caps: { cents: 250 } });
    loop.session.mockResolvedValue({ ok: false, reason: "state" });
    const res = await send();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("session_state_unavailable");
    expect(body.message).toMatch(/new session/);
    expect(openHoldMock).not.toHaveBeenCalled();
  });

  it("leaves model discovery alone: listing models is not a model call, for either guard", async () => {
    policy({ session_caps: { calls: 1 }, loop_breaker: { repeats: 3 } });
    loop.session.mockResolvedValue({ ok: true, calls: 1 });
    loop.check.mockResolvedValue({ state: "ok", retryAfterS: 0 });
    verifyVisaMock.mockResolvedValue({ ...baseClaims, scope: [{ provider: "anthropic", models: ["*"] }] });
    for (const path of [["v1", "models"], ["v1", "models", "claude-haiku-4-5"]]) {
      await POST(new Request(`${GATEWAY}/api/v1/anthropic/${path.join("/")}`, {
        method: "GET",
        headers: { authorization: "Bearer visa", "x-claude-code-session-id": "sess-1" },
      }), { params: Promise.resolve({ provider: "anthropic", path }) });
    }
    expect(loop.session).not.toHaveBeenCalled();
    expect(loop.check).not.toHaveBeenCalled();
  });

  it("answers a lost session ledger with a retryable 503, never as an empty budget", async () => {
    policy({ session_caps: { cents: 250 } });
    loop.session.mockResolvedValue({ ok: true, calls: 1 });
    openHoldMock.mockResolvedValue({ ok: false, reason: "delegation_state", link: 1, reserved: 0, reservedMicrocents: 0 });
    const res = await send();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("session_state_unavailable");
  });

  it("fails open when Redis cannot answer: no link is joined and the agent's own limits still hold", async () => {
    policy({ session_caps: { cents: 250, calls: 5 } });
    loop.session.mockResolvedValue(null);
    expect((await send()).status).toBe(200);
    expect(openHoldMock.mock.calls[0]![0]).not.toHaveProperty("delegation");
  });
});
