import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentFleetTable } from "@/components/AgentFleetTable";
import { OperationsPanel } from "@/components/dashboard/OperationsPanel";

vi.mock("@/app/dashboard/actions-client", () => ({
  setAgentSuspended: vi.fn(), observeAgentControl: vi.fn(),
  updateAgentBudgets: vi.fn(), updateAgentScopes: vi.fn(),
}));

function fleet(value: number, limit: number | null, period?: { used: number; held: number }) {
  return renderToStaticMarkup(<AgentFleetTable agentsAvailable logsAvailable visaTtlSeconds={300}
    agents={[{
      id: "sample", name: "Sample agent", passport_pubkey: null, status: "active",
      budget_tokens: limit, budget_cents: limit, spent_tokens: value,
      spent_microcents: value * 1_000_000, last_seen_at: null, allowed_scopes: [],
      ...(period ? { budget_period: "day" as const, budget_period_cents: 100 } : {}),
    }]}
    periodUsage={period ? { sample: { state: "tracked", usedMicrocents: period.used * 1_000_000, heldMicrocents: period.held * 1_000_000, openHolds: period.held ? 1 : 0 } } : {}}
  />);
}

function meters(html: string) {
  return [...html.matchAll(/<div class="pc-budget-meter"([^>]*)>[\s\S]*?<div class="pc-budget-meter__track"[^>]*>([\s\S]*?)<\/div>/g)]
    .map((match) => ({ tone: match[1]!.match(/data-tone="([^"]+)"/)?.[1], fill: match[2] }));
}

describe("fleet budget bars, table and mobile cards", () => {
  it.each([[74, "neutral"], [75, "warning"], [100, "calm"], [125, "calm"]] as const)("shows %i%% as %s for token, cost and periodic limits", (used, tone) => {
    const bars = meters(fleet(used, 100, { used, held: 0 }));
    expect(bars).toHaveLength(6);
    for (const bar of bars) {
      expect(bar.tone).toBe(tone);
      expect(bar.fill).toContain(`width:${Math.min(used, 100)}%`);
    }
  });

  it("gives an uncapped value no tone and no coloured fill", () => {
    const bars = meters(fleet(1000, null));
    expect(bars).toHaveLength(4);
    for (const bar of bars) {
      expect(bar.tone).toBeUndefined();
      expect(bar.fill).toBe("");
    }
  });

  it("counts unfinished period reservations towards the colour threshold", () => {
    const bars = meters(fleet(0, null, { used: 70, held: 5 }));
    expect(bars.filter((bar) => bar.tone === "warning")).toHaveLength(2);
  });

  it("keeps an explicit zero cap distinct from no cap", () => {
    for (const bar of meters(fleet(0, 0))) {
      expect(bar.tone).toBe("calm");
      expect(bar.fill).toContain("width:100%");
    }
  });
});

