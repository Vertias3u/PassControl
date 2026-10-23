// L7 (1.6.0, 0088): the budget editor's choice at the pause line. Whether it is
// usable is a browser question (checked there); this pins what it offers.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/dashboard/actions-client", () => ({ updateAgentBudgets: vi.fn() }));

import { BudgetEditor } from "@/components/AgentFleetTable";

const agent = (over: Record<string, unknown>) =>
  ({
    id: "a1",
    name: "bot",
    status: "active",
    budget_tokens: null,
    budget_cents: 2000,
    allowed_scopes: [{ provider: "anthropic", models: ["claude-*"] }],
    pause_percent: 80,
    ...over,
  }) as never;

describe("BudgetEditor: at the pause line", () => {
  it("shows a saved switch, with its model", () => {
    const html = renderToStaticMarkup(
      <BudgetEditor agent={agent({ pause_action: "switch", pause_switch_provider: "anthropic", pause_switch_model: "claude-haiku-4-5" })} onClose={() => {}} />
    );
    expect(html).toContain('data-pause-action="switch"');
    expect(html).toContain('value="anthropic/claude-haiku-4-5"');
    expect(html).toContain("Suggested: anthropic/claude-haiku-4-5, which this agent may already call.");
  });

  it("pauses by default, and hides the model field", () => {
    const html = renderToStaticMarkup(<BudgetEditor agent={agent({})} onClose={() => {}} />);
    expect(html).toContain('data-pause-action="pause"');
    expect(html).not.toContain("data-pause-switch");
  });

  it("is off with no pause line", () => {
    const html = renderToStaticMarkup(<BudgetEditor agent={agent({ pause_percent: null })} onClose={() => {}} />);
    expect(html).toMatch(/<select[^>]*disabled=""[^>]*data-pause-action="pause"/);
  });
});
