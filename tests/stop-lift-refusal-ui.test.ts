// Review C-02: resuming an agent needs the second factor where one is enrolled. When
// the server refuses for that reason nothing changed, so the control must say "verify
// first", never "the request may or may not have applied".
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ setAgentSuspended: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock("@/app/dashboard/actions-client", () => ({
  setAgentSuspended: (...a: unknown[]) => h.setAgentSuspended(...a),
  observeAgentControl: async () => { throw new Error("unused"); },
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentControlResult, applyIntent } from "@/components/AgentSuspendControl";
import { stepUpRefusal } from "@/lib/action-result";

describe("a refused lift is shown as refused", () => {
  it("names the step-up refusal and nothing else", () => {
    expect(stepUpRefusal(new Error("Complete two-factor verification before resuming this agent."))).toMatch(/^Complete two-factor/);
    expect(stepUpRefusal(new Error("Something went wrong. Please try again."))).toBeNull();
    expect(stepUpRefusal("Complete two-factor verification")).toBeNull();
  });

  it("resume refused for the second factor is 'refused', a lost request is still 'lost'", async () => {
    h.setAgentSuspended.mockRejectedValueOnce(new Error("Complete two-factor verification before resuming this agent."));
    expect(await applyIntent("a", "active")).toEqual({
      phase: "refused",
      intent: "active",
      message: "Complete two-factor verification before resuming this agent.",
    });
    h.setAgentSuspended.mockRejectedValueOnce(new Error("Something went wrong. Please try again."));
    expect(await applyIntent("a", "active")).toMatchObject({ phase: "lost", intent: "active" });
  });
});

describe("what the operator sees for a refused resume", () => {
  it("says nothing changed, links to verification, and offers no retry that would fail the same way", () => {
    const html = renderToStaticMarkup(
      createElement(AgentControlResult, {
        result: { phase: "refused", intent: "active", message: "Complete two-factor verification before resuming this agent." },
        agentName: "researcher",
        onRetry: () => undefined,
        onRefresh: () => undefined,
      })
    );
    expect(html).toContain('data-control-result="refused"');
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/Complete two-factor verification before resuming this agent\. Nothing was changed\./);
    expect(html).toContain('href="/login/verify"');
    expect(html).not.toContain('data-control="retry"');
    // Never the "may or may not have applied" wording a lost request gets.
    expect(html).not.toMatch(/could not confirm|may have/i);
  });
});
