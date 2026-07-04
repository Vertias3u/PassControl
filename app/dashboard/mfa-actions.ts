"use server";
// MFA (TOTP) management for the Control Tower (see MFA_SCOPING.md). Enrollment +
// recovery codes only — the login step-up / AAL2 gate is a separate (careful) pass.
// All actions run as the authenticated user (RLS-scoped); recovery codes are
// generated here and stored hashed.
import { redirect } from "next/navigation";
import { userClient } from "@/lib/supabase/server";
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
  const clean = String(code).replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return { error: "Enter the 6-digit code from your authenticator app." };

  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: clean });
  if (error) return { error: "That code didn't match. Check your app's clock and try again." };

  const codes = await generateRecoveryCodes();
  await supabase.from("mfa_recovery_codes").delete().eq("user_id", user.id);
  await supabase.from("mfa_recovery_codes").insert(codes.map((c) => ({ user_id: user.id, code_hash: c.hash })));

  logSecurityEvent("auth.mfa.enrolled", { user: user.id });
  await recordAdminAction({ userId: user.id, action: "mfa.enroll", metadata: {} });
  return { recoveryCodes: codes.map((c) => c.code) };
}

/** Replace the recovery codes (e.g. after using some). Returns the new set once. */
export async function regenerateRecoveryCodes(): Promise<{ recoveryCodes: string[] } | { error: string }> {
  const { supabase, user } = await requireUser();
  const codes = await generateRecoveryCodes();
  await supabase.from("mfa_recovery_codes").delete().eq("user_id", user.id);
  const { error } = await supabase
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
  const ok = await consumeRecoveryCode(supabase, user.id, raw);
  if (!ok) {
    logSecurityEvent("auth.mfa.failed", { user: user.id, recovery: true });
    await dispatchSecurityAlert("auth.mfa.failed", { user: user.id });
    return { error: "Invalid or already-used recovery code." };
  }
  // Recovery codes can't elevate Supabase's assurance level, so this is a reset:
  // remove the factor + remaining codes; the (aal1) session is then allowed in.
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const f of factors?.totp ?? []) await supabase.auth.mfa.unenroll({ factorId: f.id });
  await supabase.from("mfa_recovery_codes").delete().eq("user_id", user.id);
  logSecurityEvent("auth.mfa.recovery_used", { user: user.id });
  await recordAdminAction({ userId: user.id, action: "mfa.disable", metadata: { via: "recovery" } });
  redirect("/dashboard");
}

/** Disable MFA: unenroll every TOTP factor and clear recovery codes. */
export async function unenrollMfa(): Promise<{ ok: true } | { error: string }> {
  const { supabase, user } = await requireUser();
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const f of factors?.totp ?? []) {
    await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
  await supabase.from("mfa_recovery_codes").delete().eq("user_id", user.id);
  logSecurityEvent("auth.mfa.disabled", { user: user.id });
  await recordAdminAction({ userId: user.id, action: "mfa.disable", metadata: {} });
  return { ok: true };
}
