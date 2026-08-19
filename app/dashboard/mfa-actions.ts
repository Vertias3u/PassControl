"use server";
// MFA (TOTP) management for the Control Tower (see MFA_SCOPING.md). Enrollment +
// recovery codes only — the login step-up / AAL2 gate is a separate (careful) pass.
// Actions run as the authenticated user, EXCEPT the recovery-code writes: 0029
// revokes insert/update/delete on `mfa_recovery_codes` from `authenticated`, so
// those go through the service role with an explicit `user_id` filter. Redeeming
// a code unenrolls the TOTP factor by design, which means a client that could
// write that table could plant a code, redeem it, and walk through the strict
// credential gate with nothing left to step up to. Codes are still hashed.
import { redirect } from "next/navigation";
import { userClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { generateRecoveryCodes, consumeRecoveryCode } from "@/lib/recoveryCodes";
import { recordAdminAction } from "@/lib/audit";
import { logSecurityEvent } from "@/lib/seclog";
import { dispatchSecurityAlert } from "@/lib/alert";

async function requireUser() {
  const supabase = await userClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("not_authenticated");
  return { supabase, user };
}

/** Why this session may not change factor state, or null if it may.
 *
 *  Guards every action that can ADD or REMOVE a second factor, or mint the
 *  recovery codes that redeem into removing one. All of them were reachable from
 *  an aal1 session with nothing but `requireUser()`, and each is a complete MFA
 *  bypass on its own — not by forging the factor, but by DELETING it:
 *
 *    enrollMfa + verifyMfaEnrollment — enrol hands the caller a brand-new
 *      factor's SECRET, so "the caller passed challengeAndVerify" proves only
 *      that they hold a factor they just minted, never the victim's. Verifying
 *      it then wipes the real recovery codes and returns ten fresh ones.
 *    regenerateRecoveryCodes — returns ten valid codes to the caller outright.
 *    unenrollMfa — drops the factor in a single call.
 *
 *  Any of those leaves `verified.length === 0`, at which point `mfaAuthorizedUser`
 *  passes every session, correctly, because no step-up remains. So the credential
 *  gate falls without 0029's table ever being written to.
 *
 *  The semantics come out right for free: an account with NO verified factor
 *  passes, so first-time enrolment is untouched; once a factor IS verified,
 *  adding or removing one needs aal2.
 *
 *  Deliberately NOT applied to `submitLoginMfa` — that is the emergency path and
 *  must work at aal1 by definition. Returns a message rather than throwing,
 *  because every caller here is typed `… | { error: string }` and the Security
 *  panel branches on `"error" in result`; a throw would skip that and surface an
 *  unhandled Server Action error instead. */
async function mfaBlockedReason(
  supabase: Awaited<ReturnType<typeof userClient>>
): Promise<string | null> {
  const gate = await mfaAuthorizedUser(supabase);
  if (gate.ok) return null;
  return gate.reason === "step_up_required"
    ? "Complete two-factor verification before changing your MFA settings."
    : "Your authentication assurance could not be verified. Try again.";
}

export interface MfaStatus {
  enrolled: boolean;
  recoveryRemaining: number;
}

/** Current MFA state for the dashboard Security panel. */
export async function getMfaStatus(): Promise<MfaStatus> {
  const supabase = await userClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { enrolled: false, recoveryRemaining: 0 };
  const { data: factors } = await supabase.auth.mfa.listFactors();
  const enrolled = (factors?.totp ?? []).length > 0;
  const { count } = await supabase
    .from("mfa_recovery_codes")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .is("used_at", null);
  return { enrolled, recoveryRemaining: count ?? 0 };
}

/** Begin TOTP enrollment → returns the QR + secret to show the user. Clears any
 *  stale unverified factor first so re-enrolling doesn't collide. */
export async function enrollMfa(): Promise<
  { factorId: string; qr: string; secret: string } | { error: string }
> {
  const { supabase } = await requireUser();
  const blocked = await mfaBlockedReason(supabase);
  if (blocked) return { error: blocked };
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const f of factors?.all ?? []) {
    if (f.factor_type === "totp" && f.status === "unverified") {
      await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
  }
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `totp-${Date.now()}`,
  });
  if (error || !data) return { error: "Could not start MFA enrollment. Please try again." };
  return { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret };
}

/** Verify the 6-digit code, activating the factor, then mint + store recovery
 *  codes (returned ONCE). */
export async function verifyMfaEnrollment(
  factorId: string,
  code: string
): Promise<{ recoveryCodes: string[] } | { error: string }> {
  const { supabase, user } = await requireUser();
  const blocked = await mfaBlockedReason(supabase);
  if (blocked) return { error: blocked };
  const clean = String(code).replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return { error: "Enter the 6-digit code from your authenticator app." };

  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: clean });
  if (error) return { error: "That code didn't match. Check your app's clock and try again." };

  // Note challengeAndVerify is NOT the gate: it proves possession of whichever
  // factor this call is verifying, which the caller may have just enrolled. The
  // gate is mfaBlockedReason above.
  const codes = await generateRecoveryCodes();
  const admin = serviceClient();
  await admin.from("mfa_recovery_codes").delete().eq("user_id", user.id);
  await admin.from("mfa_recovery_codes").insert(codes.map((c) => ({ user_id: user.id, code_hash: c.hash })));

  logSecurityEvent("auth.mfa.enrolled", { user: user.id });
  await recordAdminAction({ userId: user.id, action: "mfa.enroll", metadata: {} });
  return { recoveryCodes: codes.map((c) => c.code) };
}

/** Replace the recovery codes (e.g. after using some). Returns the new set once. */
export async function regenerateRecoveryCodes(): Promise<{ recoveryCodes: string[] } | { error: string }> {
  const { supabase, user } = await requireUser();
  // This MINTS ten codes and hands them back, and any one of them redeems into a
  // factory reset of the second factor. Locking the table (0029) does nothing
  // about an attacker who simply asks for a valid code instead of planting one.
  const blocked = await mfaBlockedReason(supabase);
  if (blocked) return { error: blocked };
  const codes = await generateRecoveryCodes();
  const admin = serviceClient();
  await admin.from("mfa_recovery_codes").delete().eq("user_id", user.id);
  const { error } = await admin
    .from("mfa_recovery_codes")
    .insert(codes.map((c) => ({ user_id: user.id, code_hash: c.hash })));
  if (error) return { error: "Could not regenerate recovery codes." };
  return { recoveryCodes: codes.map((c) => c.code) };
}

type LoginMfaState = { error?: string } | undefined;

/** Login step-up: verify a 6-digit TOTP code (→ aal2 → dashboard), or accept a
 *  recovery code as an emergency reset (consume one → unenroll the factor → in at
 *  aal1, re-enroll prompted). Used by the /login/verify form. */
export async function submitLoginMfa(_prev: LoginMfaState, formData: FormData): Promise<LoginMfaState> {
  const { supabase, user } = await requireUser();
  const raw = String(formData.get("code") ?? "").trim();
  const totp = raw.replace(/\s/g, "");

  if (/^\d{6}$/.test(totp)) {
    const { data: factors } = await supabase.auth.mfa.listFactors();
    const factor = factors?.totp?.[0];
    if (!factor) return { error: "No authenticator is enrolled on this account." };
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: totp });
    if (error) {
      logSecurityEvent("auth.mfa.failed", { user: user.id });
      await dispatchSecurityAlert("auth.mfa.failed", { user: user.id });
      return { error: "That code didn't match. Check your app's clock and try again." };
    }
    logSecurityEvent("auth.mfa.verified", { user: user.id });
    redirect("/dashboard");
  }

  // Otherwise treat it as a recovery code → emergency MFA reset.
  // Service role, but still scoped by the verified `user.id` in code — the
  // tenant boundary moves from RLS to this argument, exactly as CLAUDE.md
  // requires of every service-role call. No MFA gate: this is the emergency
  // path and must work at aal1. After 0029 the only codes that can match here
  // are ones the server issued.
  const ok = await consumeRecoveryCode(serviceClient(), user.id, raw);
  if (!ok) {
    logSecurityEvent("auth.mfa.failed", { user: user.id, recovery: true });
    await dispatchSecurityAlert("auth.mfa.failed", { user: user.id });
    return { error: "Invalid or already-used recovery code." };
  }
  // Recovery codes can't elevate Supabase's assurance level, so this is a reset:
  // remove the factor + remaining codes; the (aal1) session is then allowed in.
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const f of factors?.totp ?? []) await supabase.auth.mfa.unenroll({ factorId: f.id });
  await serviceClient().from("mfa_recovery_codes").delete().eq("user_id", user.id);
  logSecurityEvent("auth.mfa.recovery_used", { user: user.id });
  await recordAdminAction({ userId: user.id, action: "mfa.disable", metadata: { via: "recovery" } });
  redirect("/dashboard");
}

/** Disable MFA: unenroll every TOTP factor and clear recovery codes. */
export async function unenrollMfa(): Promise<{ ok: true } | { error: string }> {
  const { supabase, user } = await requireUser();
  // Turning MFA off is not authority reduction — it removes the control that
  // every credential mint depends on, and it was reachable from an aal1 session
  // in a single call with no planted row at all. A Server Action is addressable
  // by id, so "the dashboard redirects aal1 users to /login/verify" was never a
  // gate. Someone who cannot step up still has the recovery-code path.
  const blocked = await mfaBlockedReason(supabase);
  if (blocked) return { error: blocked };
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const f of factors?.totp ?? []) {
    await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
  await serviceClient().from("mfa_recovery_codes").delete().eq("user_id", user.id);
  logSecurityEvent("auth.mfa.disabled", { user: user.id });
  await recordAdminAction({ userId: user.id, action: "mfa.disable", metadata: {} });
  return { ok: true };
}
