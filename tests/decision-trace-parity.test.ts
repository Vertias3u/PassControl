// Proxy-vs-trace verdict parity.
//
// lib/gate.ts guarantees the two paths share step LOGIC, and tests/gate.test.ts
// covers that evaluator directly. What neither proves is that they agree on the
// INPUTS: the proxy assembles them across several staged evaluateGate() calls
// while the trace assembles them once. A divergence would live there, and it is
// exactly the divergence that makes a decision trace worse than no trace at all
// — a UI that says "allowed" for a call the gateway would refuse.
//
// So this drives the REAL proxy route and the REAL trace evaluator against one
// shared world, and asserts they reach the same verdict for every step.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  verifyVisaMock: vi.fn(),
  serviceClientMock: vi.fn(),
  readKillStateMock: vi.fn(),
  isSuspendedMock: vi.fn(),
  reserveBudgetMock: vi.fn(),
  reconcileBudgetMock: vi.fn(),
  readBudgetSnapshotMock: vi.fn(),
  getCachedKeyMock: vi.fn(),
  setCachedKeyMock: vi.fn(),
  getCachedAgentPolicyMock: vi.fn(),
  setCachedAgentPolicyMock: vi.fn(),
  seedSpentMock: vi.fn(),
  claimNonceMock: vi.fn(),
  readCurrentAgentPolicyMock: vi.fn(),
  rateLimitMock: vi.fn(),
  peekRateLimitMock: vi.fn(),
  writeLogMock: vi.fn(),
  mirrorSpendMock: vi.fn(),
  captureSecurityEventMock: vi.fn(),
  logFailOpenMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock("@vercel/functions", () => ({ waitUntil: (p: unknown) => p }));
vi.mock("@/lib/auth/visa", () => ({
  extractVisaToken: (headers: Headers) =>
    headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "",
  verifyVisa: (...a: unknown[]) => h.verifyVisaMock(...a),
}));
vi.mock("@/lib/state/killswitch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/state/killswitch")>();
  return { ...actual, readKillState: (...a: unknown[]) => h.readKillStateMock(...a) };
});
vi.mock("@/lib/state/redis", () => ({
  isSuspended: (...a: unknown[]) => h.isSuspendedMock(...a),
  reserveBudget: (...a: unknown[]) => h.reserveBudgetMock(...a),
  reconcileBudget: (...a: unknown[]) => h.reconcileBudgetMock(...a),
  readBudgetSnapshot: (...a: unknown[]) => h.readBudgetSnapshotMock(...a),
  getCachedKey: (...a: unknown[]) => h.getCachedKeyMock(...a),
  setCachedKey: (...a: unknown[]) => h.setCachedKeyMock(...a),
  getCachedAgentPolicy: (...a: unknown[]) => h.getCachedAgentPolicyMock(...a),
  setCachedAgentPolicy: (...a: unknown[]) => h.setCachedAgentPolicyMock(...a),
  seedSpent: (...a: unknown[]) => h.seedSpentMock(...a),
  claimNonce: (...a: unknown[]) => h.claimNonceMock(...a),
}));
vi.mock("@/lib/state/policy", () => ({
  readCurrentAgentPolicy: (...a: unknown[]) => h.readCurrentAgentPolicyMock(...a),
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => h.serviceClientMock() }));
vi.mock("@/lib/crypto/aesgcm", () => ({
  seal: async () => "sealed",
  open: async (v: string) => v,
}));
vi.mock("@/lib/log", () => ({
  writeLog: (...a: unknown[]) => h.writeLogMock(...a),
  mirrorSpend: (...a: unknown[]) => h.mirrorSpendMock(...a),
}));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: (...a: unknown[]) => h.rateLimitMock(...a),
  peekRateLimit: (...a: unknown[]) => h.peekRateLimitMock(...a),
}));
vi.mock("@/lib/observability", () => ({
  captureError: vi.fn(async () => undefined),
  captureSecurityEvent: (...a: unknown[]) => h.captureSecurityEventMock(...a),
  logFailOpen: (...a: unknown[]) => h.logFailOpenMock(...a),
}));

import { POST } from "@/app/api/v1/[provider]/[...path]/route";
import { evaluateDecisionTrace } from "@/app/api/control/v1/agents/[id]/trace/decision-trace";

const USER_ID = "tenant-a";
const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const PROVIDER = "openai";
const MODEL = "gpt-4.1";
const AT = new Date("2026-07-31T12:00:00.000Z");

/** One description of the world, consumed by BOTH paths through the mocks. */
interface World {
  killed: boolean;
  suspended: boolean;
  scope: { provider: string; models: string[] }[];
  policy: unknown;
  budgetTokens: number | null;
  spentTokens: number;
}

function base(): World {
  return {
    killed: false,
    suspended: false,
    scope: [{ provider: PROVIDER, models: ["*"] }],
    policy: {},
    budgetTokens: null,
    spentTokens: 0,
  };
}

function applyWorld(w: World) {
  h.readKillStateMock.mockResolvedValue({
    platformKill: w.killed,
    userKill: false,
    denylist: [],
  });
  h.isSuspendedMock.mockResolvedValue(w.suspended);
  h.readCurrentAgentPolicyMock.mockResolvedValue(w.policy);
  h.verifyVisaMock.mockResolvedValue({
    sub: "passport-id",
    agid: AGENT_ID,
    uid: USER_ID,
    jti: "jti-1",
    bt: w.budgetTokens,
    bc: null,
    st: w.spentTokens,
    sc: 0,
    ver: 1,
    scope: w.scope,
  });

  // Proxy: the atomic reserve enforces the token cap.
  h.reserveBudgetMock.mockImplementation(async ({ estimate }: { estimate: number }) => {
    if (w.budgetTokens === null) return { ok: true };
    return { ok: w.spentTokens + estimate <= w.budgetTokens };
  });
  // Trace: the same cap, read rather than reserved.
  h.readBudgetSnapshotMock.mockResolvedValue({
    reservedTokens: 0,
    spentTokens: w.spentTokens,
    reservedCostMicrocents: 0,
    spentCostMicrocents: 0,
  });

  // The agents row the trace reads. Kept consistent with the visa claims above,
  // because the point of this test is agreement, not a contrived disagreement.
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({
      data: {
        id: AGENT_ID,
        status: w.suspended ? "suspended" : "active",
        allowed_scopes: w.scope,
        budget_tokens: w.budgetTokens,
        budget_cents: null,
        policy: w.policy,
      },
      error: null,
    }),
  };
  h.serviceClientMock.mockReturnValue({ from: () => builder, rpc: vi.fn() });
  return builder;
}

// The proxy deliberately answers the WIRE with one opaque code for both kill and
// suspend, so a caller cannot probe which control fired. Its audit row records
// the control that actually fired, and that is the decision to compare against —
// comparing wire codes would compare a security feature, not the verdict.
async function proxyVerdict(w: World): Promise<string> {
  applyWorld(w);
  h.writeLogMock.mockClear();
  const res = await POST(
    new Request(`https://gateway.test/api/v1/${PROVIDER}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer visa", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 10, messages: [{ role: "user", content: "hi" }] }),
    }),
    { params: Promise.resolve({ provider: PROVIDER, path: ["chat", "completions"] }) }
  );
  if (res.status === 200) return "allow";
  const logged = h.writeLogMock.mock.calls.at(-1)?.[0] as { status?: string } | undefined;
  if (logged?.status) return logged.status;
  const body = (await res.json()) as { error?: string };
  return body.error ?? `status_${res.status}`;
}

// The trace names steps; the audit log names outcomes. Same decision, two
// vocabularies — this is the only translation in the test.
const STEP_TO_STATUS: Record<string, string> = {
  kill: "blocked_killed",
  suspend: "blocked_suspended",
  scope: "blocked_scope",
  endpoint: "blocked_endpoint",
  policy: "blocked_policy",
  budget: "blocked_budget",
};

/** Collapse a trace result to the same vocabulary. */
async function traceVerdict(w: World): Promise<string> {
  const builder = applyWorld(w);
  const result = await evaluateDecisionTrace({
    db: { from: () => builder } as never,
    userId: USER_ID,
    agentId: AGENT_ID,
    provider: PROVIDER,
    model: MODEL,
    evaluatedAt: AT,
    policyAt: AT,
  });
  if (!result.ok) return `error_${result.code}`;
  if (result.trace.verdict === "allow") return "allow";
  const failed = result.trace.steps.find((s) => s.status === "fail")?.name ?? "unknown";
  return STEP_TO_STATUS[failed] ?? `blocked_${failed}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.rateLimitMock.mockResolvedValue({ success: true, remaining: 10 });
  h.peekRateLimitMock.mockResolvedValue({ success: true, remaining: 10 });
  h.getCachedKeyMock.mockResolvedValue("sealed-provider-key");
  h.reconcileBudgetMock.mockResolvedValue(undefined);
  h.writeLogMock.mockResolvedValue(undefined);
  h.mirrorSpendMock.mockResolvedValue(undefined);
  h.claimNonceMock.mockResolvedValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    )
  );
});

describe("proxy and decision trace agree", () => {
  // `endpoint` is deliberately absent: the trace always evaluates the provider's
  // default chat path, so there is no way to drive both paths at a disallowed
  // endpoint. gate.test.ts covers that step directly.
  const cases: Array<[string, World, string]> = [
    ["a fully allowed call", base(), "allow"],
    ["the kill switch armed", { ...base(), killed: true }, "blocked_killed"],
    ["the agent suspended", { ...base(), suspended: true }, "blocked_suspended"],
    [
      "a model outside scope",
      { ...base(), scope: [{ provider: PROVIDER, models: ["claude-*"] }] },
      "blocked_scope",
    ],
    [
      "a policy deny rule",
      { ...base(), policy: { deny: [{ provider: PROVIDER, models: ["gpt-4*"] }] } },
      "blocked_policy",
    ],
    [
      "an exhausted token budget",
      { ...base(), budgetTokens: 10, spentTokens: 10 },
      "blocked_budget",
    ],
  ];

  it.each(cases)("%s", async (_name, world, expected) => {
    const fromProxy = await proxyVerdict(world);
    const fromTrace = await traceVerdict(world);
    expect(fromProxy).toBe(expected);
    expect(fromTrace).toBe(expected);
    expect(fromTrace).toBe(fromProxy);
  });

  // The posture that only exists since the review fix: an unreadable policy row
  // is not a deny, and the trace must not render it as a pass either.
  it("agrees that an unreadable policy is allowed under the fail-open default", async () => {
    const { POLICY_UNREADABLE } = await import("@/lib/gate");
    const world = { ...base(), policy: POLICY_UNREADABLE };
    expect(await proxyVerdict(world)).toBe("allow");
    const trace = await traceVerdict(world);
    expect(trace).toBe("allow");
  });
});
