"use server";
// Workspace alerts: where a workspace's Slack, Discord or Telegram alerts go and which
// kinds it wants (plans/workspace-alerts.md, migration 0078).
//
// Gated like a credential. The webhook URL (or Telegram bot token) can post into the tenant's channel,
// and silencing alerts (removing them, pointing them elsewhere, switching kinds
// off) is exactly what a stolen aal1 session would do first. `userId` always
// comes from the MFA-verified session, never from an argument: these writes use
// the service role, so this is the tenant boundary.
//
// The URL is stored only through `set_workspace_alert_destination_for_user`
// (Vault) and is never returned, logged or put in the audit row; the hint is.
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import { recordAdminAction } from "@/lib/audit";
import { parseAlertDestination, parseTelegramDestination, type AlertDestination } from "@/lib/alerts/destination";
import { originFromHeaders } from "@/lib/alerts/origin";
import { postWorkspaceAlert, type AlertKind } from "@/lib/alerts/workspace";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { ensureProfileRow } from "@/lib/profile/manage";
import { rateLimit } from "@/lib/ratelimit";
import { serviceClient } from "@/lib/supabase";
import { userClient } from "@/lib/supabase/server";

export interface AlertActionState {
  error?: string;
  message?: string;
}

const KINDS: readonly AlertKind[] = ["refused", "budget", "security"];
const TEST_LIMIT = 5;
const TEST_WINDOW_S = 600;

const UNMIGRATED = "This instance has not applied migration 0078, so alerts cannot be saved yet.";
const FAILED = "The alert settings could not be saved. Try again.";

async function gatedUser(): Promise<{ id: string; email?: string | null } | { error: string }> {
  const gate = await mfaAuthorizedUser(await userClient());
  if (!gate.ok) {
    return {
      error:
        gate.reason === "step_up_required"
          ? "Complete two-factor verification to change where alerts go."
          : gate.reason === "unauthenticated"
            ? "Sign in again to change this."
            : "Your authentication assurance could not be verified. Try again.",
    };
  }
  return gate.user;
}

/** A missing function or table means 0078 is not applied on this instance. */
function unmigrated(error: { code?: string } | null): boolean {
  return error?.code === "PGRST202" || error?.code === "PGRST205" || error?.code === "42P01" || error?.code === "42883";
}

function cleanKinds(events: unknown): AlertKind[] {
  const wanted = new Set(Array.isArray(events) ? events.map(String) : []);
  return KINDS.filter((kind) => wanted.has(kind));
}

export async function saveAlertSettings(input: {
  url: string;
  /** Telegram is two fields, not a URL; either one being filled selects it. */
  telegramToken?: string;
  telegramChatId?: string;
  events: string[];
}): Promise<AlertActionState> {
  const user = await gatedUser();
  if ("error" in user) return { error: user.error };
  const events = cleanKinds(input?.events);
  const raw = String(input?.url ?? "").trim();
  const telegramToken = String(input?.telegramToken ?? "").trim();
  const telegramChatId = String(input?.telegramChatId ?? "").trim();
  const db = serviceClient();

  let to: string;
  let hint: string;
  if (raw || telegramToken || telegramChatId) {
    let destination: AlertDestination | null;
    if (telegramToken || telegramChatId) {
      destination = parseTelegramDestination(telegramToken, telegramChatId);
      if (!destination) {
        return {
          error:
            "Telegram needs a bot token and a chat ID: a token like 123456789:AA… from @BotFather, and a numeric chat ID (or @channelname).",
        };
      }
    } else {
      destination = parseAlertDestination(raw);
      if (!destination || destination.kind === "telegram") {
        return {
          error:
            "Use a Slack or Discord incoming webhook URL: https://hooks.slack.com/services/… or https://discord.com/api/webhooks/…",
        };
      }
    }
    try {
      await ensureProfileRow(db, user as never);
    } catch {
      return { error: FAILED };
    }
    const { error } = await db.rpc("set_workspace_alert_destination_for_user", {
      p_user_id: user.id,
      p_destination: destination.kind,
      p_hint: destination.hint,
      p_url: destination.url,
    });
    if (error) return { error: unmigrated(error) ? UNMIGRATED : FAILED };
    to = destination.kind;
    hint = destination.hint;
  } else {
    const { data: row, error } = await db
      .from("workspace_alerts")
      .select("destination,hint")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) return { error: unmigrated(error) ? UNMIGRATED : FAILED };
    if (!row) return { error: "Paste a Slack or Discord webhook URL, or a Telegram bot token and chat ID, to turn alerts on." };
    to = String(row.destination);
    hint = String(row.hint);
  }

  const { error: eventsError } = await db
    .from("workspace_alerts")
    .update({ events, updated_at: new Date().toISOString() })
    .eq("user_id", user.id); // tenant boundary: service_role bypasses RLS
  if (eventsError) return { error: FAILED };

  await recordAdminAction({
    userId: user.id,
    action: "workspace.alerts",
    metadata: { to, hint, events },
  });
  revalidatePath("/dashboard/settings");
  return { message: events.length ? "Alerts saved." : "Saved. Every kind is off, so nothing will be sent." };
}

export async function removeAlertDestination(): Promise<AlertActionState> {
  const user = await gatedUser();
  if ("error" in user) return { error: user.error };
  const { error } = await serviceClient().rpc("delete_workspace_alert_destination_for_user", {
    p_user_id: user.id,
  });
  if (error) return { error: unmigrated(error) ? UNMIGRATED : FAILED };
  await recordAdminAction({ userId: user.id, action: "workspace.alerts", metadata: { to: "none" } });
  revalidatePath("/dashboard/settings");
  return { message: "Alerts removed." };
}

export async function sendTestAlert(): Promise<AlertActionState> {
  const user = await gatedUser();
  if ("error" in user) return { error: user.error };
  const limited = await rateLimit(`alert-test:${user.id}`, TEST_LIMIT, TEST_WINDOW_S);
  if (!limited.success) return { error: "Too many test alerts. Try again in a few minutes." };

  const { data: url, error } = await serviceClient().rpc("get_workspace_alert_url_for_user", {
    p_user_id: user.id,
  });
  if (error) return { error: unmigrated(error) ? UNMIGRATED : FAILED };
  if (typeof url !== "string") return { error: "No alert destination is saved yet." };

  const origin = originFromHeaders(await headers()) ?? "";
  const sent = await postWorkspaceAlert(url, {
    type: "test",
    agentName: "",
    at: new Date(),
    dashboardUrl: `${origin}/dashboard/settings#alerts`,
  });
  return sent
    ? { message: "Sent. Check your channel." }
    : { error: "The service did not accept the message. Check that the webhook still exists." };
}
