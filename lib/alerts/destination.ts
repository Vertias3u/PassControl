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
import type { HeadsUpAlert } from "@/lib/budget-headsup";
import { redactSecrets } from "@/lib/redact";

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

export type WorkspaceAlertType =
  | "refused"
  | "budget"
  | "passport_rotated"
  | "break_glass"
  | "session_spend"
  | "tripwire_used"
  | "tripwire_seen"
  | "mission_draft"
  | "memory_arrival"
  | "recap"
  | "test";

/** Idea 12: what a tripwire alert says. Server-computed; no decoy, no content. */
export interface TripwireAlertDetail {
  /** Whose decoy it was is `agentName`; this is who presented or carried it. */
  presenter: "unauthenticated" | "this_workspace_agent" | "other_workspace_agent" | "carrier";
  /** The presenter's name, when it is an agent of this workspace. */
  presenterName?: string;
  /** True on the copy sent to the PRESENTER's workspace (the decoy belongs elsewhere). */
  presenterSide?: boolean;
  flags: string[];
  /** Outcome of the stop on the agent the decoy names, and on the presenter. */
  namedStop?: string;
  presenterStop?: string;
}


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
  /** session_spend: the DECLARED session id (held to the declared-id alphabet), its total and the threshold. */
  session?: string;
  spentMicrocents?: number;
  thresholdMicrocents?: number;
  /** budget_headsup (1.6.0, L8): what is reached when, at this period's rate. Server-computed. */
  headsUp?: HeadsUpAlert;
  /** recap: C6's server-computed weekly text (one bounded part if needed). */
  recapText?: string;
  /** tripwire_used / tripwire_seen (idea 12). */
  tripwire?: TripwireAlertDetail;
  /** memory_arrival (idea 13): how many entries wait, and which kinds of outside content. Counts and fixed words only: never entry text. */
  memory?: { entries: number; origins: string[]; withheld?: boolean };
}

const dollars = (microcents: number) => `$${(Math.max(0, microcents) / 100_000_000).toFixed(2)}`;

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
  blocked_loop: "it sent the same request over and over, so the loop breaker paused its model calls for 15 minutes",
};

function sentence(alert: WorkspaceAlert, code: (value: string) => string): string {
  const agent = code(inertName(alert.agentName));
  switch (alert.type) {
    case "recap":
      return redactSecrets(alert.recapText ?? "");
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
        : alert.status === "blocked_budget_pause"
          ? `${agent} reached the pause line you set on its spending limit. PassControl paused its calls; let it go on for an hour from the agent's page.`
          : alert.status === "budget_headsup" && alert.headsUp
          ? headsUpSentence(agent, alert.headsUp, code)
          : alert.status === "budget_pause_switched"
          ? `${agent} reached the pause line you set on its spending limit. PassControl switched its calls to ${code(inertModel(alert.model ?? "?"))} instead of pausing it; its limits still apply.`
          : alert.status === "blocked_budget_subagent"
          ? `A sub-agent of ${agent} reached its per-session spending cap. Its calls are refused; the main agent and other sub-agents keep running.`
          : alert.status === "blocked_session_cap"
          ? `A session of ${agent} reached a cap its policy sets for one session (money, calls or minutes). That session's calls are refused; its other sessions keep running.`
          : alert.status === "blocked_budget_delegation"
            ? `A worker acting for ${agent} reached its delegation's spending cap. Its calls are refused; ${agent} keeps running.`
            : `${agent} ran out of budget. PassControl is refusing its calls until the budget is raised.`;
    case "passport_rotated":
      return `The passport for ${agent} was rotated. If you did not do this, suspend the agent now.`;
    case "break_glass":
      return `A break-glass grant was opened for ${agent}. If you did not do this, suspend the agent now.`;
    case "tripwire_used":
      return tripwireUsedSentence(agent, alert.tripwire, code);
    case "tripwire_seen":
      return tripwireSeenSentence(agent, alert.tripwire, code);
    case "mission_draft":
      // Idea 11. The link opens the approval screen; the button-less message is on
      // purpose: a chat tap carries no owner key, so it cannot approve a mission.
      return `${agent} drafted a mission and is waiting for your approval. Nothing runs under it until you approve it on the approval screen, which shows what is unusual about it first.`;
    case "memory_arrival": {
      const n = Math.max(0, Math.floor(alert.memory?.entries ?? 0));
      const origins = (alert.memory?.origins ?? []).filter((o) => /^[a-z_]{1,32}$/.test(o)).slice(0, 6);
      const why = origins.length ? ` (origin: ${origins.map((o) => code(o)).join(", ")})` : "";
      return (
        `${n} memory ${n === 1 ? "entry" : "entries"} of ${agent} wait at customs${why}: written while outside content was in its context, or with no custody record. ` +
        (alert.memory?.withheld
          ? `They are withheld from its API-mode sessions until you review them on its page; sessions PassControl cannot withhold from are held. Only memory files are covered.`
          : `Its risky tools are held until you accept or reject them on its page. Only memory files are covered.`)
      );
    }
    case "session_spend":
      return (
        `A session of ${agent} passed ${dollars(alert.thresholdMicrocents ?? 0)}: ${dollars(alert.spentMicrocents ?? 0)} so far ` +
        `(session ${code(inertModel(alert.session ?? "?"))}). Nothing is paused. To stop it, use Stop on the agent's Sessions view.`
      );
  }
}

// Idea 12 copy rules (research/idea-12-tripwire/VERDICT.md, forbidden claims): never
// "prevented", never "safe", never "proof of malice", never "this IP did it". Say what was
// observed, what PassControl did, and whether the stop is confirmed.
function tripwireUsedSentence(agent: string, t: TripwireAlertDetail | undefined, code: (value: string) => string): string {
  const flags = new Set(t?.flags ?? []);
  if (t?.presenterSide) {
    const stopped = t.presenterStop === "suspended" || t.presenterStop === "already_stopped";
    // R12-03: a decoy that is no longer armed stops no other workspace's agent.
    const notTried = t.presenterStop === "not_attempted_disarmed";
    return (
      `${agent} presented a decoy credential that belongs to another workspace's tripwire. ` +
      (stopped
        ? "PassControl suspended it. "
        : notTried
          ? "That decoy was no longer armed, so PassControl did not suspend it. "
          : "PassControl could NOT confirm suspending it: check it now. ") +
      "Something in its environment handed it a credential it had no reason to use."
    );
  }
  const by =
    t?.presenter === "this_workspace_agent"
      ? ` by another of your agents, ${code(inertName(t.presenterName ?? "unnamed agent"))}`
      : t?.presenter === "other_workspace_agent"
        ? " by an agent of another workspace"
        : " without an agent credential";
  const parts = [`A tripwire decoy assigned to ${agent} was presented as a credential${by}.`];
  if (flags.has("replay_of_tripped")) parts.push(`That decoy was no longer armed (it had tripped, or was rotated out more than 30 days ago), so ${agent} was not suspended.`);
  else if (t?.namedStop === "suspended" || t?.namedStop === "already_stopped") parts.push(`PassControl suspended ${agent}.`);
  else parts.push(`PassControl could NOT confirm suspending ${agent}: suspend it yourself now.`);
  if (t?.presenter === "this_workspace_agent") {
    parts.push(t.presenterStop === "failed" ? "Suspending the presenting agent could NOT be confirmed." : "The presenting agent was suspended too.");
  }
  if (flags.has("left_machine")) parts.push("It came from a different address than the one the decoy was planted from: the decoy has likely left the machine.");
  if (flags.has("event_write_failed")) parts.push("The event could not be saved; this alert is the only record.");
  parts.push("This does not show who used it. Open the agent to see the event and how to recover.");
  return parts.join(" ");
}

function tripwireSeenSentence(agent: string, t: TripwireAlertDetail | undefined, code: (value: string) => string): string {
  const carrier =
    t?.presenterSide || t?.presenter === "carrier"
      ? t?.presenterName
        ? `${code(inertName(t.presenterName))}'s traffic`
        : "an agent's traffic"
      : "another workspace's agent's traffic";
  const head = t?.presenterSide
    ? `A decoy credential from another workspace's tripwire appeared in ${carrier}.`
    : `A tripwire decoy assigned to ${agent} appeared in ${carrier} through PassControl.`;
  const hold = (t?.flags ?? []).includes("hold_started") ? " Its risky actions now wait for you (hold)." : "";
  // R12-02: a decoy reaches another workspace only by leaving the machine it was planted on.
  if (!t?.presenterSide && t?.presenter === "other_workspace_agent") {
    return (
      `${head} It reached another workspace's agent, so it has likely left the machine it was planted on, and whatever took it may have taken ${agent}'s real credential too. ` +
      `Rotate ${agent}'s key or passport now. Nothing was suspended.`
    );
  }
  return `${head} An agent read a value it had no task reason to read, or a broad search swept it up. Nothing was suspended.${hold}`;
}

function headsUpSentence(agent: string, h: HeadsUpAlert, code: (value: string) => string): string {
  const when = new Date(h.at);
  const time = Number.isFinite(when.getTime()) ? `${when.toISOString().slice(11, 16)} UTC` : "soon";
  const limit = h.period === "month" ? "monthly limit" : "daily limit";
  const spent = `${dollars(h.spentMicrocents)} spent ${h.period === "month" ? "this month" : "today"}`;
  if (h.target === "limit") return `${agent} is on pace to reach its ${limit} of ${dollars(h.targetMicrocents)} around ${time}: ${spent}. Nothing is paused yet.`;
  const head = `${agent} is on pace to reach the ${h.percent ?? "?"}% pause line on its ${limit} (${dollars(h.targetMicrocents)}) around ${time}: ${spent}.`;
  return h.target === "switch" && h.model
    ? `${head} PassControl will switch it to ${code(inertModel(h.model))} there.`
    : `${head} PassControl will pause it there.`;
}

const PAUSE = "Further alerts like this for this agent are paused for 10 minutes.";
// The same throttle, worded without "paused" for the alert that is about a pause.
const HUSH = "PassControl will not repeat this alert for this agent for 10 minutes.";
// The switch and the heads-up are sent once a period (lib/state/budget-notice.ts).
const ONCE = "PassControl sends this once a period for this agent.";
const hush = (alert: WorkspaceAlert) =>
  alert.status === "budget_pause_switched" || alert.status === "budget_headsup" ? ONCE : alert.status === "blocked_budget_pause" ? HUSH : PAUSE;

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
  if (alert.type === "recap") {
    const text = redactSecrets(alert.recapText ?? "");
    if (kind === "telegram") {
      return { chat_id: chatId ?? "", text: text.replaceAll("@", ""), disable_web_page_preview: true as const };
    }
    if (kind === "slack") {
      return { text, mrkdwn: false, unfurl_links: false, unfurl_media: false };
    }
    return { content: text, allowed_mentions: { parse: [] as never[] } };
  }
  const throttled = alert.type === "refused" || alert.type === "budget";
  if (kind === "telegram") {
    // Plain text, no parse_mode: nothing can become a link or formatting. A
    // plain-text @name still mentions someone in Telegram, so no @ survives.
    const quote = (value: string) => `"${value.replaceAll("@", "")}"`;
    const lines = [sentence(alert, quote)];
    if (throttled) lines.push(hush(alert));
    lines.push(alert.dashboardUrl);
    return { chat_id: chatId ?? "", text: lines.join("\n"), disable_web_page_preview: true as const };
  }
  if (kind === "slack") {
    const code = (value: string) => `\`${slackEscape(value)}\``;
    const lines = [sentence(alert, code)];
    if (throttled) lines.push(hush(alert));
    lines.push(`<${alert.dashboardUrl}|Open in PassControl>`);
    return { text: lines.join("\n") };
  }
  const code = (value: string) => `\`${value}\``;
  const lines = [sentence(alert, code)];
  if (throttled) lines.push(hush(alert));
  lines.push(alert.dashboardUrl);
  // No mention of any kind resolves, whatever the text contains.
  return { content: lines.join("\n"), allowed_mentions: { parse: [] as never[] } };
}
