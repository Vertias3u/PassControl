// Send a workspace's own alert to its Slack, Discord or Telegram (plans/workspace-alerts.md).
//
// Called from the gateway's `logBlocked`, inside waitUntil AFTER the refusal
// was decided and answered, and from two server actions. So it must be cheap
// for the call that sends nothing, and it must never throw. The order of work
// is the cost model, cheapest first:
//   1. the status filter (alertForGatewayStatus), before this is even called;
//   2. one Redis SET NX per user, type and agent: at most one alert per 10 min;
//   3. only then the settings row, the Vault read, the agent's name, the send.
import { serviceClient } from "@/lib/supabase";
import { claimAlertSlot } from "@/lib/state/redis";
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

const KIND: Record<Exclude<WorkspaceAlertType, "test">, AlertKind> = {
  refused: "refused",
  budget: "budget",
  passport_rotated: "security",
  break_glass: "security",
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
  type: Exclude<WorkspaceAlertType, "test">;
  status?: string;
  model?: string;
  /** This deployment's own origin, e.g. new URL(req.url).origin. */
  origin: string;
}): Promise<void> {
  try {
    if (!(await claimAlertSlot(input.userId, input.type, input.agentId))) return;

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

    await postWorkspaceAlert(url, {
      type: input.type,
      agentName: typeof agent?.name === "string" ? agent.name : "an agent",
      status: input.status,
      model: input.model,
      at: new Date(),
      dashboardUrl: agentDashboardUrl(input.origin, input.agentId),
    });
  } catch {
    // Best-effort by contract: the audit row is the durable record.
  }
}
