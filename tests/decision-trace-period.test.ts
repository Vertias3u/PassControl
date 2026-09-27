// K1 — the decision trace projects the periodic limit the way the gateway will
// enforce it on the next call: its own snapshot when it has one, the ledger's
// figure when it would seed from it, and no claim at all when neither can be
// read. A trace that says "allowed" for a call the period would refuse is worse
// than no trace.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  usage: vi.fn(),
  rpc: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock("@/lib/state/killswitch", () => ({
  readKillState: async () => ({ platformKill: false, userKill: false, denylist: [] }),
}));
vi.mock("@/lib/state/redis", () => ({
  isSuspended: async () => false,
  readBudgetSnapshot: (...a: unknown[]) => h.snapshot(...a),
}));
vi.mock("@/lib/state/holds", () => ({
  readPeriodUsageMany: (...a: unknown[]) => h.usage(...a),
}));
vi.mock("@/lib/state/policy", () => ({ readCurrentAgentPolicy: async () => null }));
vi.mock("@/lib/ratelimit", () => ({ peekRateLimit: async () => ({ success: true, remaining: 1 }) }));
vi.mock("@/lib/break-glass", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/break-glass")>()),
  readLiveGrant: async () => null,
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({ rpc: (...a: unknown[]) => h.rpc(...a) }) }));

import { evaluateDecisionTrace } from "@/app/api/control/v1/agents/[id]/trace/decision-trace";

const AGENT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const AT = new Date("2026-09-26T12:00:00.000Z");

function db(row: Record<string, unknown>) {
  const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: row, error: null }) };
  return { from: () => b } as never;
}
const agent = (extra: Record<string, unknown> = {}) => ({
  id: AGENT,
  status: "active",
  allowed_scopes: [{ provider: "openai", models: ["gpt-4o-mini"] }],
  budget_tokens: null,
  budget_cents: null,
  spent_tokens: 0,
  spent_microcents: 0,
  budget_period: "day",
  budget_period_cents: 10, // 10 cents = 10,000,000 µ¢
  ...extra,
});
const trace = (row: Record<string, unknown>) =>
  evaluateDecisionTrace({
    db: db(row),
    userId: USER,
    agentId: AGENT,
    provider: "openai",
    model: "gpt-4o-mini",
    maxOutputTokens: 100,
    evaluatedAt: AT,
    policyAt: AT,
  });
const budgetStep = (r: Awaited<ReturnType<typeof trace>>) =>
  r.ok ? r.trace.steps.find((s) => s.name === "budget") : undefined;

beforeEach(() => {
  h.usage.mockReset();
  h.rpc.mockReset();
  h.snapshot.mockResolvedValue({});
});

describe("decision trace and the periodic limit", () => {
  it("refuses when the gateway's own snapshot has the period used up", async () => {
    h.usage.mockResolvedValue(
      new Map([[AGENT, { state: "tracked", kind: "day", usedMicrocents: 9_999_990, heldMicrocents: 0, openHolds: 0 }]])
    );
    const r = await trace(agent());
    expect(budgetStep(r)).toMatchObject({ status: "fail", rule: "budget:period" });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("counts reservations still in flight, as the gateway does", async () => {
    h.usage.mockResolvedValue(
      new Map([[AGENT, { state: "tracked", kind: "day", usedMicrocents: 0, heldMicrocents: 10_000_000, openHolds: 1 }]])
    );
    expect(budgetStep(await trace(agent()))).toMatchObject({ status: "fail", rule: "budget:period" });
  });

  it("projects from the ledger over the current UTC period when the gateway would seed from it", async () => {
    h.usage.mockResolvedValue(
      new Map([[AGENT, { state: "not_started", kind: "day", usedMicrocents: 0, heldMicrocents: 0, openHolds: 0 }]])
    );
    h.rpc.mockResolvedValue({ data: [{ spent_tokens: 1, spent_microcents: 9_999_990 }], error: null });
    const r = await trace(agent());
    expect(h.rpc).toHaveBeenCalledWith("agent_period_spend", {
      p_agent_id: AGENT,
      p_since: "2026-09-26T00:00:00.000Z",
    });
    expect(budgetStep(r)).toMatchObject({ status: "fail", rule: "budget:period" });
  });

  it("admits a call that fits", async () => {
    h.usage.mockResolvedValue(
      new Map([[AGENT, { state: "tracked", kind: "day", usedMicrocents: 0, heldMicrocents: 0, openHolds: 0 }]])
    );
    const r = await trace(agent({ budget_period_cents: 100_000 }));
    expect(r.ok && r.trace.verdict).toBe("allow");
  });

  it("makes no period claim when the count cannot be read", async () => {
    h.usage.mockRejectedValue(new Error("redis down"));
    const r = await trace(agent());
    expect(budgetStep(r)?.rule).not.toBe("budget:period");
  });

  it("leaves an agent without a periodic limit exactly as before", async () => {
    const r = await trace(agent({ budget_period: null, budget_period_cents: null }));
    expect(h.usage).not.toHaveBeenCalled();
    expect(r.ok && r.trace.verdict).toBe("allow");
  });
});
