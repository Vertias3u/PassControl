import { describe, expect, it } from "vitest";
import {
  BUDGET_ATTENTION_RATIO,
  budgetRiskRatio,
  buildFleetAttention,
  type AttentionAgent,
  type AttentionLog,
} from "@/lib/dashboard-attention";
import { describeStoredShadow } from "@/components/dashboard/CallDetailDrawer";
import { agentCommandsForQuery } from "@/components/dashboard/DashboardCommandPalette";

const NOW = new Date("2026-08-08T12:00:00.000Z");

function agent(overrides: Partial<AttentionAgent> = {}): AttentionAgent {
  return {
    id: "agent-1",
    name: "Reconciler",
    status: "active",
    budget_tokens: 1_000,
    budget_cents: 100,
    spent_tokens: 800,
    spent_microcents: 10_000_000,
    expires_at: null,
    ...overrides,
  };
}

function log(overrides: Partial<AttentionLog> = {}): AttentionLog {
  return {
    agent_id: "agent-1",
    created_at: "2026-08-08T11:00:00.000Z",
    status: "ok",
    input_tokens: 50,
    output_tokens: 50,
    cost_microcents: 1_000_000,
    ...overrides,
  };
}

describe("operator-priority dashboard read models", () => {
  it("uses the shared 80% reconciled-agent threshold", () => {
    expect(BUDGET_ATTENTION_RATIO).toBe(0.8);
    expect(budgetRiskRatio(agent())).toBe(0.8);
    expect(buildFleetAttention([agent()], [], NOW)[0]?.reasons.some((reason) => reason.kind === "budget")).toBe(true);
  });

  it("derives refusal, last-seen and projected exhaustion from the same log rows", () => {
    const rows = [
      log({ status: "blocked_policy", created_at: "2026-08-08T11:00:00.000Z" }),
      log({ created_at: "2026-08-07T12:00:00.000Z", input_tokens: 100, output_tokens: 100 }),
    ];
    const item = buildFleetAttention([agent({ spent_tokens: 700 })], rows, NOW)[0];
    expect(item?.recentRefusals).toBe(1);
    expect(item?.lastSeenAt).toBe("2026-08-08T11:00:00.000Z");
    expect(item?.projectedExhaustionAt).not.toBeNull();
  });

  it("does not pad an entirely healthy queue", () => {
    const healthy = agent({ budget_tokens: null, budget_cents: null, spent_tokens: 0, spent_microcents: 0 });
    expect(buildFleetAttention([healthy], [log()], NOW)).toEqual([]);
  });

  it("never presents missing or stale shadow stamps as allow", () => {
    expect(describeStoredShadow(null, "rev-2").state).toBe("not-evaluated");
    expect(describeStoredShadow("allow", "rev-2").state).toBe("not-evaluated");
    expect(describeStoredShadow("allow@rev-1", "rev-2")).toMatchObject({
      state: "stale",
      detail: "Evaluated against a draft that is no longer current.",
    });
    expect(describeStoredShadow("allow@rev-2", "rev-2").state).toBe("allow");
  });

  it("finds an agent by passport suffix and emits identity, policy, and activity targets", () => {
    const commands = agentCommandsForQuery(
      [{ id: "agent-9", name: "Collector", passport_pubkey: "PCPUBKEY-0123456789abcdef" }],
      "89abcdef"
    );
    expect(commands.map((command) => command.href)).toEqual([
      "/dashboard/agents/agent-9#agent-identity",
      "/dashboard/agents/agent-9#agent-policy",
      "/dashboard/agents/agent-9#agent-activity",
    ]);
  });
});
