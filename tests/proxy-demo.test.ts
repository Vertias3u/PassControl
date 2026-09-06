import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const establishBudgetStateMock = vi.fn();

// The keyless `demo` provider must run the FULL governance pipeline (visa, kill,
// scope, budget) and only replace the Vault-key resolution + upstream forward
// with a locally synthesized response. These tests lock that contract:
//   - a governed demo call returns 200 WITHOUT calling get_provider_key or fetch
//   - the kill switch blocks it
//   - scope is enforced
//   - it is 404 (prod-safe) unless PASSCONTROL_DEMO=1
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
  };
});

// The proxy now reaches lib/demo/identity.ts to tell the seeded PUBLIC demo
// passport apart from a tenant that holds a demo scope. That module is
// `server-only`, which Next enforces at build time and vitest cannot resolve
// at all — same stub tests/site-demo-routes.test.ts already uses.
vi.mock("server-only", () => ({}));
vi.mock("@vercel/functions", () => ({ waitUntil: (p: unknown) => p }));
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
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: async () => "sealed", open: async (v: string) => v }));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
  mirrorSpend: (...args: unknown[]) => mirrorSpendMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...args: unknown[]) => rateLimitMock(...args) }));

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
  scope: [{ provider: "demo", models: ["*"] }],
};

function demoRequest(body?: unknown) {
  return new Request("https://gateway.test/api/v1/demo/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer visa", "content-type": "application/json" },
    body: JSON.stringify(
      body ?? { model: "demo-1", max_tokens: 16, messages: [{ role: "user", content: "hi there" }] }
    ),
  });
}

async function callDemo(body?: unknown) {
  return POST(demoRequest(body), {
    params: Promise.resolve({ provider: "demo", path: ["chat", "completions"] }),
  });
}

beforeEach(() => {
  verifyVisaMock.mockReset();
  serviceClientMock.mockReset();
  openHoldMock.mockReset();
  settleHoldMock.mockReset();
  establishBudgetStateMock.mockReset();
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

  verifyVisaMock.mockResolvedValue(baseClaims);
  serviceClientMock.mockReturnValue({
    rpc: vi.fn(async () => ({ data: "SHOULD-NOT-RESOLVE-A-KEY", error: null })),
  });
  openHoldMock.mockResolvedValue({ ok: true, reserved: 1 });
  settleHoldMock.mockResolvedValue(undefined);
  establishBudgetStateMock.mockResolvedValue(undefined);
  getCachedKeyMock.mockResolvedValue(null);
  setCachedKeyMock.mockResolvedValue(undefined);
  getCachedAgentPolicyMock.mockResolvedValue(JSON.stringify({ p: {}, s: null }));
  setCachedAgentPolicyMock.mockResolvedValue(undefined);
  readKillStateMock.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  writeLogMock.mockResolvedValue(undefined);
  mirrorSpendMock.mockResolvedValue(undefined);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  vi.stubGlobal("fetch", fetchMock);
  process.env.PASSCONTROL_DEMO = "1";
});

afterEach(() => {
  delete process.env.PASSCONTROL_DEMO;
});

describe("keyless demo provider", () => {
  it("governs a demo call and returns 200 without touching the Vault or upstream", async () => {
    const rpc = vi.fn(async () => ({ data: "SHOULD-NOT-RESOLVE-A-KEY", error: null }));
    serviceClientMock.mockReturnValue({ rpc });

    const res = await callDemo();

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(JSON.stringify(json)).toMatch(/demo/i);
    // The whole point: the credential path is never reached.
    expect(rpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    // But governance IS real: budget reserved + reconciled, logged as ok.
    expect(openHoldMock).toHaveBeenCalled();
    expect(settleHoldMock).toHaveBeenCalled();
    expect(writeLogMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "demo", status: "ok" })
    );
  });

  // The demo opens and settles a REAL hold against the SAME counters as a billed
  // call — that is deliberate, and it is what makes the budget and kill demos
  // honest rather than theatre. It follows that the demo cannot be laxer than
  // the proxy about the durable generation those counters are fenced by. If the
  // generation write fails and the call is answered anyway, a later Redis loss
  // reads the agent as never-established and hands its whole cap back.
  //
  // That was survivable only while a demo-scoped agent could not also hold a
  // real provider scope. `passcontrol login` asks for exactly that pair, and the
  // control plane now accepts it, so the same `budget_epoch` fences demo calls
  // and billed calls alike. The two-sided contract has to hold on both paths.
  it("does not answer a demo call when the budget generation cannot be persisted", async () => {
    openHoldMock.mockResolvedValue({ ok: true, reserved: 1, epochToPersist: "epoch-1" });
    establishBudgetStateMock.mockRejectedValue(new Error("statement timeout"));

    const res = await callDemo();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "blocked_budget_state" });
    // Nothing was synthesized, so the reservation must go back. This returns
    // above the response, so a full release is the honest ending.
    expect(settleHoldMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "not_dispatched" })
    );
  });

  it("answers normally once the generation is durable", async () => {
    openHoldMock.mockResolvedValue({ ok: true, reserved: 1, epochToPersist: "epoch-1" });

    const res = await callDemo();

    expect(res.status).toBe(200);
    expect(establishBudgetStateMock).toHaveBeenCalledWith(expect.any(String), "epoch-1");
  });

  it("blocks a demo call when the kill switch is armed", async () => {
    readKillStateMock.mockResolvedValue({ platformKill: false, userKill: true, denylist: [] });

    const res = await callDemo();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_suspended" });
    expect(openHoldMock).not.toHaveBeenCalled();
  });

  it("enforces scope on demo calls", async () => {
    verifyVisaMock.mockResolvedValue({
      ...baseClaims,
      scope: [{ provider: "openai", models: ["*"] }],
    });

    const res = await callDemo();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "blocked_scope" });
  });

  it("is 404 (prod-safe) unless PASSCONTROL_DEMO is enabled", async () => {
    delete process.env.PASSCONTROL_DEMO;

    const res = await callDemo();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown_provider" });
  });

  it("requires a visa", async () => {
    const req = new Request("https://gateway.test/api/v1/demo/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const res = await POST(req, {
      params: Promise.resolve({ provider: "demo", path: ["chat", "completions"] }),
    });
    expect(res.status).toBe(401);
  });
});
