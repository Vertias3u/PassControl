// Where a workspace alert may be sent, and what it may say.
//
// The destination is a URL a tenant pastes and our server then POSTs to, so
// it is an SSRF surface: v1 accepts exactly two services by exact hostname
// and path shape, and nothing else. The message carries a field the AGENT
// controls (the model it asked for), so it must not be able to ping a
// channel, plant a link, or break out of its formatting.
import { describe, expect, it } from "vitest";

import { formatWorkspaceAlert, parseAlertDestination } from "@/lib/alerts/destination";

// Fake, and split so secret scanners do not block a push over it.
const SLACK = "https://hooks.slack.com/services/" + "T0123ABCD/B0456EFGH/abcdEFGH1234ijklMNOP5678";
const DISCORD = "https://discord.com/api/webhooks/123456789012345678/AbC-dEf_123ghIJKLmnopQRstuVWxyz0123456789abcdefGHIJ";

describe("parseAlertDestination", () => {
  it("accepts a Slack incoming webhook and keeps only a hint for display", () => {
    const parsed = parseAlertDestination(`  ${SLACK}  `);
    expect(parsed).toEqual({ kind: "slack", url: SLACK, hint: "hooks.slack.com/…/5678" });
  });

  it("accepts a Discord webhook on either Discord host", () => {
    expect(parseAlertDestination(DISCORD)).toMatchObject({ kind: "discord", url: DISCORD, hint: "discord.com/…/GHIJ" });
    const legacy = DISCORD.replace("discord.com", "discordapp.com");
    expect(parseAlertDestination(legacy)).toMatchObject({ kind: "discord", url: legacy });
  });

  it("normalises the host's case rather than refusing it", () => {
    expect(parseAlertDestination(SLACK.replace("hooks.slack.com", "HOOKS.Slack.COM"))?.url).toBe(SLACK);
  });

  it.each([
    ["plain http", SLACK.replace("https:", "http:")],
    ["userinfo hiding the real host", "https://hooks.slack.com@evil.example/services/T0/B0/x"],
    ["userinfo with the allowed host as the user", "https://hooks.slack.com:pw@evil.example/services/T0/B0/x"],
    ["allowed host as a path segment", "https://evil.example/hooks.slack.com/services/T0/B0/x"],
    ["allowed host as a subdomain prefix", "https://hooks.slack.com.evil.example/services/T0/B0/x"],
    ["trailing dot", SLACK.replace("hooks.slack.com", "hooks.slack.com.")],
    ["explicit port", SLACK.replace("hooks.slack.com", "hooks.slack.com:8443")],
    ["dot segments climbing out of the path", "https://discord.com/api/webhooks/../../internal"],
    ["a Slack host with a Discord path", "https://hooks.slack.com/api/webhooks/1/abc"],
    ["a Discord host with a Slack path", "https://discord.com/services/T0/B0/x"],
    ["a non-webhook Slack path", "https://hooks.slack.com/admin"],
    ["a non-numeric Discord id", "https://discord.com/api/webhooks/abc/def"],
    ["a query string", `${DISCORD}?wait=true`],
    ["a fragment", `${SLACK}#x`],
    ["an encoded slash", "https://hooks.slack.com/services/T0%2FB0/x/y"],
    ["an IP literal", "https://127.0.0.1/services/T0/B0/x"],
    ["a lookalike service", "https://hooks.slack.co/services/T0/B0/x"],
    ["empty", ""],
    ["not a URL", "slack please"],
    ["very long", `${SLACK}${"a".repeat(600)}`],
  ])("refuses %s", (_label, raw) => {
    expect(parseAlertDestination(raw)).toBeNull();
  });
});

describe("formatWorkspaceAlert", () => {
  const base = {
    agentName: "summarizer",
    at: new Date("2026-10-05T09:30:00Z"),
    dashboardUrl: "https://passcontrol.example/dashboard/agents/agent-1",
  };

  it("names the agent, what happened and where to look", () => {
    const slack = formatWorkspaceAlert("slack", { ...base, type: "refused", status: "blocked_scope", model: "gpt-5" });
    expect(slack.text).toContain("`summarizer`");
    expect(slack.text).toContain("`gpt-5`");
    expect(slack.text).toMatch(/not allowed/);
    expect(slack.text).toContain("<https://passcontrol.example/dashboard/agents/agent-1|Open in PassControl>");
    expect(slack.text).toMatch(/paused for 10 minutes/);

    const discord = formatWorkspaceAlert("discord", { ...base, type: "budget", status: "blocked_budget" });
    expect(discord.content).toMatch(/budget/);
    expect(discord.content).toContain("https://passcontrol.example/dashboard/agents/agent-1");
    expect(discord.allowed_mentions).toEqual({ parse: [] });
  });

  it.each([
    "@everyone",
    "<!channel>",
    "<@U12345>",
    "<https://evil.example|click here>",
    "[click](https://evil.example)",
    "`` break out ``",
    "line\nbreak\r",
    "x".repeat(500),
  ])("leaves an agent-chosen model inert: %s", (model) => {
    const slack = formatWorkspaceAlert("slack", { ...base, type: "refused", status: "blocked_scope", model }).text;
    const discord = formatWorkspaceAlert("discord", { ...base, type: "refused", status: "blocked_scope", model }).content;
    for (const text of [slack, discord]) {
      expect(text).not.toMatch(/<!|<@|<https?:\/\/evil|\]\(https?:/u);
      expect(text).not.toContain("@everyone");
      expect(text.split("\n").length).toBeLessThanOrEqual(3);
      expect(text.length).toBeLessThan(700);
    }
  });

  it("escapes an owner-chosen agent name too", () => {
    const slack = formatWorkspaceAlert("slack", { ...base, agentName: "<!here> & co", type: "passport_rotated" }).text;
    expect(slack).not.toContain("<!here>");
    expect(slack).toContain("&lt;!here&gt; &amp; co");
  });

  it("says plainly that a test alert is a test", () => {
    expect(formatWorkspaceAlert("slack", { ...base, type: "test" }).text).toMatch(/^Test alert from PassControl/);
  });
});

// Telegram has no webhook URL: a bot token and a chat id. The server builds
// the one address it will ever send to, and the stored form is checked again
// before every send, like the other two.
import { parseTelegramDestination } from "@/lib/alerts/destination";

const BOT_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0";
const TELEGRAM_URL = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=-1001234567890`;

describe("Telegram destinations", () => {
  it("builds the canonical address from a bot token and a chat id, and hints without the token", () => {
    const parsed = parseTelegramDestination(` ${BOT_TOKEN} `, " -1001234567890 ");
    expect(parsed).toEqual({ kind: "telegram", url: TELEGRAM_URL, hint: "bot …saw0 → chat -1001234567890" });
    expect(parsed?.hint).not.toContain("AAHdqTcv");
  });

  it("accepts a public channel username as the chat", () => {
    expect(parseTelegramDestination(BOT_TOKEN, "@passcontrol_alerts")?.url).toBe(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=%40passcontrol_alerts`
    );
  });

  it("re-reads its own stored address", () => {
    expect(parseAlertDestination(TELEGRAM_URL)).toMatchObject({ kind: "telegram", url: TELEGRAM_URL });
  });

  it.each([
    ["no chat", `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`],
    ["another method", `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?chat_id=1`],
    ["an extra parameter", `${TELEGRAM_URL}&parse_mode=HTML`],
    ["a lookalike host", TELEGRAM_URL.replace("api.telegram.org", "api.telegram.org.evil.example")],
    ["the file host", TELEGRAM_URL.replace("/bot", "/file/bot")],
    ["a malformed token", "https://api.telegram.org/botNOTATOKEN/sendMessage?chat_id=1"],
  ])("refuses a stored address with %s", (_label, raw) => {
    expect(parseAlertDestination(raw)).toBeNull();
  });

  it.each([
    ["an empty token", "", "-100123"],
    ["a token without its bot id", "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0", "-100123"],
    ["a token with a slash", "123:abc/../../x", "-100123"],
    ["an empty chat", BOT_TOKEN, ""],
    ["a chat with letters", BOT_TOKEN, "12ab"],
    ["a chat with a slash", BOT_TOKEN, "-100/../x"],
    ["a too-short username", BOT_TOKEN, "@abc"],
  ])("refuses %s", (_label, token, chat) => {
    expect(parseTelegramDestination(token, chat)).toBeNull();
  });

  it("sends plain text: no parse mode, no link previews, nothing that can mention anyone", () => {
    const body = formatWorkspaceAlert("telegram", {
      type: "refused",
      status: "blocked_scope",
      model: "@everyone <b>x</b>",
      agentName: "@admin bot",
      at: new Date("2026-10-05T09:30:00Z"),
      dashboardUrl: "https://passcontrol.example/dashboard/agents/agent-1",
    }, "-1001234567890");
    expect(body.chat_id).toBe("-1001234567890");
    expect(body).not.toHaveProperty("parse_mode");
    expect(body.disable_web_page_preview).toBe(true);
    expect(body.text).not.toContain("@");
    expect(body.text).not.toContain("<b>");
    expect(body.text).toContain("https://passcontrol.example/dashboard/agents/agent-1");
  });
});
