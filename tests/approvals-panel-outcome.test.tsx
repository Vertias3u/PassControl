// What the Approvals page says after the owner answers. A service call is held by the
// gateway and sent on the agent's next try; a Claude Code tool (subscription mode,
// Phase 2) is held by the sidecar, which runs it when it sees the yes, if Claude Code
// is still waiting. Each gets the sentence that is true for it.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/dashboard/approvals/actions", () => ({ decideApprovalAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { approvalOutcome } = await import("@/components/ApprovalsPanel");

describe("approvalOutcome", () => {
  it("a service call: sent on the agent's next try", () => {
    expect(approvalOutcome({ state: "approved" }, false)).toEqual({ ok: true, text: "Approved. The agent's next try sends it, once." });
    expect(approvalOutcome({ state: "denied" }, false)).toEqual({ ok: true, text: "Denied. The agent's retries are refused." });
  });

  it("a Claude Code tool: runs if Claude Code is still waiting, never speaks of retries", () => {
    const yes = approvalOutcome({ state: "approved" }, true);
    expect(yes).toEqual({ ok: true, text: "Approved. If Claude Code is still waiting, the tool runs now, once." });
    const no = approvalOutcome({ state: "denied" }, true);
    expect(no).toEqual({ ok: true, text: "Denied. The tool is refused." });
    expect(`${yes.text} ${no.text}`).not.toMatch(/next try|retries/);
  });

  it("an error or a question already answered reads the same for both", () => {
    for (const tool of [false, true]) {
      expect(approvalOutcome({ error: "Sign in again." }, tool)).toEqual({ ok: false, text: "Sign in again." });
      expect(approvalOutcome({ state: "missing" }, tool)).toEqual({ ok: false, text: "Already answered somewhere else, or expired." });
    }
  });
});
