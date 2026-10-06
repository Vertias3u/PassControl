import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/dashboard/settings/alert-actions", () => ({
  saveAlertSettings: vi.fn(),
  removeAlertDestination: vi.fn(),
  sendTestAlert: vi.fn(),
}));

import { WorkspaceAlerts } from "@/components/WorkspaceAlerts";

describe("WorkspaceAlerts", () => {
  it("shows where alerts go by hint only, the kinds, and the three actions", () => {
    const html = renderToStaticMarkup(
      <WorkspaceAlerts state="ready" destination={{ kind: "slack", hint: "hooks.slack.com/…/5678", events: ["refused", "security"] }} />
    );
    expect(html).toContain('data-panel="workspace-alerts"');
    expect(html).toContain("Slack");
    expect(html).toContain("hooks.slack.com/…/5678");
    expect(html).toMatch(/name="refused"[^>]*checked/u);
    expect(html).toMatch(/name="security"[^>]*checked/u);
    expect(html).not.toMatch(/name="budget"[^>]*checked/u);
    expect(html).toContain("Send test alert");
    expect(html).toContain("Remove");
    expect(html).toMatch(/leave blank to keep/i);
  });

  it("asks for a URL when nothing is set, with every kind on by default", () => {
    const html = renderToStaticMarkup(<WorkspaceAlerts state="ready" destination={null} />);
    expect(html).toContain("hooks.slack.com/services/");
    expect(html).toMatch(/name="budget"[^>]*checked/u);
    expect(html).not.toContain("Send test alert");
    expect(html).not.toContain("Remove");
  });

  it("offers Telegram next to Slack and Discord", () => {
    const html = renderToStaticMarkup(<WorkspaceAlerts state="ready" destination={null} />);
    expect(html).toContain('data-service-choice="webhook"');
    expect(html).toContain('data-service-choice="telegram"');
    expect(html).toContain("Telegram");
  });

  it("shows a saved Telegram destination with its token and chat fields, the token masked", () => {
    const html = renderToStaticMarkup(
      <WorkspaceAlerts state="ready" destination={{ kind: "telegram", hint: "bot …saw0 → chat -100123", events: ["refused"] }} />
    );
    expect(html).toContain("bot …saw0 → chat -100123");
    expect(html).toMatch(/name="telegramToken"[^>]*type="password"|type="password"[^>]*name="telegramToken"/u);
    expect(html).toContain('name="telegramChatId"');
    expect(html).toContain("@BotFather");
    expect(html).not.toContain('name="url"');
  });

  it("names the missing migration instead of offering a form that cannot save", () => {
    const html = renderToStaticMarkup(<WorkspaceAlerts state="unmigrated" destination={null} />);
    expect(html).toMatch(/0078/);
    expect(html).not.toContain("<form");
  });

  it("explains what each kind sends, and that suspended agents never alert", () => {
    const html = renderToStaticMarkup(<WorkspaceAlerts state="ready" destination={null} />);
    expect(html).toMatch(/not allowed/i);
    expect(html).toMatch(/budget/i);
    expect(html).toMatch(/passport/i);
    expect(html).toMatch(/break-glass/i);
    expect(html).toMatch(/10 minutes/);
  });
});
