import { describe, expect, it } from "vitest";
import { formatWorkspaceAlert, type WorkspaceAlert } from "@/lib/alerts/destination";

const recap = (recapText: string): WorkspaceAlert => ({
  type: "recap", recapText, agentName: "", at: new Date(), dashboardUrl: "",
});
describe("recap alert format", () => {
  it("uses plain Slack text and disables link unfurling", () => {
    expect(formatWorkspaceAlert("slack", recap("C6 text\n$1.00"))).toEqual({
      text: "C6 text\n$1.00", mrkdwn: false, unfurl_links: false, unfurl_media: false,
    });
  });
  it("prevents mentions on Telegram and Discord", () => {
    expect(formatWorkspaceAlert("telegram", recap("hello @everyone"), "123")).toEqual({
      chat_id: "123", text: "hello everyone", disable_web_page_preview: true,
    });
    expect(formatWorkspaceAlert("discord", recap("hello @everyone"))).toEqual({
      content: "hello @everyone", allowed_mentions: { parse: [] },
    });
  });
  it("redacts provider keys even if copied into an agent name or model", () => {
    const secret = "sk-" + "doNotSendThisKey";
    const body = formatWorkspaceAlert("slack", recap(`Agent ${secret}: $1.00`));
    expect(body.text).toContain("[redacted]");
    expect(JSON.stringify(body)).not.toContain(secret);
  });
});
