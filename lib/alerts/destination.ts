// Where a workspace alert may go, and what it may say (plans/workspace-alerts.md).
//
// The destination is a URL a tenant pastes and this server later POSTs to: an
// SSRF surface. v1 does not try to defend a generic URL (that needs DNS
// resolution and rebinding checks an edge route cannot do reliably). It
// accepts exactly three services (Slack, Discord, Telegram's sendMessage), by
// exact hostname and path shape, and stores
// the URL it REBUILDS from those parts, never the raw input. The sender checks
// it again before every send.
//
// The message carries a field the AGENT chose (the model a refused call asked
// for), so nothing in it may ping a channel, plant a link or break formatting.

export type AlertDestinationKind = "slack" | "discord" | "telegram";

export interface AlertDestination {
  kind: AlertDestinationKind;
  /** Canonical https URL rebuilt from the validated host and path. */
  url: string;
  /** Safe to show and store in plain text: host plus the last four characters. */
  hint: string;
}

const MAX_URL_LENGTH = 512;
const SLACK_HOSTS = new Set(["hooks.slack.com"]);
const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com"]);
const SLACK_PATH = /^\/services\/[A-Z0-9]{1,32}\/[A-Z0-9]{1,32}\/[A-Za-z0-9]{8,64}$/u;
// Telegram has no webhook URL: a bot token and a chat. The stored form is the
// one address this server will ever send to, sendMessage with the chat as its
// only parameter; the token sits in the path, which is how Telegram's API works.
const TELEGRAM_HOST = "api.telegram.org";
const TELEGRAM_TOKEN = /^[0-9]{5,12}:[A-Za-z0-9_-]{30,64}$/u;
const TELEGRAM_PATH = /^\/bot([0-9]{5,12}:[A-Za-z0-9_-]{30,64})\/sendMessage$/u;
// A numeric chat id (negative for groups and channels) or a public @username.
const TELEGRAM_CHAT = /^(?:-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/u;
const DISCORD_PATH = /^\/api\/webhooks\/[0-9]{5,25}\/[A-Za-z0-9_-]{20,128}$/u;

export function parseAlertDestination(raw: string): AlertDestination | null {
  const input = String(raw ?? "").trim();
  if (!input || input.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
    return null;
  }
  if (url.hostname === TELEGRAM_HOST) {
    const token = TELEGRAM_PATH.exec(url.pathname)?.[1];
    const keys = [...url.searchParams.keys()];
    const chat = url.searchParams.get("chat_id") ?? "";
    if (!token || keys.length !== 1 || keys[0] !== "chat_id") return null;
    return parseTelegramDestination(token, chat);
  }
  if (url.search) return null;
  // URL lowercases the host and resolves dot segments; an exact match on the
  // result refuses suffixes, prefixes, trailing dots and IP literals alike.
  const host = url.hostname;
  let kind: AlertDestinationKind;
  if (SLACK_HOSTS.has(host) && SLACK_PATH.test(url.pathname)) kind = "slack";
  else if (DISCORD_HOSTS.has(host) && DISCORD_PATH.test(url.pathname)) kind = "discord";
  else return null;
  return {
    kind,
    url: `https://${host}${url.pathname}`,
    hint: `${host}/…/${url.pathname.slice(-4)}`,
  };
}

/** The Telegram form: what the Settings page collects, as two fields. */
export function parseTelegramDestination(botToken: string, chatId: string): AlertDestination | null {
  const token = String(botToken ?? "").trim();
  const chat = String(chatId ?? "").trim();
  if (!TELEGRAM_TOKEN.test(token) || !TELEGRAM_CHAT.test(chat)) return null;
  const query = new URLSearchParams({ chat_id: chat });
  return {
    kind: "telegram",
    url: `https://${TELEGRAM_HOST}/bot${token}/sendMessage?${query}`,
    // The chat is not a secret and is what tells two destinations apart; the
    // token is, so only its last four characters are shown.
    hint: `bot …${token.slice(-4)} → chat ${chat}`,
  };
}

/**
 * The Bot API base for a Telegram destination, rebuilt from the token the
 * parser validated: every other method this server calls (the approval
 * buttons' getUpdates, answerCallbackQuery, editMessageText) is this plus a
 * method name, never an edit of the stored URL.
 */
export function telegramBotBase(destination: AlertDestination): string | null {
  if (destination.kind !== "telegram") return null;
  const token = TELEGRAM_PATH.exec(new URL(destination.url).pathname)?.[1];
  return token && TELEGRAM_TOKEN.test(token) ? `https://${TELEGRAM_HOST}/bot${token}` : null;
}

/** Where a Telegram destination is POSTed, and to which chat. */
export function telegramTarget(destination: AlertDestination): { endpoint: string; chatId: string } | null {
  if (destination.kind !== "telegram") return null;
  const url = new URL(destination.url);
  return { endpoint: `https://${url.hostname}${url.pathname}`, chatId: url.searchParams.get("chat_id") ?? "" };
}

export type WorkspaceAlertType = "refused" | "budget" | "passport_rotated" | "break_glass" | "test";

export interface WorkspaceAlert {
  type: WorkspaceAlertType;
  agentName: string;
  /** The gateway status behind a refused or budget alert, e.g. `blocked_scope`. */
  status?: string;
  /** The model the call asked for. Agent-controlled: sanitised before use. */
  model?: string;
  at: Date;
  /** Built by this server from its own origin, never from request input. */
  dashboardUrl: string;
}

/** Same alphabet a usable model id has (lib/agent-connect.ts), so nothing in
 * it can start a mention, a link or a formatting run; anything else shows as ?. */
function inertModel(value: string): string {
  return value.replace(/[^A-Za-z0-9._:/-]/gu, "?").slice(0, 80) || "?";
}

/** Owner-chosen, but still kept to one line and out of code-span syntax. */
export function inertName(value: string): string {
  return value.replace(/[`\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 80) || "unnamed agent";
}

export function slackEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const REFUSAL: Record<string, string> = {
  blocked_scope: "it is not allowed to use",
  blocked_endpoint: "that endpoint is not allowed for it",
  blocked_policy: "its policy refused the call",
};

function sentence(alert: WorkspaceAlert, code: (value: string) => string): string {
  const agent = code(inertName(alert.agentName));
  switch (alert.type) {
    case "test":
      return "Test alert from PassControl. Alerts for this workspace will arrive here.";
    case "refused": {
      const reason = REFUSAL[alert.status ?? ""] ?? "the call was refused";
      const model = alert.model ? ` ${code(inertModel(alert.model))}` : "";
      return alert.status === "blocked_scope"
        ? `PassControl refused a call from ${agent}: it asked for${model || " a model"}, which ${reason}.`
        : `PassControl refused a call from ${agent}${model ? ` to${model}` : ""}: ${reason}.`;
    }
    case "budget":
      return alert.status === "blocked_budget_period"
        ? `${agent} reached its budget for this period. PassControl is refusing its calls until the period resets.`
        : `${agent} ran out of budget. PassControl is refusing its calls until the budget is raised.`;
    case "passport_rotated":
      return `The passport for ${agent} was rotated. If you did not do this, suspend the agent now.`;
    case "break_glass":
      return `A break-glass grant was opened for ${agent}. If you did not do this, suspend the agent now.`;
  }
}

const PAUSE = "Further alerts like this for this agent are paused for 10 minutes.";

export function formatWorkspaceAlert(kind: "slack", alert: WorkspaceAlert): { text: string };
export function formatWorkspaceAlert(
  kind: "telegram",
  alert: WorkspaceAlert,
  chatId: string
): { chat_id: string; text: string; disable_web_page_preview: true };
export function formatWorkspaceAlert(
  kind: "discord",
  alert: WorkspaceAlert
): { content: string; allowed_mentions: { parse: never[] } };
export function formatWorkspaceAlert(kind: AlertDestinationKind, alert: WorkspaceAlert, chatId?: string) {
  const throttled = alert.type === "refused" || alert.type === "budget";
  if (kind === "telegram") {
    // Plain text, no parse_mode: nothing can become a link or formatting. A
    // plain-text @name still mentions someone in Telegram, so no @ survives.
    const quote = (value: string) => `"${value.replaceAll("@", "")}"`;
    const lines = [sentence(alert, quote)];
    if (throttled) lines.push(PAUSE);
    lines.push(alert.dashboardUrl);
    return { chat_id: chatId ?? "", text: lines.join("\n"), disable_web_page_preview: true as const };
  }
  if (kind === "slack") {
    const code = (value: string) => `\`${slackEscape(value)}\``;
    const lines = [sentence(alert, code)];
    if (throttled) lines.push(PAUSE);
    lines.push(`<${alert.dashboardUrl}|Open in PassControl>`);
    return { text: lines.join("\n") };
  }
  const code = (value: string) => `\`${value}\``;
  const lines = [sentence(alert, code)];
  if (throttled) lines.push(PAUSE);
  lines.push(alert.dashboardUrl);
  // No mention of any kind resolves, whatever the text contains.
  return { content: lines.join("\n"), allowed_mentions: { parse: [] as never[] } };
}
