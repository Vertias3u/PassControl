// Send a workspace's own alert to its Slack, Discord or Telegram (plans/workspace-alerts.md).
//
// Called from the gateway's `logBlocked`, inside waitUntil AFTER the refusal
// was decided and answered, and from two server actions. So it must be cheap
// for the call that sends nothing, and it must never throw. The order of work
// is the cost model, cheapest first:
//   1. the status filter (alertForGatewayStatus), before this is even called;
//   2. one Redis SET NX per user, type and agent: at most one alert per 10 min;
//   3. only then the settings row, the Vault read, the agent's name, the send.
import type { HeadsUpAlert } from "@/lib/budget-headsup";
import { serviceClient } from "@/lib/supabase";
import { claimAlertSlot } from "@/lib/state/redis";
import { sendHeadsUpPrompt, sendPausePrompt } from "@/lib/alerts/approvals";
import {
  formatWorkspaceAlert,
  parseAlertDestination,
  telegramTarget,
  type WorkspaceAlert,
  type WorkspaceAlertType,
} from "@/lib/alerts/destination";

export type AlertKind = "refused" | "budget" | "security";

const GATEWAY_ALERTS: Partial<Record<string, "refused" | "budget">> = {
  blocked_scope: "refused",
  blocked_endpoint: "refused",
  blocked_policy: "refused",
  blocked_budget: "budget",
  blocked_budget_period: "budget",
  blocked_budget_pause: "budget",
  blocked_budget_subagent: "budget",
  blocked_budget_delegation: "budget",
};

/**
 * The gateway statuses that alert. Deliberately absent:
 * `blocked_budget_state` (a Redis fault, not an empty budget),
 * `blocked_suspended` / `blocked_killed` (the owner stopped it; a retrying
 * agent would only spam), and every unpriced/upstream status.
 */
export function alertForGatewayStatus(status: string): "refused" | "budget" | null {
  return Object.hasOwn(GATEWAY_ALERTS, status) ? (GATEWAY_ALERTS[status] ?? null) : null;
}

const KIND: Record<Exclude<WorkspaceAlertType, "test" | "recap">, AlertKind> = {
  refused: "refused",
  budget: "budget",
  passport_rotated: "security",
  break_glass: "security",
  // A spend notice, so it rides the workspace's "budget" switch.
  session_spend: "budget",
};

const SEND_TIMEOUT_MS = 3000;

/** POST one formatted alert. Exported for the "Send test alert" action. */
export async function postWorkspaceAlert(url: string, alert: WorkspaceAlert): Promise<boolean> {
  // Checked again at send time, not only at save: the stored value is
  // trusted no further than the parser that would have refused it.
  const destination = parseAlertDestination(url);
  if (!destination) return false;
  let endpoint = destination.url;
  let body: object;
  if (destination.kind === "telegram") {
    // The chat travels in the body; the address is the bare sendMessage URL.
    const target = telegramTarget(destination);
    if (!target) return false;
    endpoint = target.endpoint;
    body = formatWorkspaceAlert("telegram", alert, target.chatId);
  } else {
    body = destination.kind === "slack" ? formatWorkspaceAlert("slack", alert) : formatWorkspaceAlert("discord", alert);
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // None of the three services redirects; a 3xx is refused, not followed.
      redirect: "manual",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function agentDashboardUrl(origin: string, agentId: string): string {
  return `${origin.replace(/\/+$/u, "")}/dashboard/agents/${encodeURIComponent(agentId)}`;
}

export async function notifyWorkspace(input: {
  userId: string;
  agentId: string;
  // Workspace recaps use alerts/recap's weekly claim, not this agent throttle.
  type: Exclude<WorkspaceAlertType, "test" | "recap">;
  status?: string;
  model?: string;
  /** session_spend: which session, its total and the threshold it passed. */
  session?: string;
  spentMicrocents?: number;
  thresholdMicrocents?: number;
  /** This deployment's own origin, e.g. new URL(req.url).origin. */
  origin: string;
  /** blocked_budget_pause: on Telegram the alert carries a "Let it go on" button (1.6.0, L4b). */
  pause?: { reached: string; percent: number };
  /** budget_headsup (1.6.0, L8): what is reached when. */
  headsUp?: HeadsUpAlert;
}): Promise<void> {
  try {
    // A session alert is throttled per SESSION, so two sessions crossing within
    // ten minutes both arrive. Every other type keeps one slot per agent.
    // The heads-up has its own slot: its period key is spent before the send, so a
    // budget alert ten minutes earlier must not swallow the period's only one.
    const slot =
      input.type === "session_spend" && input.session
        ? `session_spend:${input.session}`
        : input.status === "budget_headsup"
          ? "budget_headsup"
          : input.type;
    if (!(await claimAlertSlot(input.userId, slot, input.agentId))) return;

    const db = serviceClient();
    // Missing table (before 0078) or no row: no alerts, never an error.
    const { data: settings, error } = await db
      .from("workspace_alerts")
      .select("destination,events")
      .eq("user_id", input.userId)
      .maybeSingle();
    if (error || !settings) return;
    const events = Array.isArray(settings.events) ? settings.events : [];
    if (!events.includes(KIND[input.type])) return;

    const { data: url } = await db.rpc("get_workspace_alert_url_for_user", { p_user_id: input.userId });
    if (typeof url !== "string") return;
    if (parseAlertDestination(url)?.kind !== settings.destination) return;

    const { data: agent } = await db
      .from("agents")
      .select("name")
      .eq("id", input.agentId)
      .eq("user_id", input.userId) // tenant boundary: service_role bypasses RLS
      .maybeSingle();

    if (
      input.status === "blocked_budget_pause" &&
      input.pause &&
      settings.destination === "telegram" &&
      (await sendPausePrompt(input.userId, {
        agentId: input.agentId,
        agentName: typeof agent?.name === "string" ? agent.name : "an agent",
        reached: input.pause.reached,
        percent: input.pause.percent,
        dashboardUrl: agentDashboardUrl(input.origin, input.agentId) + "#agent-pause",
      }))
    ) {
      return;
    }
    const alert = {
      type: input.type,
      agentName: typeof agent?.name === "string" ? agent.name : "an agent",
      status: input.status,
      model: input.model,
      at: new Date(),
      dashboardUrl:
        agentDashboardUrl(input.origin, input.agentId) + (input.type === "session_spend" ? "#agent-sessions" : ""),
      ...(input.type === "session_spend"
        ? { session: input.session, spentMicrocents: input.spentMicrocents, thresholdMicrocents: input.thresholdMicrocents }
        : {}),
      ...(input.headsUp ? { headsUp: input.headsUp } : {}),
    };
    // The heads-up on Telegram carries "Suspend it now" (L8b); anywhere else, or if
    // that send fails, the ordinary alert.
    if (
      input.status === "budget_headsup" &&
      settings.destination === "telegram" &&
      (await sendHeadsUpPrompt(input.userId, { agentId: input.agentId, alert }))
    ) {
      return;
    }
    await postWorkspaceAlert(url, alert);
  } catch {
    // Best-effort by contract: the audit row is the durable record.
  }
}
