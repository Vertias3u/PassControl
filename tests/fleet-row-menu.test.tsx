// The Fleet row's Actions menu.
//
// It used to be an absolute panel inside a section that clips its overflow, so on
// a short fleet — every new workspace — it opened and showed only its top edge.
// Found in the 2026-09-14 Windows self-host E2E. The panel is now fixed and placed
// by `placeRowMenu`; these pin where it goes. Whether it is VISIBLE is a browser
// question and was checked in one — this file cannot see a clip box.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/dashboard/actions", () => ({
  setAgentSuspended: vi.fn(),
  updateAgentBudgets: vi.fn(),
  updateAgentScopes: vi.fn(),
}));

import { AgentFleetTable, placeRowMenu } from "@/components/AgentFleetTable";

const viewport = { width: 1440, height: 900 };
const panel = { width: 164, height: 148 };

describe("placeRowMenu", () => {
  it("opens below the button, right-aligned, when there is room", () => {
    expect(placeRowMenu({ top: 300, bottom: 334, right: 1372 }, panel, viewport)).toEqual({
      top: 340,
      left: 1208,
      placement: "below",
    });
  });

  it("opens above when the viewport has no room below", () => {
    expect(placeRowMenu({ top: 820, bottom: 854, right: 1372 }, panel, viewport)).toEqual({
      top: 666,
      left: 1208,
      placement: "above",
    });
  });

  it("stays below when neither side fits but below has more room", () => {
    const short = { width: 1440, height: 200 };
    expect(placeRowMenu({ top: 40, bottom: 74, right: 1372 }, panel, short).placement).toBe("below");
  });

  it("never runs off the left or right edge", () => {
    expect(placeRowMenu({ top: 300, bottom: 334, right: 60 }, panel, viewport).left).toBe(6);
    expect(placeRowMenu({ top: 300, bottom: 334, right: 2000 }, panel, viewport).left).toBe(1440 - 164 - 6);
  });

  it("never places the panel above the top of the viewport", () => {
    const short = { width: 1440, height: 180 };
    expect(placeRowMenu({ top: 120, bottom: 154, right: 1372 }, panel, short)).toMatchObject({
      placement: "above",
      top: 6,
    });
  });
});

describe("Fleet row menu markup", () => {
  it("keeps the labelled summary and all four actions", () => {
    const html = renderToStaticMarkup(
      <AgentFleetTable
        agents={[{
          id: "a1",
          name: "agent-a1",
          passport_pubkey: "pk_a1",
          status: "active",
          budget_tokens: null,
          budget_cents: null,
          spent_tokens: 0,
          spent_microcents: 0,
          last_seen_at: null,
          allowed_scopes: [],
        }] as never}
        visaTtlSeconds={300}
        logsAvailable
      />,
    );
    expect(html).toContain('<details class="pc-row-menu"><summary aria-label="Actions for agent-a1">Actions</summary>');
    for (const action of ["Edit budgets", "Edit scopes", "Suspend agent"]) expect(html).toContain(action);
  });
});
