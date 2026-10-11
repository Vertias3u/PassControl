// Candidate 3 (owner, 2026-10-10): "this session passed $X". An agent's policy can set
// `session_alert_cents`; when a declared session's settled spend crosses it, the
// workspace's Slack, Discord or Telegram destination gets ONE alert. It never pauses
// or refuses anything (stopping a session is T8's job, and the alert points there).
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const { addSessionSpendMock } = vi.hoisted(() => ({ addSessionSpendMock: vi.fn() }));
vi.mock("@/lib/state/redis", async (orig) => ({ ...(await orig<typeof import("@/lib/state/redis")>()), addSessionSpend: addSessionSpendMock }));
vi.mock("@/app/dashboard/agents/[id]/shadow-actions", () => ({
  saveAgentPolicyShadow: async () => ({ ok: true }),
  promoteAgentPolicyShadow: async () => ({ ok: true }),
}));

import { noteSessionSpend, sessionSpendCrossed } from "@/lib/alerts/session-spend";
import { formatWorkspaceAlert } from "@/lib/alerts/destination";
import { policyIsWellFormed, sessionAlertCents } from "@/lib/scope";
import { SessionAlertField, toDraft, toPolicy } from "@/components/PolicyShadowPanel";

describe("sessionSpendCrossed", () => {
  it.each([
    [0, 600, 500, true],
    [400, 600, 500, true],
    [500, 600, 500, false],
    [499, 500, 500, true],
    [100, 200, 500, false],
  ])("from %s to %s with a threshold of %s: %s", (before, after, threshold, crossed) => {
    expect(sessionSpendCrossed(before, after, threshold)).toBe(crossed);
  });
});

describe("noteSessionSpend", () => {
  const base = { userId: "u1", agentId: "a1", session: "sess-1", thresholdMicrocents: 500_000_000, origin: "https://gw.example" };

  it("alerts once, on the charge that crosses the threshold", async () => {
    const notify = vi.fn(async () => {});
    addSessionSpendMock.mockResolvedValueOnce({ total: 520_000_000 });
    expect(await noteSessionSpend({ ...base, deltaMicrocents: 40_000_000, notify })).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: "session_spend", session: "sess-1", spentMicrocents: 520_000_000, thresholdMicrocents: 500_000_000 })
    );
    addSessionSpendMock.mockResolvedValueOnce({ total: 560_000_000 });
    expect(await noteSessionSpend({ ...base, deltaMicrocents: 40_000_000, notify })).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does nothing below the threshold, or when the counter could not be read", async () => {
    const notify = vi.fn(async () => {});
    addSessionSpendMock.mockResolvedValueOnce({ total: 100 });
    expect(await noteSessionSpend({ ...base, deltaMicrocents: 100, notify })).toBe(false);
    addSessionSpendMock.mockResolvedValueOnce(null);
    expect(await noteSessionSpend({ ...base, deltaMicrocents: 100, notify })).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it("never throws: an alert is best-effort", async () => {
    addSessionSpendMock.mockRejectedValueOnce(new Error("down"));
    await expect(noteSessionSpend({ ...base, deltaMicrocents: 1, notify: vi.fn() })).resolves.toBe(false);
  });
});

describe("the alert's words", () => {
  const alert = {
    type: "session_spend" as const,
    agentName: "claude-code-test",
    session: "04542892-548f",
    spentMicrocents: 523_000_000,
    thresholdMicrocents: 500_000_000,
    at: new Date("2026-10-10T12:00:00Z"),
    dashboardUrl: "https://gw.example/dashboard/agents/a1#agent-sessions",
  };

  it.each(["slack", "discord", "telegram"] as const)("%s says what passed, by how much, and that nothing is paused", (kind) => {
    const out = formatWorkspaceAlert(kind as never, alert, "chat") as unknown as Record<string, string>;
    const text = out.text ?? out.content;
    expect(text).toContain("$5.00");
    expect(text).toContain("$5.23");
    expect(text).toContain("04542892-548f");
    expect(text).toMatch(/nothing is paused/i);
    expect(text).toContain("#agent-sessions");
    expect(text).not.toMatch(/paused for 10 minutes/);
  });
});

describe("the policy key and the editor field", () => {
  it.each([1, 500, 10_000_000])("accepts %s cents", (cents) => {
    expect(policyIsWellFormed({ session_alert_cents: cents })).toBe(true);
    expect(sessionAlertCents({ session_alert_cents: cents })).toBe(cents);
  });
  it.each([0, -5, 2.5, "500", 10_000_001])("refuses %s", (cents) => {
    expect(policyIsWellFormed({ session_alert_cents: cents })).toBe(false);
  });
  it("round-trips through the editor in dollars", () => {
    const draft = toDraft({ session_alert_cents: 500 });
    expect(draft.sessionAlert).toBe("5.00");
    expect(toPolicy(draft)).toEqual({ session_alert_cents: 500 });
    expect(toPolicy({ ...toDraft(null), sessionAlert: "" })).toBeNull();
    expect(toPolicy({ ...toDraft(null), sessionAlert: "0" })).toBeNull();
  });
  it("says it alerts and does not pause", () => {
    const html = renderToStaticMarkup(createElement(SessionAlertField, { draft: toDraft(null), setDraft: () => {}, pending: false }));
    expect(html).toContain('data-policy-field="session_alert_cents"');
    expect(html).toMatch(/does not pause/i);
  });
});
