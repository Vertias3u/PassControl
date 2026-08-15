// The decision trace while a break-glass elevation is live.
//
// The trace reads `allowed_scopes` off the agents row. The proxy gates on the
// scope snapshot inside the visa, which during an elevation is WIDER. Left
// alone, the simulator on the agent page would report "denied by scope" for
// calls that actually succeed — and it would do so precisely when someone is
// most likely to be consulting it, which is during an incident.
//
// So the trace unions the grant in, exactly as the challenge route does, and
// then SAYS SO. Both halves matter: agreeing silently would make the snapshot
// answer a different question from the one printed on it, and a reader
// comparing it against the agent's stored scope would have no way to explain
// the result.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  readKillState: vi.fn(),
  isSuspended: vi.fn(),
  readBudgetSnapshot: vi.fn(),
  readCurrentAgentPolicy: vi.fn(),
  peekRateLimit: vi.fn(),
  readLiveGrant: vi.fn(),
}));

vi.mock("@/lib/state/killswitch", () => ({
  readKillState: (...a: unknown[]) => h.readKillState(...a),
}));
vi.mock("@/lib/state/redis", () => ({
  isSuspended: (...a: unknown[]) => h.isSuspended(...a),
  readBudgetSnapshot: (...a: unknown[]) => h.readBudgetSnapshot(...a),
}));
vi.mock("@/lib/state/policy", () => ({
  readCurrentAgentPolicy: (...a: unknown[]) => h.readCurrentAgentPolicy(...a),
}));
vi.mock("@/lib/ratelimit", () => ({ peekRateLimit: (...a: unknown[]) => h.peekRateLimit(...a) }));
// unionScopes is deliberately NOT mocked — the trace must use the same merge the
// challenge route uses, and a stub here would hide a divergence between them.
vi.mock("@/lib/break-glass", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/break-glass")>()),
  readLiveGrant: (...a: unknown[]) => h.readLiveGrant(...a),
}));

import { evaluateDecisionTrace } from "@/app/api/control/v1/agents/[id]/trace/decision-trace";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";
const AT = new Date("2026-08-07T12:00:00.000Z");

// Scoped to openai only. The elevation is what adds anthropic.
const agentRow = {
  id: AGENT_ID,
  status: "active",
  allowed_scopes: [{ provider: "openai", models: ["gpt-4*"] }],
  budget_tokens: null,
  budget_cents: null,
  spent_tokens: 0,
  spent_microcents: 0,
};

const db = () => {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: agentRow, error: null }),
  });
  return { from: () => builder, rpc: vi.fn() } as never;
};

const trace = (provider: "openai" | "anthropic", model: string) =>
  evaluateDecisionTrace({
    db: db(),
    userId: USER_ID,
    agentId: AGENT_ID,
    provider,
    model,
    evaluatedAt: AT,
    policyAt: AT,
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.readKillState.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  h.isSuspended.mockResolvedValue(false);
  h.readBudgetSnapshot.mockResolvedValue({
    reservedTokens: 0,
    spentTokens: null,
    reservedMicrocents: 0,
    spentMicrocents: null,
  });
  h.readCurrentAgentPolicy.mockResolvedValue({});
  h.peekRateLimit.mockResolvedValue({ success: true, remaining: 10 });
  h.readLiveGrant.mockResolvedValue(null);
});

describe("with no elevation", () => {
  it("denies a provider outside the stored scope", async () => {
    const result = await trace("anthropic", "claude-opus-4-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.verdict).toBe("deny");
    expect(result.trace.denied_by).toBe("scope");
    expect(result.trace).not.toHaveProperty("break_glass");
  });

  it("allows one inside it", async () => {
    const result = await trace("openai", "gpt-4o");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.trace.verdict).toBe("allow");
  });
});

describe("with a live elevation", () => {
  const grant = {
    id: "g1",
    scopes: [{ provider: "anthropic", models: ["claude-opus-4-*"] }],
    reason: "incident 412 — reprocessing the overnight backlog",
    expiresAt: new Date(AT.getTime() + 900_000).toISOString(),
    createdAt: AT.toISOString(),
  };

  beforeEach(() => h.readLiveGrant.mockResolvedValue(grant));

  /**
   * The whole point. Before this, the simulator on the agent page said "denied
   * by scope" for a call the gateway would have allowed — during an incident,
   * which is the one time anyone runs it.
   */
  it("allows what the elevation grants, matching what a visa would carry", async () => {
    const result = await trace("anthropic", "claude-opus-4-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.verdict).toBe("allow");
    expect(result.trace.denied_by).toBeUndefined();
  });

  it("declares the elevation, with its deadline and its reason", async () => {
    const result = await trace("anthropic", "claude-opus-4-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.break_glass).toEqual({
      expires_at: grant.expiresAt,
      reason: grant.reason,
    });
  });

  it("still denies a provider the elevation did not grant", async () => {
    const result = await trace("openai", "o3-mini");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // openai is in the stored scope but the model pattern is gpt-4*, so this is
    // still refused: an elevation widens what it names and nothing more.
    expect(result.trace.verdict).toBe("deny");
    expect(result.trace.denied_by).toBe("scope");
    // And it is still declared, because the reader needs to know the snapshot
    // was taken under an elevation even when the elevation did not help.
    expect(result.trace.break_glass).toBeDefined();
  });

  /**
   * Break-glass widens SCOPE. Every gate above it still bites, and the trace
   * has to keep showing that — an operator who reads "elevated" as "unblocked"
   * will go looking in the wrong place.
   */
  it("is still stopped by the kill switch", async () => {
    h.readKillState.mockResolvedValue({ platformKill: true, userKill: false, denylist: [] });
    const result = await trace("anthropic", "claude-opus-4-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.trace.verdict).toBe("deny");
  });

  it("is still stopped by a per-agent suspend", async () => {
    h.isSuspended.mockResolvedValue(true);
    const result = await trace("anthropic", "claude-opus-4-1");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.trace.verdict).toBe("deny");
  });

  it("is still stopped by a policy deny rule", async () => {
    h.readCurrentAgentPolicy.mockResolvedValue({
      deny: [{ provider: "anthropic", models: ["*"] }],
    });
    const result = await trace("anthropic", "claude-opus-4-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.verdict).toBe("deny");
    expect(result.trace.denied_by).toBe("policy");
  });

  // Closed means no elevation, here as everywhere else this is read.
  it("falls back to the stored scope when the grant cannot be read", async () => {
    h.readLiveGrant.mockResolvedValue(null);
    const result = await trace("anthropic", "claude-opus-4-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trace.verdict).toBe("deny");
    expect(result.trace).not.toHaveProperty("break_glass");
  });
});
