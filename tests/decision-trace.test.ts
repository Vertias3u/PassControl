import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  readKillStateMock,
  isSuspendedMock,
  readBudgetSnapshotMock,
  readCurrentAgentPolicyMock,
  peekRateLimitMock,
  reserveBudgetMock,
  reconcileBudgetMock,
  seedSpentMock,
  claimNonceMock,
  getCachedKeyMock,
  setCachedKeyMock,
  setCachedAgentPolicyMock,
  writeLogMock,
} = vi.hoisted(() => ({
  readKillStateMock: vi.fn(),
  isSuspendedMock: vi.fn(),
  readBudgetSnapshotMock: vi.fn(),
  readCurrentAgentPolicyMock: vi.fn(),
  peekRateLimitMock: vi.fn(),
  reserveBudgetMock: vi.fn(),
  reconcileBudgetMock: vi.fn(),
  seedSpentMock: vi.fn(),
  claimNonceMock: vi.fn(),
  getCachedKeyMock: vi.fn(),
  setCachedKeyMock: vi.fn(),
  setCachedAgentPolicyMock: vi.fn(),
  writeLogMock: vi.fn(),
}));

vi.mock("@/lib/state/killswitch", () => ({
  readKillState: (...args: unknown[]) => readKillStateMock(...args),
}));
vi.mock("@/lib/state/redis", () => ({
  isSuspended: (...args: unknown[]) => isSuspendedMock(...args),
  readBudgetSnapshot: (...args: unknown[]) => readBudgetSnapshotMock(...args),
  reserveBudget: (...args: unknown[]) => reserveBudgetMock(...args),
  reconcileBudget: (...args: unknown[]) => reconcileBudgetMock(...args),
  seedSpent: (...args: unknown[]) => seedSpentMock(...args),
  claimNonce: (...args: unknown[]) => claimNonceMock(...args),
  getCachedKey: (...args: unknown[]) => getCachedKeyMock(...args),
  setCachedKey: (...args: unknown[]) => setCachedKeyMock(...args),
  setCachedAgentPolicy: (...args: unknown[]) => setCachedAgentPolicyMock(...args),
}));
vi.mock("@/lib/state/policy", () => ({
  readCurrentAgentPolicy: (...args: unknown[]) => readCurrentAgentPolicyMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({
  peekRateLimit: (...args: unknown[]) => peekRateLimitMock(...args),
}));
vi.mock("@/lib/log", () => ({
  writeLog: (...args: unknown[]) => writeLogMock(...args),
}));

import { evaluateDecisionTrace } from "@/app/api/control/v1/agents/[id]/trace/decision-trace";
import { POLICY_UNREADABLE } from "@/lib/gate";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const USER_ID = "22222222-2222-2222-2222-222222222222";
const EVALUATED_AT = new Date("2026-07-31T12:00:00.000Z");
const POLICY_AT = new Date("2026-07-28T10:30:00.000Z");

let dataset: { data: unknown; error: unknown };
let eqCalls: Array<[string, unknown]>;
let selectCalls: string[];
let rpcMock: ReturnType<typeof vi.fn>;

function database() {
  const builder: any = {
    select: vi.fn((columns: string) => {
      selectCalls.push(columns);
      return builder;
    }),
    eq: vi.fn((column: string, value: unknown) => {
      eqCalls.push([column, value]);
      return builder;
    }),
    maybeSingle: vi.fn(async () => dataset),
  };
  rpcMock = vi.fn();
  return { from: vi.fn(() => builder), rpc: rpcMock } as any;
}

const ownedAgent = {
  id: AGENT_ID,
  status: "active",
  allowed_scopes: [{ provider: "openai", models: ["gpt-4*"] }],
  budget_tokens: 10_000,
  budget_cents: 100,
  spent_tokens: 250,
  spent_microcents: 1_000,
  provider_key: "must-never-appear",
};

beforeEach(() => {
  dataset = { data: ownedAgent, error: null };
  eqCalls = [];
  selectCalls = [];
  readKillStateMock.mockReset();
  isSuspendedMock.mockReset();
  readBudgetSnapshotMock.mockReset();
  readCurrentAgentPolicyMock.mockReset();
  peekRateLimitMock.mockReset();
  reserveBudgetMock.mockReset();
  reconcileBudgetMock.mockReset();
  seedSpentMock.mockReset();
  claimNonceMock.mockReset();
  getCachedKeyMock.mockReset();
  setCachedKeyMock.mockReset();
  setCachedAgentPolicyMock.mockReset();
  writeLogMock.mockReset();
  readKillStateMock.mockResolvedValue({ platformKill: false, userKill: false, denylist: [] });
  isSuspendedMock.mockResolvedValue(false);
  readBudgetSnapshotMock.mockResolvedValue({
    reservedTokens: 0,
    spentTokens: null,
    reservedMicrocents: 0,
    spentMicrocents: null,
  });
  readCurrentAgentPolicyMock.mockResolvedValue({});
  peekRateLimitMock.mockResolvedValue({ success: true, remaining: 10 });
});

describe("read-only decision trace", () => {
  it("returns a key-free, point-in-time snapshot from the same ordered evaluator", async () => {
    const result = await evaluateDecisionTrace({
      db: database(),
      userId: USER_ID,
      agentId: AGENT_ID,
      provider: "openai",
      model: "gpt-4.1",
      evaluatedAt: EVALUATED_AT,
      policyAt: POLICY_AT,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected trace");
    expect(result.trace).toMatchObject({
      snapshot: true,
      evaluated_at: EVALUATED_AT.toISOString(),
      policy_time: POLICY_AT.toISOString(),
      verdict: "allow",
    });
    expect(result.trace.steps.map((step) => step.name)).toEqual([
      "kill",
      "suspend",
      "scope",
      "endpoint",
      "policy",
      "budget",
    ]);
    expect(JSON.stringify(result.trace)).not.toContain("must-never-appear");
    expect(selectCalls.join(",")).not.toMatch(/key|credential|secret/i);
    expect(rpcMock).not.toHaveBeenCalled();
    expect(reserveBudgetMock).not.toHaveBeenCalled();
    expect(reconcileBudgetMock).not.toHaveBeenCalled();
    expect(seedSpentMock).not.toHaveBeenCalled();
    expect(claimNonceMock).not.toHaveBeenCalled();
    expect(getCachedKeyMock).not.toHaveBeenCalled();
    expect(setCachedKeyMock).not.toHaveBeenCalled();
    expect(setCachedAgentPolicyMock).not.toHaveBeenCalled();
    expect(writeLogMock).not.toHaveBeenCalled();
  });

  it("applies both tenant and agent filters before reading mutable state", async () => {
    await evaluateDecisionTrace({
      db: database(),
      userId: USER_ID,
      agentId: AGENT_ID,
      provider: "openai",
      model: "gpt-4.1",
      evaluatedAt: EVALUATED_AT,
      policyAt: POLICY_AT,
    });

    expect(eqCalls).toContainEqual(["user_id", USER_ID]);
    expect(eqCalls).toContainEqual(["id", AGENT_ID]);
    expect(readKillStateMock).toHaveBeenCalledWith(USER_ID);
    expect(isSuspendedMock).toHaveBeenCalledWith(AGENT_ID);
  });

  it("returns not-found for another tenant and performs no Redis reads", async () => {
    dataset = { data: null, error: null };

    const result = await evaluateDecisionTrace({
      db: database(),
      userId: USER_ID,
      agentId: AGENT_ID,
      provider: "openai",
      model: "gpt-4.1",
      evaluatedAt: EVALUATED_AT,
      policyAt: POLICY_AT,
    });

    expect(result).toEqual({ ok: false, status: 404, code: "not_found" });
    expect(eqCalls).toContainEqual(["user_id", USER_ID]);
    expect(readKillStateMock).not.toHaveBeenCalled();
    expect(isSuspendedMock).not.toHaveBeenCalled();
    expect(readBudgetSnapshotMock).not.toHaveBeenCalled();
    expect(readCurrentAgentPolicyMock).not.toHaveBeenCalled();
  });

  it("peeks at, but does not consume, an agent policy hourly counter", async () => {
    readCurrentAgentPolicyMock.mockResolvedValue({ max_requests_per_hour: 11 });

    const result = await evaluateDecisionTrace({
      db: database(),
      userId: USER_ID,
      agentId: AGENT_ID,
      provider: "openai",
      model: "gpt-4.1",
      evaluatedAt: EVALUATED_AT,
      policyAt: POLICY_AT,
    });

    expect(result.ok).toBe(true);
    expect(peekRateLimitMock).toHaveBeenCalledWith(
      `policy-hour:${USER_ID}:${AGENT_ID}`,
      11
    );
  });

  it("never hides an unreadable policy behind a generic passing policy step", async () => {
    readCurrentAgentPolicyMock.mockResolvedValue(POLICY_UNREADABLE);
    delete process.env.POLICY_FAIL_CLOSED;
    const open = await evaluateDecisionTrace({
      db: database(),
      userId: USER_ID,
      agentId: AGENT_ID,
      provider: "openai",
      model: "gpt-4.1",
      evaluatedAt: EVALUATED_AT,
      policyAt: POLICY_AT,
    });
    expect(open.ok && open.trace.policy).toEqual({
      outcome: "unreadable",
      posture: "fail_open",
    });
    expect(open.ok && open.trace.steps.find((step) => step.name === "policy")).toMatchObject({
      status: "pass",
      presentation: "warning",
    });

    process.env.POLICY_FAIL_CLOSED = "true";
    try {
      const closed = await evaluateDecisionTrace({
        db: database(),
        userId: USER_ID,
        agentId: AGENT_ID,
        provider: "openai",
        model: "gpt-4.1",
        evaluatedAt: EVALUATED_AT,
        policyAt: POLICY_AT,
      });
      expect(closed.ok && closed.trace.verdict).toBe("deny");
      expect(closed.ok && closed.trace.policy).toEqual({
        outcome: "unreadable",
        posture: "fail_closed",
      });
      expect(
        closed.ok && closed.trace.steps.find((step) => step.name === "policy")
      ).toMatchObject({ status: "fail", presentation: "warning" });
    } finally {
      delete process.env.POLICY_FAIL_CLOSED;
    }
  });
});
