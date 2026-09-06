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
  openHoldMock: vi.fn(),
  establishBudgetStateMock: vi.fn(),
  settleHoldMock: vi.fn(),
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

// The proxy now reaches lib/demo/identity.ts to tell the seeded PUBLIC demo
// passport apart from a tenant that holds a demo scope. That module is
// `server-only`, which Next enforces at build time and vitest cannot resolve
// at all — same stub tests/site-demo-routes.test.ts already uses.
vi.mock("server-only", () => ({}));
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
  purgeAgentPolicy: vi.fn(),
  isSuspended: (...a: unknown[]) => h.isSuspendedMock(...a),
  readBudgetSnapshot: (...a: unknown[]) => h.readBudgetSnapshotMock(...a),
  getCachedKey: (...a: unknown[]) => h.getCachedKeyMock(...a),
  setCachedKey: (...a: unknown[]) => h.setCachedKeyMock(...a),
  getCachedAgentPolicy: (...a: unknown[]) => h.getCachedAgentPolicyMock(...a),
  setCachedAgentPolicy: (...a: unknown[]) => h.setCachedAgentPolicyMock(...a),
  claimNonce: (...a: unknown[]) => h.claimNonceMock(...a),
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
    const r = await h.settleHoldMock({ ...p, outcome });
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
    openHold: (...args: unknown[]) => h.openHoldMock(...args),
    // Always granted here: these suites assert what the proxy does AROUND the
    // dispatch boundary, not the boundary itself (tests/proxy-dispatch-permission.test.ts).
    consumeDispatchPermission: async () => ({ granted: true }),
    settleKnown: (p: Record<string, unknown>) => settle("complete", p),
    settleUnknown: (p: Record<string, unknown>) => settle("usage_unknown", p),
    releaseUndispatched: (p: Record<string, unknown>) => settle("not_dispatched", p),
    establishBudgetState: (...args: unknown[]) => h.establishBudgetStateMock(...args),
  };
});
// Both readers, driven by ONE mock. The trace takes the live policy alone; the
// proxy takes the pair. Letting them diverge here would let this file report
// parity between a proxy and a trace that had been told different things —
// which is the single thing it exists to rule out. `shadow: null` throughout:
// shadow mode must not be able to move a verdict, so parity is asserted with it
// off, and tests/proxy-policy.test.ts is where it is asserted with it on.
vi.mock("@/lib/state/policy", () => ({
  readCurrentAgentPolicy: (...a: unknown[]) => h.readCurrentAgentPolicyMock(...a),
  readCurrentAgentPolicyAndShadow: async (...a: unknown[]) => ({
    policy: await h.readCurrentAgentPolicyMock(...a),
    shadow: null,
  }),
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
  h.openHoldMock.mockImplementation(async ({ estimate }: { estimate: number }) => {
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
  h.settleHoldMock.mockResolvedValue(undefined);
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

// The cases above drive both paths against one world, which is the strongest
// form of this guarantee — but they cannot reach the demo provider, because the
// proxy answers it from a separate handler behind its own URL segment. The
// input those two paths must agree on there is the RATE, and it had drifted:
// the proxy charged a flat micro-cent per token while the trace priced demo
// through `costMicrocents`, which has no row for it and answers 0. The panel
// therefore called every demo call affordable, including ones the gateway would
// refuse. So the rate gets the treatment a shared input deserves: one
// definition, asserted to be the one both readers use.
describe("the demo rate is one number, not two", () => {
  it("is charged and projected through the same helper", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");
    const proxy = read("app/api/v1/[provider]/[...path]/route.ts");
    const trace = read("app/api/control/v1/agents/[id]/trace/decision-trace.ts");

    expect(proxy).toMatch(/demoCostMicrocents\(/u);
    expect(trace).toMatch(/demoCostMicrocents\(/u);
    // And neither one re-declares the rate, which is how they came apart.
    expect(proxy).not.toMatch(/MICROCENTS_PER_TOKEN\s*=/u);
    expect(trace).not.toMatch(/MICROCENTS_PER_TOKEN\s*=/u);
  });

  it("prices a demo call per token, and never below zero", async () => {
    const { demoCostMicrocents, DEMO_MICROCENTS_PER_TOKEN } = await import("@/lib/pricing");
    expect(demoCostMicrocents(1_000)).toBe(1_000 * DEMO_MICROCENTS_PER_TOKEN);
    expect(demoCostMicrocents(0)).toBe(0);
    expect(demoCostMicrocents(-5)).toBe(0);
  });

  it("still refuses to price demo as if it were a real provider", async () => {
    const { costMicrocents } = await import("@/lib/pricing");
    // A pricing row for demo would give a `demo` string a cost anywhere a real
    // provider is expected. The zero here is correct — it is relying on it that
    // was the bug.
    expect(costMicrocents("demo-1", 100, 100, "demo" as never)).toBe(0);
  });
});

// Codex's finding, kept as the case it found and driven at the size it compares.
//
// The panel has no request body, so it projected `estimateTokenUsage`'s default
// 1024-token output allowance — which is EXACTLY what the gateway projects for a
// body naming no maximum, and less than it projects for `max_tokens: 2000`. With
// 1,500 tokens of headroom the trace said allow and the gateway then refused 402.
// Nothing about the panel's arithmetic was wrong; the size was never part of the
// question, so the two were answering different ones.
//
// The size is now part of the question, and both halves are pinned: asked about
// the same call, they agree; asked about a default-shaped call, they still agree.
it("does not project allow for a demo request the gateway refuses on its output allowance", async () => {
  const world = { ...base(), scope: [{ provider: "demo", models: ["*"] }], budgetTokens: 1500 };
  const builder = applyWorld(world);
  const trace = await evaluateDecisionTrace({
    db: { from: () => builder } as never,
    userId: USER_ID,
    agentId: AGENT_ID,
    provider: "demo",
    model: "demo-1",
    maxOutputTokens: 2000,
    evaluatedAt: AT,
    policyAt: AT,
  });
  const previousDemo = process.env.PASSCONTROL_DEMO;
  process.env.PASSCONTROL_DEMO = "1";
  try {
    // Real route and real estimators, using this file's shared cap-enforcing
    // hold boundary. No concurrent spend or different policy explains the gap.
    const response = await POST(new Request("https://gateway.test/api/v1/demo/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer visa", "content-type": "application/json" },
      body: JSON.stringify({ model: "demo-1", max_tokens: 2000 }),
    }), { params: Promise.resolve({ provider: "demo", path: ["chat", "completions"] }) });
    expect(h.openHoldMock).toHaveBeenCalledWith(expect.objectContaining({ estimate: 2001, capTokens: 1500 }));
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: "blocked_budget" });
    expect(trace.ok).toBe(true);
    if (!trace.ok) throw new Error("trace did not evaluate");
    expect(trace.trace.verdict).not.toBe("allow");
    // The refusal states the room too. Found in a browser, not here: the allow
    // path carried the headroom and the deny path did not, so the one message
    // that most needs the number — "cannot reserve 2001" — was the one without
    // it, and a reader could not tell whether they were 500 over or 500,000.
    const budget = trace.trace.steps.find((step) => step.name === "budget");
    expect(budget?.status).toBe("fail");
    expect(budget?.reason).toMatch(/cannot reserve 2001 estimated tokens/u);
    expect(budget?.reason).toMatch(/1500 tokens of remaining budget/u);
  } finally {
    if (previousDemo === undefined) delete process.env.PASSCONTROL_DEMO;
    else process.env.PASSCONTROL_DEMO = previousDemo;
  }
});

it("agrees with the gateway on a default-shaped demo call, and says what it assumed", async () => {
  const world = { ...base(), scope: [{ provider: "demo", models: ["*"] }], budgetTokens: 1500 };
  const builder = applyWorld(world);
  const trace = await evaluateDecisionTrace({
    db: { from: () => builder } as never,
    userId: USER_ID,
    agentId: AGENT_ID,
    provider: "demo",
    model: "demo-1",
    evaluatedAt: AT,
    policyAt: AT,
  });
  const previousDemo = process.env.PASSCONTROL_DEMO;
  process.env.PASSCONTROL_DEMO = "1";
  try {
    const response = await POST(new Request("https://gateway.test/api/v1/demo/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer visa", "content-type": "application/json" },
      body: JSON.stringify({ model: "demo-1" }),
    }), { params: Promise.resolve({ provider: "demo", path: ["chat", "completions"] }) });

    expect(response.status).toBe(200);
    expect(trace.ok).toBe(true);
    if (!trace.ok) throw new Error("trace did not evaluate");
    expect(trace.trace.verdict).toBe("allow");
    // An allow whose assumption is invisible is the defect above wearing a
    // different hat, so the projected size and the room left are both on the
    // step the operator reads.
    const budget = trace.trace.steps.find((step) => step.name === "budget");
    expect(budget?.reason).toMatch(/projects 1025 tokens/u);
    expect(budget?.reason).toMatch(/1500 tokens of remaining budget/u);
  } finally {
    if (previousDemo === undefined) delete process.env.PASSCONTROL_DEMO;
    else process.env.PASSCONTROL_DEMO = previousDemo;
  }
});
