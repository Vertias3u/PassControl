// Bet D slice 5 (plans/delegation-design.md §6, §13): a WORKER's call through the
// provider route. The delegated visa (ver 3) names the root passport as `sub` and the
// parent agent as `agid`, so kill/suspend/budget apply to the whole tree for free.
// What is added and asserted here: the fail-closed revocation read, the chain's caps on
// the hold, a delegated call being dollar-limited even when the parent has no $ limit,
// and the audit row saying a worker made the call. Harness copied from
// tests/proxy-endpoint.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const establishBudgetStateMock = vi.fn();

import { PROVIDERS, providerRequiresEndpoint, usesOpenAiUsageShape } from "@/lib/providers";

const {
  verifyVisaMock,
  serviceClientMock,
  openHoldMock,
  settleHoldMock,
  getCachedKeyMock,
  getCachedEndpointMock,
  setCachedEndpointMock,
  setCachedKeyMock,
  getCachedAgentPolicyMock,
  setCachedAgentPolicyMock,
  readKillStateMock,
  isSuspendedMock,
  writeLogMock,
  mirrorSpendMock,
  rateLimitMock,
  readCredentialFenceMock,
  fetchMock,
} = vi.hoisted(() => {
  return {
    verifyVisaMock: vi.fn(),
    serviceClientMock: vi.fn(),
    openHoldMock: vi.fn(),
    settleHoldMock: vi.fn(),
    getCachedKeyMock: vi.fn(),
    getCachedEndpointMock: vi.fn(),
    setCachedEndpointMock: vi.fn(),
    setCachedKeyMock: vi.fn(),
    getCachedAgentPolicyMock: vi.fn(),
    setCachedAgentPolicyMock: vi.fn(),
    readKillStateMock: vi.fn(),
    isSuspendedMock: vi.fn(),
    writeLogMock: vi.fn(),
    mirrorSpendMock: vi.fn(),
    rateLimitMock: vi.fn(),
    readCredentialFenceMock: vi.fn(),
    fetchMock: vi.fn(),
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
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
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
  purgeAgentPolicy: vi.fn(),
  // The proxy reads this before the endpoint row and again before dispatch.
  // Omitted, it is undefined, the call throws, and the route 500s.
  //
  // Controllable per call, because the SECOND read is a decision point: equal
  // means dispatch, different means the operator rotated, and UNREADABLE means
  // neither has been established (T4-04).
  readCredentialFence: (...args: unknown[]) => readCredentialFenceMock(...args),
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
  getCachedEndpoint: (...args: unknown[]) => getCachedEndpointMock(...args),
  setCachedEndpoint: (...args: unknown[]) => setCachedEndpointMock(...args),
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
// Candidate 3's alert hook: what the route hands it after a settle (its own tests:
// tests/session-spend-alert*.test.ts).
const { noteSessionSpendMock } = vi.hoisted(() => ({ noteSessionSpendMock: vi.fn(async (_input: Record<string, unknown>) => false) }));
vi.mock("@/lib/alerts/session-spend", () => ({ noteSessionSpend: (input: Record<string, unknown>) => noteSessionSpendMock(input) }));

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
const { readDelegationRevocationMock } = vi.hoisted(() => ({ readDelegationRevocationMock: vi.fn() }));
vi.mock("@/lib/state/delegation", () => ({ readDelegationRevocation: (...a: unknown[]) => readDelegationRevocationMock(...a) }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: async () => "sealed", open: async (v: string) => v }));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...args: unknown[]) => rateLimitMock(...args) }));

import { POST, GET } from "@/app/api/v1/[provider]/[...path]/route";

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

function req(body: unknown) {
  return new Request("https://gateway.test/api/v1/openai/v1/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callProxy(provider: string, path: string[], model: string) {
  verifyVisaMock.mockResolvedValue({
    ...baseClaims,
    scope: [{ provider, models: [model] }],
  });
  return POST(req({ model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }), {
    params: Promise.resolve({ provider, path }),
  });
}

// A GET with no body/model (e.g. /v1/models). Scope is [] on purpose — the model
// listing endpoint must NOT depend on the per-model scope.
function getReq() {
  return new Request("https://gateway.test/api/v1/openai/v1/models", {
    method: "GET",
    headers: { authorization: "Bearer visa" },
  });
}
async function getProxy(provider: string, path: string[]) {
  verifyVisaMock.mockResolvedValue({ ...baseClaims, scope: [{ provider, models: ["nothing-*"] }] });
  return GET(getReq(), { params: Promise.resolve({ provider, path }) });
}

beforeEach(() => {
  verifyVisaMock.mockReset();
  serviceClientMock.mockReset();
  openHoldMock.mockReset();
  settleHoldMock.mockReset();
  getCachedKeyMock.mockReset();
  getCachedEndpointMock.mockReset();
  setCachedEndpointMock.mockReset();
  setCachedKeyMock.mockReset();
  getCachedAgentPolicyMock.mockReset();
  setCachedAgentPolicyMock.mockReset();
  readKillStateMock.mockReset();
  isSuspendedMock.mockReset();
  writeLogMock.mockReset();
  mirrorSpendMock.mockReset();
  rateLimitMock.mockReset();
  readCredentialFenceMock.mockReset();
  readCredentialFenceMock.mockResolvedValue(null);
  fetchMock.mockReset();

  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: "provider-key", error: null })),
  });
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1 });
  settleHoldMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue(null);
  getCachedEndpointMock.mockResolvedValue(null);
  setCachedEndpointMock.mockResolvedValue(undefined);
  setCachedKeyMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null }));
  setCachedAgentPolicyMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, tenantKill: false, denylist: [] });
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


const NOW_S = Math.floor(Date.now() / 1000);
const WORKER = "W".repeat(43);
const LINKS = [
  { dlg: "jti-0000000000000001", cap: 5_000_000, iat: NOW_S - 10, exp: NOW_S + 600 },
  { dlg: "jti-0000000000000002", cap: 1_000_000, iat: NOW_S - 5, exp: NOW_S + 300 },
];
const delegatedClaims = (model: string, provider = "openai") => ({
  ...baseClaims,
  ver: 3,
  scope: [{ provider, models: [model] }],
  act: { sub: WORKER, dlg: LINKS[1]!.dlg, dep: 2, ch: "c".repeat(43) },
  dc: LINKS,
});
async function delegatedCall(model = "gpt-4o-mini") {
  verifyVisaMock.mockResolvedValue(delegatedClaims(model));
  return POST(req({ model, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }), {
    params: Promise.resolve({ provider: "openai", path: ["v1", "chat", "completions"] }),
  });
}

describe("a worker's call (delegated visa)", () => {
  beforeEach(() => {
    readDelegationRevocationMock.mockReset();
    readDelegationRevocationMock.mockResolvedValue(false);
  });

  it("is admitted, with every link's cap on the hold and a cost estimate", async () => {
    const res = await delegatedCall();
    expect(res.status).toBe(200);
    expect(readDelegationRevocationMock).toHaveBeenCalledWith("agent-id", LINKS);
    const hold = openHoldMock.mock.calls[0]![0];
    expect(hold.delegation).toEqual({
      links: [
        { jti: "jti-0000000000000001", capMicrocents: 5_000_000 },
        { jti: "jti-0000000000000002", capMicrocents: 1_000_000 },
      ],
    });
    expect(hold.estimateMicrocents).toBeGreaterThan(0);
  });

  it("writes an audit row that says a worker made the call", async () => {
    await delegatedCall();
    const row = writeLogMock.mock.calls.map((c) => c[0]).find((r) => r.status === "ok");
    expect(row).toMatchObject({
      authMethod: "delegated",
      passportId: "passport-id",
      delegation: {
        jti: "jti-0000000000000002",
        actor: WORKER,
        chainHash: "c".repeat(43),
        links: ["jti-0000000000000001", "jti-0000000000000002"],
      },
    });
  });

  it("refuses a revoked delegation with 403 before anything is reserved or sent", async () => {
    readDelegationRevocationMock.mockResolvedValue(true);
    const res = await delegatedCall();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "delegation_revoked" });
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked_delegation_revoked", authMethod: "delegated" }));
  });

  it("fails CLOSED when the revocation read fails (P2.3), unlike the kill switch", async () => {
    readDelegationRevocationMock.mockRejectedValue(new Error("redis down"));
    const res = await delegatedCall();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "delegation_state_unavailable" });
    expect(openHoldMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers a spent link with 402 blocked_budget_delegation, sending nothing", async () => {
    openHoldMock.mockResolvedValue({ ok: false, reason: "delegation" });
    const res = await delegatedCall();
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("blocked_budget_delegation");
    // The hold is what did not fit, not spend: say so (2026-10-10).
    expect(body.message).not.toMatch(/has used/i);
    expect(body.message).toMatch(/could cost/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeLogMock).toHaveBeenCalledWith(expect.objectContaining({ status: "blocked_budget_delegation" }));
  });

  it("answers a missing ledger with 503 delegation_state_unavailable", async () => {
    openHoldMock.mockResolvedValue({ ok: false, reason: "delegation_state" });
    const res = await delegatedCall();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("delegation_state_unavailable");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is dollar-limited even when the parent has no $ limit: an unpriced model is refused", async () => {
    const res = await delegatedCall("gpt-not-a-priced-model-xyz");
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("unpriced_model");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves an ordinary passport call untouched: no revocation read, no delegation", async () => {
    const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-4o-mini");
    expect(res.status).toBe(200);
    expect(readDelegationRevocationMock).not.toHaveBeenCalled();
    expect(openHoldMock.mock.calls[0]![0].delegation).toBeUndefined();
    const row = writeLogMock.mock.calls.map((c) => c[0]).find((r) => r.status === "ok");
    expect(row.authMethod).toBe("passport");
    expect(row.delegation).toBeUndefined();
  });

  it("the same unpriced model is NOT refused for an ordinary agent with no $ limit", async () => {
    const res = await callProxy("openai", ["v1", "chat", "completions"], "gpt-not-a-priced-model-xyz");
    expect(res.status).not.toBe(402);
  });

  it("is refused by the demo handler, which enforces no delegation caps", async () => {
    vi.stubEnv("PASSCONTROL_DEMO", "1");
    verifyVisaMock.mockResolvedValue(delegatedClaims("demo-model", "demo"));
    const res = await POST(req({ model: "demo-model", messages: [] }), { params: Promise.resolve({ provider: "demo", path: ["v1", "chat", "completions"] }) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "delegated_visa_not_accepted" });
  });
});
