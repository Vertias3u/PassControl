// What the Approvals page says after the owner answers. A service call is held by the
// gateway and sent on the agent's next try; a Claude Code tool (subscription mode,
// Phase 2) is held by the sidecar, which runs it when it sees the yes, if Claude Code
// is still waiting. Each gets the sentence that is true for it.
import { renderToStaticMarkup } from "react-dom/server";
import { HELD_TAINTED, HELD_UNKNOWN } from "@/lib/injection-hold";
import type { PendingApprovalView } from "@/components/ApprovalsPanel";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/dashboard/approvals/actions", () => ({ decideApprovalAction: vi.fn() }));
vi.mock("@/app/dashboard/agents/[id]/injection-actions", () => ({ clearInjectionTaint: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { approvalOutcome, ApprovalsPanel } = await import("@/components/ApprovalsPanel");

describe("approvalOutcome", () => {
  it("a service call: sent on the agent's next try", () => {
    expect(approvalOutcome({ state: "approved" }, false)).toEqual({ ok: true, text: "Approved. The agent's next try sends it, once." });
    expect(approvalOutcome({ state: "denied" }, false)).toEqual({ ok: true, text: "Denied. The agent's retries are refused." });
  });

  // Codex's tools come through the same sidecar (owner, 2026-10-30: the page said
  // "Claude Code" for a Codex tool), so the copy names neither.
  it("a local tool: runs if the agent is still waiting, never speaks of retries or one client", () => {
    const yes = approvalOutcome({ state: "approved" }, true);
    expect(yes).toEqual({ ok: true, text: "Approved. If the agent is still waiting, the tool runs now, once." });
    const no = approvalOutcome({ state: "denied" }, true);
    expect(no).toEqual({ ok: true, text: "Denied. The tool is refused." });
    expect(`${yes.text} ${no.text}`).not.toMatch(/next try|retries|Claude Code|Codex/);
  });

  it("an error or a question already answered reads the same for both", () => {
    for (const tool of [false, true]) {
      expect(approvalOutcome({ error: "Sign in again." }, tool)).toEqual({ ok: false, text: "Sign in again." });
      expect(approvalOutcome({ state: "missing" }, tool)).toEqual({ ok: false, text: "Already answered somewhere else, or expired." });
    }
  });
});


describe("held approval items", () => {
  const item = { id: "approval-1", agentId: "agent-1", agentName: "Scout", serviceLabel: "GitHub", method: "POST", path: "/issues", preview: "", createdAt: Date.now(), onTelegram: false };
  const render = (hold: PendingApprovalView["hold"]) => renderToStaticMarkup(<ApprovalsPanel items={[{ ...item, hold }]} />);

  it("shows the tainted reason and Clear, while keeping Approve and Deny", () => {
    const html = render("tainted");
    expect(html).toContain('data-hold="tainted"');
    expect(html).toContain(HELD_TAINTED);
    expect(html).toContain("Clear the hold");
    expect(html).toContain('data-action="approve"');
    expect(html).toContain('data-action="deny"');
    expect(html).toContain("Clearing ends the hold for the agent’s next actions; this request still waits for Approve or Deny.");
  });

  it("shows the unknown reason without Clear", () => {
    const html = render("unknown");
    expect(html).toContain('data-hold="unknown"');
    expect(html).toContain(HELD_UNKNOWN);
    expect(html).not.toContain("Clear the hold");
  });

  it("shows a cleared hold while still waiting for Approve or Deny", () => {
    const html = render("cleared");
    expect(html).toContain('data-hold="cleared"');
    expect(html).toContain("Held by the injection guard when it was asked. The hold has since been cleared; this request still waits for Approve or Deny.");
    expect(html).not.toContain(HELD_TAINTED);
    expect(html).not.toContain('data-action="clear-hold"');
    expect(html).toContain('data-action="approve"');
    expect(html).toContain('data-action="deny"');
  });

  it("shows an ordinary question without a hold or Clear", () => {
    const html = render(null);
    expect(html).not.toContain("data-hold");
    expect(html).not.toContain(HELD_TAINTED);
    expect(html).not.toContain(HELD_UNKNOWN);
    expect(html).not.toContain("Clear the hold");
  });
});
