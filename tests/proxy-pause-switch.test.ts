import { beforeEach, describe, expect, it, vi } from "vitest";
const establishBudgetStateMock = vi.fn();

const {
  verifyVisaMock,
  authenticateDirectAgentKeyMock,
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
  rateLimitFailClosedMock,
  captureSecurityEventMock,
  signReceiptMock,
  notifyWorkspaceMock,
  touchLastSeenMock,
  fetchMock,
} = vi.hoisted(() => ({
  verifyVisaMock: vi.fn(),
  authenticateDirectAgentKeyMock: vi.fn(),
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
  rateLimitFailClosedMock: vi.fn(),
  captureSecurityEventMock: vi.fn(),
  signReceiptMock: vi.fn(),
  notifyWorkspaceMock: vi.fn(async (..._args: unknown[]) => undefined),
  touchLastSeenMock: vi.fn(),
  fetchMock: vi.fn(),
}));

// The proxy now reaches lib/demo/identity.ts to tell the seeded PUBLIC demo
// passport apart from a tenant that holds a demo scope. That module is
// `server-only`, which Next enforces at build time and vitest cannot resolve
// at all — same stub tests/site-demo-routes.test.ts already uses.
vi.mock("server-only", () => ({}));
vi.mock("@vercel/functions", () => ({ waitUntil: (promise: unknown) => promise }));
vi.mock("@/lib/auth/visa", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/visa")>()),
  verifyVisa: (...args: unknown[]) => verifyVisaMock(...args),
}));
vi.mock("@/lib/auth/direct-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/direct-key")>()),
  authenticateDirectAgentKey: (...args: unknown[]) => authenticateDirectAgentKeyMock(...args),
}));
vi.mock("@/lib/state/killswitch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/state/killswitch")>()),
  readKillState: (...args: unknown[]) => readKillStateMock(...args),
}));
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
  touchLastSeen: (...args: unknown[]) => touchLastSeenMock(...args),
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
// The soft pause (1.6.0, L4): its readers mocked, the line itself real.
const { readPauseViewMock, readPauseLiftMock } = vi.hoisted(() => ({
  readPauseViewMock: vi.fn(),
  readPauseLiftMock: vi.fn(async (..._a: unknown[]) => false),
}));
vi.mock("@/lib/budget-pause", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/budget-pause")>()),
  readPauseView: (...args: unknown[]) => readPauseViewMock(...args),
}));
const { stopOpenMock, pollMock, polled } = vi.hoisted(() => ({
  polled: new Set<string>(),
  stopOpenMock: vi.fn(async (..._a: unknown[]) => false),
  pollMock: vi.fn(async (..._a: unknown[]) => ({ state: "ok", decided: 0 }) as unknown),
}));
vi.mock("@/lib/state/pause", () => ({
  readPauseLift: (...args: unknown[]) => readPauseLiftMock(...args),
  pausePromptOpen: async () => false,
  stopPromptOpen: (...args: unknown[]) => stopOpenMock(...args),
  claimStopPoll: async (agent: string) => (polled.has(agent) ? false : (polled.add(agent), true)),
}));
vi.mock("@/lib/alerts/approvals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/alerts/approvals")>()),
  pollTelegramDecisions: (...args: unknown[]) => pollMock(...args),
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: async () => "sealed", open: async (v: string) => v }));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: (...args: unknown[]) => rateLimitMock(...args),
  rateLimitFailClosed: (...args: unknown[]) => rateLimitFailClosedMock(...args),
}));
vi.mock("@/lib/observability", () => ({
  captureError: vi.fn(async () => undefined),
  captureSecurityEvent: (...args: unknown[]) => captureSecurityEventMock(...args),
  logFailOpen: vi.fn(),
}));
// Workspace alerts: the real status filter, a spy for the send.
vi.mock("@/lib/alerts/workspace", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/alerts/workspace")>()),
  notifyWorkspace: (...args: unknown[]) => notifyWorkspaceMock(...args),
}));
vi.mock("@/lib/receipt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/receipt")>()),
  signReceipt: (...args: unknown[]) => signReceiptMock(...args),
}));

const { readFallbacksMock } = vi.hoisted(() => ({ readFallbacksMock: vi.fn(async (..._a: unknown[]) => [] as unknown[]) }));
vi.mock("@/lib/state/fallbacks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/state/fallbacks")>()),
  readCurrentAgentFallbacks: (...args: unknown[]) => readFallbacksMock(...args),
}));

const { notices } = vi.hoisted(() => ({ notices: new Set<string>() }));
vi.mock("@/lib/state/budget-notice", () => ({
  claimBudgetNotice: async (agent: string, notice: string, period: string | null) => {
    const k = `${notice}:${agent}:${period}`;
    if (notices.has(k)) return false;
    notices.add(k);
    return true;
  },
  markBudgetNotice: async (agent: string, notice: string, period: string | null) => void notices.add(`${notice}:${agent}:${period}`),
  budgetNoticeSent: async (agent: string, notice: string, period: string | null) => notices.has(`${notice}:${agent}:${period}`),
}));
const { noteHeadsUpMock } = vi.hoisted(() => ({ noteHeadsUpMock: vi.fn(async (..._a: unknown[]) => false) }));
vi.mock("@/lib/budget-headsup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/budget-headsup")>()),
  noteHeadsUp: (...args: unknown[]) => noteHeadsUpMock(...args),
}));

import { POST } from "@/app/api/v1/[provider]/[...path]/route";

const DIRECT_KEY = `pc_agent_${"A".repeat(43)}`;
const directPrincipal = {
  kind: "direct_key" as const,
  keyId: "00000000-0000-4000-8000-000000000001",
  agentId: "00000000-0000-4000-8000-000000000002",
  userId: "00000000-0000-4000-8000-000000000003",
  scopes: [
    { provider: "openai", models: ["gpt-5", "gpt-5-mini"] },
    { provider: "anthropic", models: ["claude-*"] },
  ],
  budgetTokens: null,
  budgetCents: null,
  spentTokens: 0,
  spentMicrocents: 0,
  suspended: false,
};

function request(model = "gpt-5", extra: Record<string, unknown> = {}) {
  return new Request("https://gateway.test/api/v1/openai/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", "x-api-key": DIRECT_KEY },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], ...extra }),
  });
}

function call(model = "gpt-5", extra: Record<string, unknown> = {}) {
  return POST(request(model, extra), {
    params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PASSCONTROL_TRUST_CF_CONNECTING_IP;
  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
  });
  authenticateDirectAgentKeyMock.mockResolvedValue(directPrincipal);
  verifyVisaMock.mockResolvedValue({
    sub: "passport-id",
    agid: "agent-id",
    uid: "user-id",
    jti: "visa-id",
    scope: [{ provider: "openai", models: ["gpt-5", "gpt-5-mini"] }],
    bt: null,
    bc: null,
    st: 0,
    sc: 0,
    ver: 1,
  });
  rateLimitFailClosedMock.mockResolvedValue({ success: true, remaining: 9 });
  rateLimitMock.mockResolvedValue({ success: true, remaining: 599 });
  captureSecurityEventMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1 });
  settleHoldMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue(null);
  setCachedKeyMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null }));
  setCachedAgentPolicyMock.mockResolvedValue(undefined);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  signReceiptMock.mockReturnValue("header.payload.signature");
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});

// GitHub's clients send `Authorization: token <x>`; the GitHub route reads that
// scheme (owner decision 2026-09-30). The model routes keep exactly the two
// pockets they always had, so a key sent there is still no credential at all.

// L7 (1.6.0, 0088): past its pause line, an agent set to switch goes on with one
// cheaper model instead of pausing. What these hold:
//   * the switch never widens what the agent may call: the cheaper model meets
//     the same scope and policy gate, and a model that fails it is refused, never
//     sent;
//   * the hold prices the model sent, and the hard limits stay behind it;
//   * a switched call never fails over: a fallback's model is not the one the
//     owner picked for past the line;
//   * the policy's hourly counter is taken once per call, switched or not.
const ON = 10 * 100_000_000;
const policyEntry = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ p: {}, s: null, r: "off", be: "epoch-1", bs: true, bk: true, bt: null, bc: 1000, pdk: true, pdp: null, pdc: null, ppk: true, ppc: 50, pss: ["openai", "gpt-5-mini"], ...over });
const pastTheLine = () =>
  readPauseViewMock.mockResolvedValue({ tokens: null, cost: { limit_microcents: ON, used_microcents: 0.6 * ON, remaining_microcents: 0.4 * ON }, period: null });
const sentBody = (i = 0) => JSON.parse(String((fetchMock.mock.calls[i]![1] as RequestInit).body));

describe("the switch to a cheaper model at the pause line", () => {
  beforeEach(() => {
    pastTheLine();
    readPauseLiftMock.mockResolvedValue(false);
    readFallbacksMock.mockResolvedValue([]);
    notices.clear();
  });

  it("tells the owner once a period, and spends the period's heads-up", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry());
    await call("gpt-5");
    await call("gpt-5");
    await new Promise((r) => setTimeout(r, 0));
    const sent = notifyWorkspaceMock.mock.calls.filter((c) => (c[0] as { status?: string }).status === "budget_pause_switched");
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toMatchObject({ type: "budget", model: "gpt-5-mini", agentId: directPrincipal.agentId });
    expect([...notices].some((k) => k.startsWith("headsup:"))).toBe(true);
  });

  it("sends the call to the cheaper model, says so, and records both models", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry());
    const res = await call("gpt-5");
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody().model).toBe("gpt-5-mini");
    expect(res.headers.get("x-passcontrol-model-switched")).toBe("gpt-5 -> gpt-5-mini");
    expect(openHoldMock).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5-mini" }));
    await new Promise((r) => setTimeout(r, 0));
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5-mini", requestedModel: "gpt-5", status: "ok" }));
  });

  it("prices the hold at the cheaper model", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry({ pss: undefined }));
    readPauseViewMock.mockResolvedValue({ tokens: null, cost: { limit_microcents: ON, used_microcents: 0, remaining_microcents: ON }, period: null });
    await call("gpt-5");
    const usual = (openHoldMock.mock.calls[0]![0] as { estimateMicrocents: number }).estimateMicrocents;
    openHoldMock.mockClear();
    pastTheLine();
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry());
    await call("gpt-5");
    const switched = (openHoldMock.mock.calls[0]![0] as { estimateMicrocents: number; model: string });
    expect(switched.model).toBe("gpt-5-mini");
    expect(switched.estimateMicrocents).toBeGreaterThan(0);
    expect(switched.estimateMicrocents).toBeLessThan(usual);
  });

  it("refuses, and sends nothing, when the cheaper model is outside the scope the call carries", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry({ pss: ["openai", "gpt-4o-mini"] }));
    const res = await call("gpt-5");
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("blocked_budget_pause");
    expect(body.message).toMatch(/gpt-4o-mini.*outside the models this agent may use/);
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses, and sends nothing, when the live policy denies the cheaper model", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry({ p: { deny: [{ provider: "openai", models: ["gpt-5-mini"] }] } }));
    const res = await call("gpt-5");
    expect(res.status).toBe(402);
    expect((await res.json()).message).toMatch(/policy does not allow/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pauses a call to another provider", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry({ pss: ["anthropic", "claude-haiku-4-5"] }));
    const res = await call("gpt-5");
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("blocked_budget_pause");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets a call already on the cheaper model through unchanged", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry());
    const res = await call("gpt-5-mini");
    expect(res.status).toBe(200);
    expect(sentBody().model).toBe("gpt-5-mini");
    expect(res.headers.get("x-passcontrol-model-switched")).toBeNull();
  });

  it("puts the agent back on its usual model while the owner's lift lasts", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry());
    readPauseLiftMock.mockResolvedValue(true);
    const res = await call("gpt-5");
    expect(res.status).toBe(200);
    expect(sentBody().model).toBe("gpt-5");
    expect(res.headers.get("x-passcontrol-model-switched")).toBeNull();
  });

  it("does not switch below the line", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry());
    readPauseViewMock.mockResolvedValue({ tokens: null, cost: { limit_microcents: ON, used_microcents: 0.1 * ON, remaining_microcents: 0.9 * ON }, period: null });
    await call("gpt-5");
    expect(sentBody().model).toBe("gpt-5");
  });

  it("never fails over from a switched call", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry());
    readFallbacksMock.mockResolvedValue([{ provider: "openai", model: "gpt-5" }]);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503, headers: { "content-type": "application/json" } }));
    const res = await call("gpt-5");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentBody().model).toBe("gpt-5-mini");
    expect(res.status).toBe(503);
    expect(res.headers.get("x-passcontrol-model-switched")).toBe("gpt-5 -> gpt-5-mini");
  });

  it("takes the policy's hourly counter once, switched or not", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry({ p: { max_requests_per_hour: 100 }, pss: undefined }));
    readPauseViewMock.mockResolvedValue({ tokens: null, cost: { limit_microcents: ON, used_microcents: 0, remaining_microcents: ON }, period: null });
    await call("gpt-5");
    const plain = rateLimitMock.mock.calls.length;
    rateLimitMock.mockClear();
    pastTheLine();
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry({ p: { max_requests_per_hour: 100 } }));
    await call("gpt-5");
    expect(sentBody(1).model).toBe("gpt-5-mini");
    expect(rateLimitMock.mock.calls.length).toBe(plain);
  });

  it("pauses an embeddings call rather than switch it: another model's vectors are another space", async () => {
    // An in-scope target, so a switch here would be sent, not refused for scope.
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry());
    const res = await POST(
      new Request("https://gateway.test/api/v1/openai/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", "x-api-key": DIRECT_KEY },
        body: JSON.stringify({ model: "gpt-5", input: "hi" }),
      }),
      { params: Promise.resolve({ provider: "openai", path: ["v1", "embeddings"] }) }
    );
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("blocked_budget_pause");
    expect(body.message).not.toMatch(/not switched/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks a streamed response too", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry());
    fetchMock.mockResolvedValue(
      new Response("data: {\"choices\":[]}\n\ndata: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
    );
    const res = await call("gpt-5", { stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-passcontrol-model-switched")).toBe("gpt-5 -> gpt-5-mini");
    await res.text();
  });
});

// L8 (1.6.0): the heads-up is checked after a charged call settles, for a periodic
// limit only, and a pause or a period refusal spends the period's heads-up.
describe("the heads-up before a limit", () => {
  const DAY = 2000; // $20.00 a day, in cents
  const below = () =>
    readPauseViewMock.mockResolvedValue({ tokens: null, cost: null, period: { kind: "day", limit_microcents: DAY * 1_000_000, used_microcents: 0, remaining_microcents: DAY * 1_000_000 } });
  beforeEach(() => {
    notices.clear();
    noteHeadsUpMock.mockClear();
    readPauseLiftMock.mockResolvedValue(false);
    readFallbacksMock.mockResolvedValue([]);
    below();
  });
  const settled = () => new Promise((r) => setTimeout(r, 0));

  it("is checked after a charged call under a daily limit, with the line and the switch", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry({ bc: null, pdp: "day", pdc: DAY }));
    const res = await call("gpt-5");
    expect(res.status).toBe(200);
    await settled();
    expect(noteHeadsUpMock).toHaveBeenCalledTimes(1);
    expect(noteHeadsUpMock.mock.calls[0]![0]).toMatchObject({
      agentId: directPrincipal.agentId,
      userId: directPrincipal.userId,
      kind: "day",
      capMicrocents: DAY * 1_000_000,
      pausePercent: 50,
      switchModel: "gpt-5-mini",
    });
  });

  it("is not checked with no periodic limit", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry({ pdp: null, pdc: null }));
    readPauseViewMock.mockResolvedValue({ tokens: null, cost: { limit_microcents: 1e9, used_microcents: 0, remaining_microcents: 1e9 }, period: null });
    await call("gpt-5");
    await settled();
    expect(noteHeadsUpMock).not.toHaveBeenCalled();
  });

  it("a pause refusal spends the period's heads-up", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry({ bc: null, pdp: "day", pdc: DAY, pss: undefined }));
    readPauseViewMock.mockResolvedValue({ tokens: null, cost: null, period: { kind: "day", limit_microcents: DAY * 1_000_000, used_microcents: 0.6 * DAY * 1_000_000, remaining_microcents: 0.4 * DAY * 1_000_000 } });
    const res = await call("gpt-5");
    expect((await res.json()).error).toBe("blocked_budget_pause");
    await settled();
    expect(notices.has(`headsup:${directPrincipal.agentId}:day`)).toBe(true);
  });
});

// L8b: while "Suspend it now" is out, each call reads taps off the request path.
describe("reading the heads-up's suspend taps", () => {
  beforeEach(() => {
    readPauseViewMock.mockResolvedValue({ tokens: null, cost: null, period: null });
    // The button is sent only with a daily or monthly limit, so only then is it read.
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry({ ppc: null, pss: undefined, ppk: false, bc: null, pdp: "day", pdc: 2000 }));
    pollMock.mockReset();
    stopOpenMock.mockReset();
    polled.clear();
  });

  it("reads Telegram once for twenty calls in a burst, not twenty times", async () => {
    stopOpenMock.mockResolvedValue(true);
    pollMock.mockResolvedValue({ state: "ok", decided: 0 });
    for (let i = 0; i < 20; i++) await call("gpt-5");
    await new Promise((r) => setTimeout(r, 0));
    expect(pollMock).toHaveBeenCalledTimes(1);
  });

  it("reads nothing for an agent with no daily or monthly limit", async () => {
    getCachedAgentPolicyMock.mockResolvedValue(policyEntry({ ppc: null, pss: undefined, ppk: false, pdp: null, pdc: null }));
    stopOpenMock.mockResolvedValue(true);
    await call("gpt-5");
    await new Promise((r) => setTimeout(r, 0));
    expect(stopOpenMock).not.toHaveBeenCalled();
    expect(pollMock).not.toHaveBeenCalled();
  });

  it("reads the taps while a button is out, and the call never waits on Telegram", async () => {
    stopOpenMock.mockResolvedValue(true);
    pollMock.mockReturnValue(new Promise(() => undefined)); // Telegram never answers
    const res = await call("gpt-5");
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(stopOpenMock).toHaveBeenCalledWith(directPrincipal.agentId);
    expect(pollMock).toHaveBeenCalledWith(directPrincipal.userId, 0, 1500);
  });

  it("reads nothing with no button out, or when Redis cannot say", async () => {
    stopOpenMock.mockResolvedValue(false);
    await call("gpt-5");
    stopOpenMock.mockRejectedValue(new Error("redis down"));
    expect((await call("gpt-5")).status).toBe(200);
    await new Promise((r) => setTimeout(r, 0));
    expect(pollMock).not.toHaveBeenCalled();
  });
});
