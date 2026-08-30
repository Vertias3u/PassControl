"use server";
// Auth server actions (email + password). Ported from the Atlas app and adapted:
// reuses PassControl's userClient(), English copy, invite-gated signup, no OAuth,
// no user-audit hook. Each action returns { error } for the form to display, or
// redirect()s on success.
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { cookies } from "next/headers";
import { userClient } from "@/lib/supabase/server";
import { signupMode, validateSignupAccess } from "@/lib/invite-code";
import { validatePassword } from "@/lib/password";
import { authEmailRedirect } from "@/lib/auth/emailRedirect";
import {
  PASSWORD_RECOVERY_COOKIE,
  verifyPasswordRecoveryTicket,
} from "@/lib/auth/passwordRecovery";
import { rateLimit } from "@/lib/ratelimit";
import { isLockedOut, recordLoginFailure, clearLoginFailures } from "@/lib/auth/lockout";
import { logSecurityEvent, maskEmail } from "@/lib/seclog";
import { dispatchSecurityAlert } from "@/lib/alert";
import { needsMfaStepUp } from "@/lib/mfa";

type FormState = { error?: string; success?: string } | undefined;

// Throttle thresholds. Strict enough to stop automated guessing, loose enough
// that a real user mistyping a few times is unaffected.
const LOGIN_IP_LIMIT = 30; // bursts of attempts from one network per window
const LOGIN_EMAIL_LIMIT = 8; // attempts against a single account per window
const LOGIN_WINDOW_S = 300; // 5-minute fixed window
const PASSWORD_RESET_EMAIL_LIMIT = 3;
const PASSWORD_RESET_WINDOW_S = 15 * 60;

async function clientIp(): Promise<string> {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "unknown"
  );
}

/** Honeypot: real users never fill this; bots usually do. Empty for humans. */
function botDetected(formData: FormData): boolean {
  return String(formData.get("contact_phone") ?? "").trim() !== "";
}

export async function login(_prev: FormState, formData: FormData): Promise<FormState> {
  if (botDetected(formData)) {
    return { error: "Invalid email or password." };
  }
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");

  // Rate-limit by both source IP and the targeted account so neither
  // credential-stuffing (many accounts from one IP) nor a focused brute force
  // (one account from many IPs) gets unlimited tries. Generic message either way.
  const ip = await clientIp();
  const [ipRl, emailRl] = await Promise.all([
    rateLimit(`login:ip:${ip}`, LOGIN_IP_LIMIT, LOGIN_WINDOW_S),
    email
      ? rateLimit(`login:email:${email}`, LOGIN_EMAIL_LIMIT, LOGIN_WINDOW_S)
      : Promise.resolve({ success: true, remaining: LOGIN_EMAIL_LIMIT }),
  ]);
  if (!ipRl.success || !emailRl.success) {
    logSecurityEvent("auth.login.ratelimited", { email: maskEmail(email), ip });
    await dispatchSecurityAlert("auth.login.ratelimited", { email: maskEmail(email), ip });
    return { error: "Too many attempts. Please wait a few minutes and try again." };
  }

  // Account lockout: if this account is in a cooling-off window, reject without
  // revealing how many attempts remain. Same generic copy as a wrong password.
  if (await isLockedOut(email)) {
    logSecurityEvent("auth.login.locked", { email: maskEmail(email), ip });
    await dispatchSecurityAlert("auth.login.locked", { email: maskEmail(email), ip });
    return { error: "Too many attempts. Please wait a few minutes and try again." };
  }

  const supabase = await userClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    await recordLoginFailure(email);
    logSecurityEvent("auth.login.failure", { email: maskEmail(email), ip });
    return { error: "Invalid email or password." };
  }

  await clearLoginFailures(email); // successful login resets the counter
  logSecurityEvent("auth.login.success", { email: maskEmail(email), ip });

  // If this account has MFA enrolled, the session is still aal1 — require the
  // TOTP step-up before the dashboard. Non-MFA users fall straight through.
  if (await needsMfaStepUp(supabase)) {
    logSecurityEvent("auth.mfa.required", { email: maskEmail(email), ip });
    redirect("/login/verify");
  }
  redirect("/dashboard");
}

export async function signup(_prev: FormState, formData: FormData): Promise<FormState> {
  if (botDetected(formData)) {
    return { error: "Could not create the account. Please try again." };
  }
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const inviteCode = String(formData.get("invite_code") ?? "");

  // Throttle signup by IP (invite-gated already, but stops automated probing of
  // the invite code and email-send abuse).
  const ip = await clientIp();
  const rl = await rateLimit(`signup:ip:${ip}`, LOGIN_IP_LIMIT, LOGIN_WINDOW_S);
  if (!rl.success) {
    return { error: "Too many attempts. Please wait a few minutes and try again." };
  }

  // Server-side password strength gate (Supabase stores the hash but does not
  // enforce a policy). Runs regardless of any client-side check.
  const pwError = validatePassword(password);
  if (pwError) return { error: pwError };

  const mode = signupMode();
  const codeError = validateSignupAccess(mode, inviteCode, process.env.INVITE_CODE ?? "");
  if (codeError) return { error: codeError };

  const supabase = await userClient();
  const emailRedirectTo = authEmailRedirect();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    ...(emailRedirectTo ? { options: { emailRedirectTo } } : {}),
  });
  if (error) return { error: "Could not create the account. Please try again." };


  logSecurityEvent("auth.signup.success", { email: maskEmail(email), ip });

  // Supabase returns no session while email confirmation is pending. Do not send
  // the operator to a protected route that immediately bounces back to login.
  if (!data.session) {
    return {
      success: "Check your email to confirm the account, then return here to sign in.",
    };
  }

  redirect("/dashboard");
}

export async function requestPasswordReset(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const genericSuccess =
    "If an account exists for that email, a password-reset link is on its way.";
  if (botDetected(formData)) return { success: genericSuccess };

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const ip = await clientIp();
  const [ipRl, emailRl] = await Promise.all([
    rateLimit(`password-reset:ip:${ip}`, LOGIN_IP_LIMIT, LOGIN_WINDOW_S),
    email
      ? rateLimit(
          `password-reset:email:${email}`,
          PASSWORD_RESET_EMAIL_LIMIT,
          PASSWORD_RESET_WINDOW_S
        )
      : Promise.resolve({ success: true, remaining: PASSWORD_RESET_EMAIL_LIMIT }),
  ]);
  if (!ipRl.success || !emailRl.success) return { success: genericSuccess };

  const redirectTo = authEmailRedirect("/login/reset");
  if (!redirectTo) {
    logSecurityEvent("auth.password_reset.misconfigured", { ip });
    return { error: "Password recovery is not configured on this deployment." };
  }

  const supabase = await userClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  logSecurityEvent(error ? "auth.password_reset.failure" : "auth.password_reset.requested", {
    email: maskEmail(email),
    ip,
  });

  // Deliberately identical for unknown accounts and provider failures: the form
  // must not become an account-enumeration oracle.
  return { success: genericSuccess };
}

export async function resetPassword(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  if (botDetected(formData)) return { error: "This recovery link is invalid or expired." };

  const password = String(formData.get("password") ?? "");
  const confirmation = String(formData.get("password_confirmation") ?? "");
  const pwError = validatePassword(password);
  if (pwError) return { error: pwError };
  if (password !== confirmation) return { error: "Passwords do not match." };

  const ip = await clientIp();
  const rl = await rateLimit(`password-update:ip:${ip}`, LOGIN_EMAIL_LIMIT, LOGIN_WINDOW_S);
  if (!rl.success) {
    return { error: "Too many attempts. Please wait a few minutes and try again." };
  }

  const supabase = await userClient();
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();
  if (userError || !user) {
    return { error: "This recovery link is invalid or expired. Request a new one." };
  }

  const cookieStore = await cookies();
  const recoveryTicket = cookieStore.get(PASSWORD_RECOVERY_COOKIE)?.value;
  if (!(await verifyPasswordRecoveryTicket(recoveryTicket, user.id))) {
    return { error: "This recovery link is invalid or expired. Request a new one." };
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: "Could not update the password. Request a new recovery link." };

  logSecurityEvent("auth.password_reset.completed", {
    email: maskEmail(user.email ?? ""),
    ip,
  });
  cookieStore.delete(PASSWORD_RECOVERY_COOKIE);
  await supabase.auth.signOut({ scope: "global" });
  redirect("/login?reset=success");
}

export async function signOut(): Promise<never> {
  const supabase = await userClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // scope: "global" revokes every refresh token for the user server-side (log out
  // of all devices), not just this browser's cookie — a captured session token is
  // useless afterwards. @supabase/ssr clears the auth cookies on this response.
  await supabase.auth.signOut({ scope: "global" });
  logSecurityEvent("auth.logout", { user: user?.id ?? "unknown" });
  redirect("/login");
}
