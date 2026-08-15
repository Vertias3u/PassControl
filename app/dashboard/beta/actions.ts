"use server";

import { revalidatePath } from "next/cache";
import { betaOperatorGate } from "@/lib/beta-operator";
import { betaInviteEmail, sendBetaEmail } from "@/lib/beta-email";
import { betaInviteUrl, issueBetaInviteToken } from "@/lib/beta-launch";
import { deliverBetaFollowup } from "@/lib/beta-followup";
import { serviceClient } from "@/lib/supabase";

export type BetaOperatorActionState = { ok: boolean; message: string } | undefined;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function operatorContext() {
  const gate = await betaOperatorGate();
  if (!gate.ok) throw new Error(gate.reason === "mfa_required" ? "MFA is required." : "Not authorized.");
  const email = gate.user.email?.trim().toLowerCase();
  if (!email) throw new Error("The operator account has no verified email.");
  const admin = serviceClient();
  const { error } = await admin.from("users").upsert({
    id: gate.user.id,
    email,
  }, { onConflict: "id" });
  if (error) throw new Error("Could not establish operator audit identity.");
  return { actorId: gate.user.id, admin };
}

function applicationId(formData: FormData): string {
  const id = String(formData.get("application_id") ?? "");
  if (!UUID_RE.test(id)) throw new Error("Invalid application.");
  return id;
}

async function application(admin: ReturnType<typeof serviceClient>, id: string) {
  const { data, error } = await admin
    .from("beta_applications")
    .select("id,email_normalized,status,user_id")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) throw new Error("Application not found.");
  return data;
}

export async function sendBetaInvite(
  _previous: BetaOperatorActionState,
  formData: FormData
): Promise<BetaOperatorActionState> {
  try {
    const id = applicationId(formData);
    const { admin, actorId } = await operatorContext();
    const app = await application(admin, id);
    if (!['applied', 'invited'].includes(app.status) || app.user_id) {
      return { ok: false, message: "This application cannot receive a new invitation." };
    }

    const token = issueBetaInviteToken();
    const content = betaInviteEmail(betaInviteUrl(token.raw));
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
    const { data: prepared, error: prepareError } = await admin.rpc("prepare_beta_invite", {
      p_application_id: id,
      p_token_hash: token.hash,
      p_expires_at: expiresAt,
    });
    const invite = Array.isArray(prepared) ? prepared[0] : null;
    if (prepareError || !invite?.invite_id) throw new Error("Could not create invitation.");

    const sent = await sendBetaEmail({
      to: app.email_normalized,
      ...content,
      idempotencyKey: `beta-invite/${invite.invite_id}`,
    });
    if (!sent.ok) {
      await admin.rpc("fail_beta_invite", {
        p_invite_id: invite.invite_id,
        p_actor_user_id: actorId,
      });
      return { ok: false, message: "Email delivery failed. The invitation remains inactive; retry to issue a new one." };
    }
    const { data: activated, error: activateError } = await admin.rpc("activate_beta_invite", {
      p_invite_id: invite.invite_id,
      p_actor_user_id: actorId,
    });
    if (activateError || activated !== true) {
      await admin.rpc("fail_beta_invite", {
        p_invite_id: invite.invite_id,
        p_actor_user_id: actorId,
      });
      return { ok: false, message: "The email was accepted, but its link remained inactive. Retry with a new invitation." };
    }
    revalidatePath("/dashboard/beta");
    return { ok: true, message: "Invitation sent. The one-time link expires in 7 days." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Invitation failed." };
  }
}

export async function declineBetaApplication(
  _previous: BetaOperatorActionState,
  formData: FormData
): Promise<BetaOperatorActionState> {
  try {
    if (String(formData.get("confirmation") ?? "").trim() !== "DECLINE") {
      return { ok: false, message: "Type DECLINE to confirm." };
    }
    const id = applicationId(formData);
    const { admin, actorId } = await operatorContext();
    const { data: declined, error } = await admin.rpc("decline_beta_application", {
      p_application_id: id,
      p_actor_user_id: actorId,
    });
    if (error) throw new Error("Could not decline application.");
    if (declined !== true) return { ok: false, message: "This application changed state and was not declined." };
    revalidatePath("/dashboard/beta");
    return { ok: true, message: "Application declined. Its application data is scheduled for deletion in 30 days." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Decline failed." };
  }
}

export async function withdrawBetaApplication(
  _previous: BetaOperatorActionState,
  formData: FormData
): Promise<BetaOperatorActionState> {
  try {
    if (String(formData.get("confirmation") ?? "").trim() !== "WITHDRAW") {
      return { ok: false, message: "Type WITHDRAW to confirm the applicant's request." };
    }
    const id = applicationId(formData);
    const { admin, actorId } = await operatorContext();
    const { data: withdrawn, error } = await admin.rpc("withdraw_beta_application", {
      p_application_id: id,
      p_actor_user_id: actorId,
    });
    if (error) throw new Error("Could not withdraw application.");
    if (withdrawn !== true) return { ok: false, message: "This application changed state and was not withdrawn." };
    revalidatePath("/dashboard/beta");
    return { ok: true, message: "Application withdrawn. Its application data is scheduled for deletion in 30 days." };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Withdrawal failed." };
  }
}

async function sendFollowup(
  kind: "nudge" | "feedback_request",
  formData: FormData
): Promise<BetaOperatorActionState> {
  const id = applicationId(formData);
  const { admin, actorId } = await operatorContext();
  const app = await application(admin, id);
  if (!app.user_id || app.status !== "accepted") return { ok: false, message: "The workspace has not completed signup." };
  const [calls, successes] = await Promise.all([
    admin.from("agent_logs").select("id", { count: "exact", head: true }).eq("user_id", app.user_id),
    admin.from("agent_logs").select("id", { count: "exact", head: true }).eq("user_id", app.user_id).eq("status", "ok"),
  ]);
  if (calls.error || successes.error) throw new Error("Could not verify the workspace's call history.");
  const callCount = calls.count;
  const successCount = successes.count;
  if (kind === "nudge" && (callCount ?? 0) > 0) return { ok: false, message: "This workspace has already attempted a call." };
  if (kind === "feedback_request" && (successCount ?? 0) === 0) return { ok: false, message: "Feedback is requested only after a successful stored call." };

  const result = await deliverBetaFollowup({
    kind,
    issuer: process.env.PASSCONTROL_ISSUER,
    to: app.email_normalized,
    applicationId: id,
    reserve: async (action) => {
      const { data, error } = await admin.from("beta_operator_events").insert({
        actor_user_id: actorId,
        application_id: id,
        invite_id: null,
        action,
      }).select("id").maybeSingle();
      return { id: data?.id ?? null, error };
    },
    transition: async (eventId, action) => {
      const { data, error } = await admin.from("beta_operator_events")
        .update({ action })
        .eq("id", eventId)
        .eq("actor_user_id", actorId)
        .eq("application_id", id)
        .eq("action", `${kind}.pending`)
        .select("id")
        .maybeSingle();
      return { error: error ?? (data?.id ? null : new Error("follow-up state did not transition")) };
    },
    send: sendBetaEmail,
  });

  if (result.code === "sent") {
    revalidatePath("/dashboard/beta");
    return { ok: true, message: kind === "nudge" ? "One setup nudge sent." : "One feedback request sent." };
  }
  if (result.code === "origin_unavailable") return { ok: false, message: "Email origin is not configured." };
  if (result.code === "already_reserved") return { ok: false, message: "This follow-up was already sent or is still being reconciled." };
  if (result.code === "reservation_failed") return { ok: false, message: "Could not reserve follow-up." };
  if (result.code === "delivery_failed") return { ok: false, message: "Email delivery failed. It can be retried." };
  if (result.code === "delivery_state_unresolved") {
    return { ok: false, message: "Email delivery failed, but its state could not be settled. Do not retry until the operator event is inspected." };
  }
  return { ok: false, message: "The email provider accepted the message, but its sent state could not be recorded. Do not retry until the operator event is inspected." };
}

export async function sendBetaNudge(_previous: BetaOperatorActionState, formData: FormData) {
  try { return await sendFollowup("nudge", formData); }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Nudge failed." }; }
}

export async function sendBetaFeedbackRequest(_previous: BetaOperatorActionState, formData: FormData) {
  try { return await sendFollowup("feedback_request", formData); }
  catch (error) { return { ok: false, message: error instanceof Error ? error.message : "Feedback request failed." }; }
}
