import type { User } from "@supabase/supabase-js";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { betaOperatorEmails } from "@/lib/beta-launch";
import { userClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase";

export type BetaOperatorGate =
  | { ok: true; user: User }
  | { ok: false; reason: "unauthenticated" | "mfa_required" | "forbidden" };

export async function betaOperatorGate(): Promise<BetaOperatorGate> {
  const db = await userClient();
  const gate = await mfaAuthorizedUser(db);
  if (!gate.ok) {
    return {
      ok: false,
      reason: gate.reason === "step_up_required" ? "mfa_required" : "unauthenticated",
    };
  }
  const hasVerifiedTotp = (gate.user.factors ?? []).some(
    (factor) => factor.status === "verified" && factor.factor_type === "totp"
  );
  const email = gate.user.email?.trim().toLowerCase() ?? "";
  if (!hasVerifiedTotp || !betaOperatorEmails().has(email)) {
    return { ok: false, reason: hasVerifiedTotp ? "forbidden" : "mfa_required" };
  }
  return { ok: true, user: gate.user };
}

export interface BetaOperatorRow {
  id: string;
  email: string;
  integration: string;
  provider: string;
  monthlyCallBucket: string;
  useCase: string;
  status: string;
  appliedAt: string;
  inviteExpiresAt: string | null;
  invitedAt: string | null;
  signedUp: boolean;
  providerReady: boolean;
  agentReady: boolean;
  attemptedCall: boolean;
  successfulCall: boolean;
  lastCallAt: string | null;
  feedbackReceived: boolean;
  nudgeSent: boolean;
  nudgePending: boolean;
  feedbackRequestSent: boolean;
  feedbackRequestPending: boolean;
}

type AnyRow = Record<string, unknown>;

export async function loadBetaOperatorRows(): Promise<BetaOperatorRow[]> {
  const admin = serviceClient();
  const { data: applications, error: applicationError } = await admin
    .from("beta_applications")
    .select("id,email_normalized,integration,provider,monthly_call_bucket,use_case,status,user_id,created_at")
    .order("created_at", { ascending: false })
    .limit(250);
  if (applicationError) throw new Error("beta_applications_unavailable");
  const apps = (applications ?? []) as AnyRow[];
  const applicationIds = apps.map((row) => String(row.id));
  const userIds = apps.map((row) => row.user_id).filter((id): id is string => typeof id === "string");

  const empty = Promise.resolve({ data: [], error: null });
  const [inviteResult, providerResult, agentResult, logResult, feedbackResult, eventResult] =
    await Promise.all([
      applicationIds.length
        ? admin.from("beta_invites").select("application_id,expires_at,sent_at,revoked_at,redeemed_at,created_at").in("application_id", applicationIds).order("created_at", { ascending: false }).limit(1_000)
        : empty,
      userIds.length
        ? admin.from("provider_credentials").select("user_id").in("user_id", userIds).limit(1_000)
        : empty,
      userIds.length
        ? admin.from("agents").select("id,user_id").in("user_id", userIds).limit(2_000)
        : empty,
      userIds.length
        ? admin.from("agent_logs").select("user_id,status,created_at").in("user_id", userIds).order("created_at", { ascending: false }).limit(5_000)
        : empty,
      applicationIds.length
        ? admin.from("beta_feedback").select("application_id").in("application_id", applicationIds).limit(250)
        : empty,
      applicationIds.length
        ? admin.from("beta_operator_events").select("application_id,action").in("application_id", applicationIds).limit(2_000)
        : empty,
    ]);
  if ([inviteResult, providerResult, agentResult, logResult, feedbackResult, eventResult].some((result) => result.error)) {
    throw new Error("beta_funnel_unavailable");
  }

  const inviteByApplication = new Map<string, AnyRow>();
  for (const row of (inviteResult.data ?? []) as AnyRow[]) {
    const appId = String(row.application_id);
    if (!inviteByApplication.has(appId)) inviteByApplication.set(appId, row);
  }
  const providerUsers = new Set(((providerResult.data ?? []) as AnyRow[]).map((row) => String(row.user_id)));
  const agentUsers = new Set(((agentResult.data ?? []) as AnyRow[]).map((row) => String(row.user_id)));
  const feedbackApps = new Set(((feedbackResult.data ?? []) as AnyRow[]).map((row) => String(row.application_id)));
  const eventsByApplication = new Map<string, Set<string>>();
  for (const row of (eventResult.data ?? []) as AnyRow[]) {
    const id = String(row.application_id);
    const events = eventsByApplication.get(id) ?? new Set<string>();
    events.add(String(row.action));
    eventsByApplication.set(id, events);
  }
  const callByUser = new Map<string, { attempted: boolean; success: boolean; last: string | null }>();
  for (const row of (logResult.data ?? []) as AnyRow[]) {
    const userId = String(row.user_id);
    const current = callByUser.get(userId) ?? { attempted: false, success: false, last: null };
    current.attempted = true;
    current.success ||= row.status === "ok";
    if (!current.last && typeof row.created_at === "string") current.last = row.created_at;
    callByUser.set(userId, current);
  }

  return apps.map((app) => {
    const id = String(app.id);
    const userId = typeof app.user_id === "string" ? app.user_id : null;
    const invite = inviteByApplication.get(id);
    const calls = userId ? callByUser.get(userId) : undefined;
    const events = eventsByApplication.get(id) ?? new Set<string>();
    return {
      id,
      email: String(app.email_normalized),
      integration: String(app.integration),
      provider: String(app.provider),
      monthlyCallBucket: String(app.monthly_call_bucket),
      useCase: String(app.use_case),
      status: String(app.status),
      appliedAt: String(app.created_at),
      inviteExpiresAt: typeof invite?.expires_at === "string" ? invite.expires_at : null,
      invitedAt: typeof invite?.sent_at === "string" ? invite.sent_at : null,
      signedUp: Boolean(userId),
      providerReady: Boolean(userId && providerUsers.has(userId)),
      agentReady: Boolean(userId && agentUsers.has(userId)),
      attemptedCall: calls?.attempted ?? false,
      successfulCall: calls?.success ?? false,
      lastCallAt: calls?.last ?? null,
      feedbackReceived: feedbackApps.has(id),
      nudgeSent: events.has("nudge.sent"),
      nudgePending: events.has("nudge.pending"),
      feedbackRequestSent: events.has("feedback_request.sent"),
      feedbackRequestPending: events.has("feedback_request.pending"),
    };
  });
}
