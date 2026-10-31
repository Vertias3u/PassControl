// "Ask me first": asking the owner, on the workspace's own alert destination.
//
// Telegram gets two buttons, Approve and Deny, because a link to the dashboard
// makes the owner open a browser and sign in to answer one question (owner's
// call, 2026-10-05). Slack and Discord incoming webhooks cannot carry buttons
// that call back, so they get the request and a link. Every destination also
// has the dashboard's Approvals panel, which needs nothing from Telegram.
//
// ── How a tap gets back here ────────────────────────────────────────────────
//
// By polling `getUpdates`, not a webhook. Self-host runs on localhost, which
// Telegram cannot reach, and one path for both deployments is one path to get
// right; it also adds no public endpoint. The waiting gateway call polls (a
// long-poll, so a tap is seen within a second), the agent's retry polls, and
// the dashboard panel polls. One poll per workspace at a time (a Redis lock;
// Telegram ends the older of two anyway), and whoever polls decides EVERY tap
// it receives, not only its own.
//
// A tap is a decision only through decideApproval, which requires the tap to
// come from the message this server sent for that approval, in the chat it was
// sent to, still showing the text it was sent with (a hash is stored at send
// time; an edited message is refused outright). The approval id is never shown
// to the agent, but an agent holding the same bot could post a look-alike
// button, or edit the question above the real one; the binding makes both
// useless, and the owner answers on the Approvals page instead.
//
// The prompt carries text the AGENT chose (its path and body), so it is inert
// everywhere: no parse_mode on Telegram and no @ (a plain @name still pings
// there), no mention resolving on Discord, escaped on Slack, and a preview
// that cannot leave its code span.
import { serviceClient } from "@/lib/supabase";
import {
  formatWorkspaceAlert,
  inertName,
  parseAlertDestination,
  slackEscape,
  telegramBotBase,
  telegramTarget,
  type AlertDestination,
  type AlertDestinationKind,
  type WorkspaceAlert,
} from "@/lib/alerts/destination";
import {
  PENDING_TTL_S,
  approvalAgentForTap,
  attachTelegramMessage,
  claimTelegramPoll,
  decideApproval,
  readTelegramOffset,
  releaseTelegramPoll,
  writeTelegramOffset,
} from "@/lib/state/approvals";
import { recordAdminAction } from "@/lib/audit";
import { liftSeconds } from "@/lib/budget-pause";
import { liftPause, newPausePromptId, recordPausePrompt, recordStopPrompt, takePausePrompt, takeStopPrompt } from "@/lib/state/pause";
import { setAgentSuspended } from "@/lib/fleet";
import { clearTaint } from "@/lib/state/taint";
import { secondsUntilPeriodEnd } from "@/lib/period";
import { logSecurityEvent } from "@/lib/seclog";
import { dispatchSecurityAlert } from "@/lib/alert";

const SEND_TIMEOUT_MS = 3000;
// How much of the query and body each prompt shows. Telegram's message limit is
// 4096 characters and Discord's 2000. The Approvals page shows ALL of it, and a
// prompt that shows less says so; on Telegram it then offers only Deny, so a
// yes is never given to text the owner did not see.
const TELEGRAM_PREVIEW_MAX = 1500;
const WEBHOOK_PREVIEW_MAX = 900;
const PATH_MAX = 200;
/** Telegram's own ceiling on a long-poll is 50 seconds; ours is far below it. */
const MAX_POLL_SECONDS = 20;

export interface ApprovalPromptInfo {
  id: string;
  agentName: string;
  serviceLabel: string;
  method: string;
  path: string;
  preview: string;
  dashboardUrl: string;
  /**
   * How long the caller holds what it asks about, when that is not the store's 15
   * minutes: a Claude Code tool is refused at its agent's own wait (Phase 2). Written
   * by the gateway, never from agent text.
   */
  waitNote?: string;
  /**
   * Why the call is held, when it is not the owner's own rule: the injection guard's
   * hold (Phase 2). Shown right under the header. Written by the gateway, never from
   * agent text.
   */
  heldBecause?: string;
  /** Telegram only: a "Clear the hold" button, for an agent the injection guard holds. */
  offerClear?: boolean;
}

/** A path as a path: anything else shows as `?`, so it cannot start a link or a mention. */
function inertPath(value: string): string {
  return value.replace(/[^A-Za-z0-9._~:/?&=%+,-]/gu, "?").slice(0, PATH_MAX) || "/";
}

/** The preview as one block of text, and how much of it was left out. */
function shortPreview(value: string, max: number): { text: string; omitted: number } {
  // Newlines stay (a body reads better with them); other control characters go.
  const clean = value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/gu, " ").trim();
  return clean.length > max ? { text: clean.slice(0, max), omitted: clean.length - max } : { text: clean, omitted: 0 };
}

const omittedNote = (omitted: number) =>
  `…and ${omitted} more characters. Read the whole request on the Approvals page before approving.`;

/** What a Telegram tap is checked against: the text of the message PassControl sent. */
export async function approvalTextHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const MINUTES = Math.round(PENDING_TTL_S / 60);

export function formatApprovalPrompt(
  kind: "telegram",
  info: ApprovalPromptInfo,
  chatId: string
): {
  chat_id: string;
  text: string;
  disable_web_page_preview: true;
  reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
};
export function formatApprovalPrompt(kind: "slack", info: ApprovalPromptInfo): { text: string };
export function formatApprovalPrompt(
  kind: "discord",
  info: ApprovalPromptInfo
): { content: string; allowed_mentions: { parse: never[] } };
export function formatApprovalPrompt(kind: AlertDestinationKind, info: ApprovalPromptInfo, chatId?: string) {
  const name = inertName(info.agentName);
  const method = info.method.replace(/[^A-Z]/gu, "").slice(0, 10) || "?";
  const path = inertPath(info.path);
  const wait = info.waitNote ?? `The call is held until you answer, for up to ${MINUTES} minutes.`;

  if (kind === "telegram") {
    // A plain @name pings on Telegram. The full-width ＠ looks the same and
    // mentions nobody, so the owner still sees "@everyone" in a body.
    const plain = (value: string) => value.replaceAll("@", "＠");
    const preview = shortPreview(info.preview, TELEGRAM_PREVIEW_MAX);
    const lines = [
      `PassControl: "${plain(name)}" asks to call ${info.serviceLabel}:`,
      ...(info.heldBecause ? [info.heldBecause] : []),
      `${method} ${plain(path)}`,
      ...(preview.text ? [plain(preview.text)] : []),
      ...(preview.omitted ? [omittedNote(preview.omitted)] : []),
      wait,
      info.dashboardUrl,
    ];
    const deny = { text: "Deny", callback_data: `pcd:${info.id}` };
    const answer = preview.omitted ? [deny] : [{ text: "Approve", callback_data: `pca:${info.id}` }, deny];
    // Its own row: ending the hold is a different act from answering this question.
    const clear = info.offerClear ? [[{ text: "Clear the hold", callback_data: `pcc:${info.id}` }]] : [];
    return {
      chat_id: chatId ?? "",
      text: lines.join("\n"),
      disable_web_page_preview: true as const,
      reply_markup: { inline_keyboard: [answer, ...clear] },
    };
  }
  const preview = shortPreview(info.preview, WEBHOOK_PREVIEW_MAX);

  // A code span cannot contain its own delimiter; a ' reads the same.
  const code = (value: string) => `\`${value.replaceAll("`", "'")}\``;
  if (kind === "slack") {
    const lines = [
      `PassControl: ${code(slackEscape(name))} asks to call ${slackEscape(info.serviceLabel)}:`,
      ...(info.heldBecause ? [slackEscape(info.heldBecause)] : []),
      code(slackEscape(`${method} ${path}`)),
      ...(preview.text ? [code(slackEscape(preview.text))] : []),
      ...(preview.omitted ? [omittedNote(preview.omitted)] : []),
      wait,
      `<${info.dashboardUrl}|Review in PassControl>`,
    ];
    return { text: lines.join("\n") };
  }
  const lines = [
    `PassControl: ${code(name)} asks to call ${info.serviceLabel}:`,
    ...(info.heldBecause ? [info.heldBecause] : []),
    code(`${method} ${path}`),
    ...(preview.text ? [code(preview.text)] : []),
    ...(preview.omitted ? [omittedNote(preview.omitted)] : []),
    wait,
    // Angle brackets: Discord shows the link without unfurling it.
    `<${info.dashboardUrl}>`,
  ];
  return { content: lines.join("\n"), allowed_mentions: { parse: [] as never[] } };
}

/** The workspace's alert destination, read the way notifyWorkspace reads it. */
async function readDestination(userId: string): Promise<{ destination: AlertDestination; url: string } | null> {
  const db = serviceClient();
  const { data: settings, error } = await db
    .from("workspace_alerts")
    .select("destination")
    .eq("user_id", userId)
    .maybeSingle();
  if (error || !settings) return null;
  const { data: url } = await db.rpc("get_workspace_alert_url_for_user", { p_user_id: userId });
  if (typeof url !== "string") return null;
  const destination = parseAlertDestination(url);
  if (!destination || destination.kind !== (settings as { destination?: unknown }).destination) return null;
  return { destination, url };
}

async function post(endpoint: string, body: object): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
}

/**
 * Ask the owner. Not throttled and not filtered by the alert event choices:
 * the owner asked to be asked, by turning the rule's switch on. One prompt per
 * approval, because the gateway sends one only when it creates the approval.
 * Never throws.
 */
export async function sendApprovalPrompt(
  userId: string,
  info: ApprovalPromptInfo
): Promise<{ sent: boolean; channel: AlertDestinationKind | null }> {
  let channel: AlertDestinationKind | null = null;
  try {
    const read = await readDestination(userId);
    if (!read) return { sent: false, channel: null };
    const { destination } = read;
    channel = destination.kind;
    if (destination.kind === "telegram") {
      const target = telegramTarget(destination);
      if (!target) return { sent: false, channel };
      const prompt = formatApprovalPrompt("telegram", info, target.chatId);
      const res = await post(target.endpoint, prompt);
      if (!res.ok) return { sent: false, channel };
      const body = (await res.json().catch(() => null)) as {
        result?: { message_id?: unknown; chat?: { id?: unknown } };
      } | null;
      const message = body?.result?.message_id;
      const chat = body?.result?.chat?.id;
      // Without the message it was sent as, a tap could never be accepted:
      // the dashboard still answers, so this is "sent", not a failure.
      if ((typeof message === "number" || typeof message === "string") && (typeof chat === "number" || typeof chat === "string")) {
        await attachTelegramMessage(info.id, String(chat), String(message), await approvalTextHash(prompt.text));
      }
      return { sent: true, channel };
    }
    const body =
      destination.kind === "slack" ? formatApprovalPrompt("slack", info) : formatApprovalPrompt("discord", info);
    const res = await post(destination.url, body);
    return { sent: res.ok, channel };
  } catch {
    return { sent: false, channel };
  }
}

type TelegramUpdate = {
  update_id?: unknown;
  callback_query?: {
    id?: unknown;
    data?: unknown;
    message?: { message_id?: unknown; chat?: { id?: unknown }; text?: unknown; edit_date?: unknown };
  };
};

const CALLBACK = /^pc([ad]):([A-Za-z0-9_-]{22})$/u;
// The soft pause's "Let it go on for an hour" (1.6.0, L4b). Read by this same loop:
// a second getUpdates reader would share the offset and eat the other's taps.
const PAUSE_CALLBACK = /^ppl:([A-Za-z0-9_-]{22})$/u;
// The heads-up's "Suspend it now" (L8b): its own prefix and its own records
// (lib/state/pause.ts), so neither button can be made to do the other's job.
const STOP_CALLBACK = /^pps:([A-Za-z0-9_-]{22})$/u;
// "Clear the hold" on a held prompt (injection guard, Phase 2): names the approval.
const CLEAR_CALLBACK = /^pcc:([A-Za-z0-9_-]{22})$/u;

export type PollResult =
  | { state: "ok"; decided: number }
  /** Another poll for this workspace is running; it decides what this would have. */
  | { state: "busy" }
  /** The workspace's alerts are not on Telegram, so there is nothing to poll. */
  | { state: "not_telegram" }
  /** Telegram refused getUpdates because the bot has a webhook: taps cannot be read. */
  | { state: "conflict" }
  | { state: "error" };

/**
 * Read the owner's taps from Telegram and decide each one. `waitSeconds` is
 * the long-poll: Telegram answers as soon as a tap arrives, or after it.
 * `maxMs` caps the whole request, for a caller with a deadline of its own: a
 * Telegram that hangs is otherwise cut off only 5 s after the long-poll ends.
 */
export async function pollTelegramDecisions(userId: string, waitSeconds: number, maxMs?: number): Promise<PollResult> {
  const read = await readDestination(userId).catch(() => null);
  if (!read || read.destination.kind !== "telegram") return { state: "not_telegram" };
  const base = telegramBotBase(read.destination);
  if (!base) return { state: "not_telegram" };
  const wait = Math.max(0, Math.min(MAX_POLL_SECONDS, Math.floor(waitSeconds)));

  if (!(await claimTelegramPoll(userId, wait + 10).catch(() => false))) return { state: "busy" };
  try {
    const offset = await readTelegramOffset(userId);
    const query = new URLSearchParams({
      offset: String(offset),
      timeout: String(wait),
      allowed_updates: JSON.stringify(["callback_query"]),
    });
    const res = await fetch(`${base}/getUpdates?${query}`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(maxMs === undefined ? (wait + 5) * 1000 : Math.min((wait + 5) * 1000, Math.max(0, maxMs))),
    });
    if (res.status === 409) return { state: "conflict" };
    if (!res.ok) return { state: "error" };
    const body = (await res.json().catch(() => null)) as { ok?: unknown; result?: unknown } | null;
    if (!body || body.ok !== true || !Array.isArray(body.result)) return { state: "error" };

    let next = offset;
    let decided = 0;
    for (const update of body.result as TelegramUpdate[]) {
      if (typeof update.update_id === "number" && update.update_id + 1 > next) next = update.update_id + 1;
      const query = update.callback_query;
      if (!query || (typeof query.id !== "string" && typeof query.id !== "number")) continue;
      const match = typeof query.data === "string" ? CALLBACK.exec(query.data) : null;
      const chat = query.message?.chat?.id;
      const message = query.message?.message_id;
      let answer = "PassControl does not know this button.";
      const text = typeof query.message?.text === "string" ? query.message.text : "";
      const pauseMatch = typeof query.data === "string" ? PAUSE_CALLBACK.exec(query.data) : null;
      const stopMatch = typeof query.data === "string" ? STOP_CALLBACK.exec(query.data) : null;
      const clearMatch = typeof query.data === "string" ? CLEAR_CALLBACK.exec(query.data) : null;
      if (clearMatch && query.message?.edit_date !== undefined) {
        answer = "This message was changed after PassControl sent it. Use the agent's page.";
      } else if (clearMatch && text && (typeof chat === "number" || typeof chat === "string") && typeof message === "number") {
        const agentId = await approvalAgentForTap({
          userId,
          id: clearMatch[1]!,
          chat: String(chat),
          message: String(message),
          textHash: await approvalTextHash(text),
        }).catch(() => null);
        const cleared = agentId ? await clearFromTelegram(userId, agentId) : null;
        if (cleared !== null) {
          decided++;
          // The message is left as sent: Approve and Deny are bound to its text.
          answer = "Hold cleared. This request still waits for Approve or Deny.";
        } else {
          answer = agentId
            ? "PassControl could not clear the hold just now. Use the agent's page."
            : "This button was already used, or has expired. Use the agent's page.";
        }
      } else if (stopMatch && query.message?.edit_date !== undefined) {
        answer = "This message was changed after PassControl sent it. Use the agent's page.";
      } else if (stopMatch && text && (typeof chat === "number" || typeof chat === "string") && typeof message === "number") {
        const agentId = await takeStopPrompt({
          userId,
          id: stopMatch[1]!,
          chat: String(chat),
          message: String(message),
          textHash: await approvalTextHash(text),
        }).catch(() => null);
        if (!agentId) {
          answer = "This button was already used, or has expired. Use the agent's page.";
        } else if (await suspendFromTelegram(userId, agentId)) {
          decided++;
          answer = "Suspended.";
          await post(`${base}/editMessageText`, {
            chat_id: String(chat),
            message_id: message,
            text: `${text}\n\nSuspended at ${new Date().toISOString().slice(11, 16)} UTC. Resume it from the agent's page.`,
            disable_web_page_preview: true,
          }).catch(() => undefined);
        } else {
          answer = "PassControl could not suspend it just now. Use the agent's page.";
        }
      } else if (pauseMatch && query.message?.edit_date !== undefined) {
        answer = "This message was changed after PassControl sent it. Use the agent's page.";
      } else if (pauseMatch && text && (typeof chat === "number" || typeof chat === "string") && typeof message === "number") {
        const agentId = await takePausePrompt({
          userId,
          id: pauseMatch[1]!,
          chat: String(chat),
          message: String(message),
          textHash: await approvalTextHash(text),
        }).catch(() => null);
        const until = agentId ? await liftFromTelegram(userId, agentId) : null;
        if (until) {
          decided++;
          answer = "Going on for an hour.";
          await post(`${base}/editMessageText`, {
            chat_id: String(chat),
            message_id: message,
            text: `${text}\n\nGoing on until ${until.toISOString().slice(11, 16)} UTC.`,
            disable_web_page_preview: true,
          }).catch(() => undefined);
        } else {
          answer = "This button was already used, or has expired. Use the agent's page.";
        }
      } else if (match && query.message?.edit_date !== undefined) {
        // PassControl never edits a question before it is answered, so an
        // edited one was changed by someone else holding the bot.
        answer = "This message was changed after PassControl sent it. Answer on the Approvals page.";
      } else if (match && text && (typeof chat === "number" || typeof chat === "string") && typeof message === "number") {
        const decision = match[1] === "a" ? "approved" : "denied";
        const result = await decideApproval({
          userId,
          id: match[2]!,
          decision,
          by: "telegram",
          telegram: { chat: String(chat), message: String(message), textHash: await approvalTextHash(text) },
        });
        if (result.state === decision) {
          decided++;
          answer = decision === "approved" ? "Approved" : "Denied";
          // Without reply_markup, the edit removes the buttons.
          await post(`${base}/editMessageText`, {
            chat_id: String(chat),
            message_id: message,
            text: `${text}\n\n${decision === "approved" ? "Approved" : "Denied"} in Telegram.`,
            disable_web_page_preview: true,
          }).catch(() => undefined);
        } else {
          answer = "This request was already answered, or has expired.";
        }
      }
      await post(`${base}/answerCallbackQuery`, { callback_query_id: String(query.id), text: answer }).catch(
        () => undefined
      );
    }
    if (next !== offset) await writeTelegramOffset(userId, next);
    return { state: "ok", decided };
  } catch {
    return { state: "error" };
  } finally {
    await releaseTelegramPoll(userId).catch(() => undefined);
  }
}

/**
 * End an agent's injection-guard hold, from a tap approvalAgentForTap has already
 * bound to this workspace. Audited as the dashboard's Clear is. Whether there was a
 * hold, or null when Redis could not clear it.
 */
async function clearFromTelegram(userId: string, agentId: string): Promise<boolean | null> {
  let cleared: boolean;
  try {
    cleared = await clearTaint(agentId);
  } catch {
    return null;
  }
  await recordAdminAction({
    userId,
    action: "agent.injection_clear",
    targetType: "agent",
    targetId: agentId,
    metadata: { cleared, by: "telegram" },
  }).catch(() => undefined);
  return cleared;
}

/**
 * Let a paused agent go on, from a tap takePausePrompt has already bound to this
 * workspace. As long as the dashboard's lift: an hour, or until a daily or monthly
 * limit resets. Returns when it ends, or null when it could not be set.
 */
async function liftFromTelegram(userId: string, agentId: string): Promise<Date | null> {
  try {
    const { data } = await serviceClient()
      .from("agents")
      .select("budget_period")
      .eq("user_id", userId) // tenant boundary: service_role bypasses RLS
      .eq("id", agentId)
      .maybeSingle();
    if (!data) return null;
    const period = (data as { budget_period?: unknown }).budget_period;
    const now = Date.now();
    const seconds = liftSeconds(period === "day" || period === "month" ? period : null, now);
    await liftPause(agentId, seconds);
    await recordAdminAction({
      userId,
      action: "agent.pause_lift",
      targetType: "agent",
      targetId: agentId,
      metadata: { lifted: true, seconds, by: "telegram" },
    }).catch(() => undefined);
    return new Date(now + seconds * 1000);
  } catch {
    return null;
  }
}

/**
 * Suspend an agent from a tap takeStopPrompt has already bound to this workspace,
 * through the fleet's own path: the Redis block first, the caches, then the row,
 * each scoped to this tenant. Audited as the dashboard's suspend is. True only when
 * the suspend took.
 */
async function suspendFromTelegram(userId: string, agentId: string): Promise<boolean> {
  try {
    const result = await setAgentSuspended(serviceClient(), userId, agentId, true);
    if (!result.ok) return false;
    // As the dashboard's suspend: the operator's security log and webhook see it.
    const fields = { user: userId, agentId, suspended: true, by: "telegram" };
    logSecurityEvent("agent.suspend", fields);
    await dispatchSecurityAlert("agent.suspend", fields);
    await recordAdminAction({
      userId,
      action: "agent.suspend",
      targetType: "agent",
      targetId: agentId,
      metadata: { suspended: true, by: "telegram" },
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * The heads-up (L8) on Telegram with "Suspend it now", for a workspace whose alerts
 * go there. The text is the ordinary alert's, so the hash binds what the owner saw.
 * False everywhere else, so the caller sends the ordinary alert. Never throws.
 */
export async function sendHeadsUpPrompt(userId: string, info: { agentId: string; alert: WorkspaceAlert }): Promise<boolean> {
  try {
    const read = await readDestination(userId);
    if (!read || read.destination.kind !== "telegram") return false;
    const target = telegramTarget(read.destination);
    if (!target) return false;
    const id = newPausePromptId();
    const body = {
      ...formatWorkspaceAlert("telegram", info.alert, target.chatId),
      reply_markup: { inline_keyboard: [[{ text: "Suspend it now", callback_data: `pps:${id}` }]] },
    };
    const res = await post(target.endpoint, body);
    if (!res.ok) return false;
    const sent = (await res.json().catch(() => null)) as { result?: { message_id?: unknown; chat?: { id?: unknown } } } | null;
    const message = sent?.result?.message_id;
    const chat = sent?.result?.chat?.id;
    if ((typeof message === "number" || typeof message === "string") && (typeof chat === "number" || typeof chat === "string")) {
      const period = info.alert.headsUp?.period;
      await recordStopPrompt(
        id,
        { uid: userId, agid: info.agentId, chat: String(chat), msg: String(message), hash: await approvalTextHash(body.text) },
        period ? secondsUntilPeriodEnd(period, Date.now()) : undefined
      );
    }
    return true;
  } catch {
    return false;
  }
}

export interface PausePromptInfo {
  agentId: string;
  agentName: string;
  /** What was reached, in words (lib/budget-pause.ts pauseReached). */
  reached: string;
  percent: number;
  dashboardUrl: string;
}

/** The pause notice on Telegram, with its one button. Plain text: the agent's name is the owner's, but no @ survives. */
export function formatPausePrompt(
  info: Omit<PausePromptInfo, "agentId"> & { id: string },
  chatId: string
): { chat_id: string; text: string; disable_web_page_preview: true; reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } } {
  const name = `"${info.agentName.replaceAll("@", "")}"`;
  const text = [
    `PassControl paused ${name}: ${info.reached}, past its ${info.percent}% pause line. The limit itself still applies.`,
    "Let it go on for an hour here, or from its page:",
    info.dashboardUrl,
  ].join("\n");
  return {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [[{ text: "Let it go on for an hour", callback_data: `ppl:${info.id}` }]] },
  };
}

/**
 * The pause notice with its button, for a workspace whose alerts go to Telegram.
 * False everywhere else, so the caller sends the ordinary alert. Never throws.
 */
export async function sendPausePrompt(userId: string, info: PausePromptInfo): Promise<boolean> {
  try {
    const read = await readDestination(userId);
    if (!read || read.destination.kind !== "telegram") return false;
    const target = telegramTarget(read.destination);
    if (!target) return false;
    const id = newPausePromptId();
    const prompt = formatPausePrompt({ ...info, id }, target.chatId);
    const res = await post(target.endpoint, prompt);
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { result?: { message_id?: unknown; chat?: { id?: unknown } } } | null;
    const message = body?.result?.message_id;
    const chat = body?.result?.chat?.id;
    // Unbound, the button would only ever answer "expired": the page still lifts.
    if ((typeof message === "number" || typeof message === "string") && (typeof chat === "number" || typeof chat === "string")) {
      await recordPausePrompt(id, { uid: userId, agid: info.agentId, chat: String(chat), msg: String(message), hash: await approvalTextHash(prompt.text) });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * After a dashboard decision: take the buttons off the Telegram message, so a
 * later tap is not offered for a question already answered. Never throws.
 */
export async function closeTelegramPrompt(
  userId: string,
  telegram: { chat: string; message: string },
  decision: "approved" | "denied"
): Promise<void> {
  try {
    const read = await readDestination(userId);
    if (!read) return;
    const base = telegramBotBase(read.destination);
    if (!base) return;
    await post(`${base}/editMessageReplyMarkup`, {
      chat_id: telegram.chat,
      message_id: Number(telegram.message),
      reply_markup: { inline_keyboard: [] },
    });
    await post(`${base}/sendMessage`, {
      chat_id: telegram.chat,
      reply_to_message_id: Number(telegram.message),
      text: decision === "approved" ? "Approved in the dashboard." : "Denied in the dashboard.",
    });
  } catch {
    // The decision stands either way; the buttons would answer "already answered".
  }
}
