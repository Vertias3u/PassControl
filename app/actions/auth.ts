"use server";
// Auth server actions (email + password). Ported from the Atlas app and adapted:
// reuses PassControl's userClient(), English copy, invite-gated signup, no OAuth,
// no user-audit hook. Each action returns { error } for the form to display, or
// redirect()s on success.
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { userClient } from "@/lib/supabase/server";
import { validateInviteCode } from "@/lib/invite-code";
import { validatePassword } from "@/lib/password";
import { rateLimit } from "@/lib/ratelimit";
import { isLockedOut, recordLoginFailure, clearLoginFailures } from "@/lib/auth/lockout";
import { logSecurityEvent, maskEmail } from "@/lib/seclog";
import { dispatchSecurityAlert } from "@/lib/alert";
import { needsMfaStepUp } from "@/lib/mfa";

type FormState = { error?: string } | undefined;

// Throttle thresholds. Strict enough to stop automated guessing, loose enough
// that a real user mistyping a few times is unaffected.
const LOGIN_IP_LIMIT = 30; // bursts of attempts from one network per window
const LOGIN_EMAIL_LIMIT = 8; // attempts against a single account per window
const LOGIN_WINDOW_S = 300; // 5-minute fixed window

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
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const inviteCode = String(formData.get("invite_code") ?? "");

  // Throttle signup by IP (invite-gated already, but stops automated probing of
  // the invite code and email-send abuse).
  const ip = await clientIp();
  const rl = await rateLimit(`signup:ip:${ip}`, LOGIN_IP_LIMIT, LOGIN_WINDOW_S);
  if (!rl.success) {
    return { error: "Too many attempts. Please wait a few minutes and try again." };
  }

  const codeError = validateInviteCode(inviteCode, process.env.INVITE_CODE ?? "");
  if (codeError) return { error: codeError };

  // Server-side password strength gate (Supabase stores the hash but does not
  // enforce a policy). Runs regardless of any client-side check.
  const pwError = validatePassword(password);
  if (pwError) return { error: pwError };

  const supabase = await userClient();
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) return { error: "Could not create the account. Please try again." };

  logSecurityEvent("auth.signup.success", { email: maskEmail(email), ip });

  // If email confirmation is ON in Supabase, no session exists yet and the user
  // must confirm via email first. For local dev you can disable confirmation
  // (Supabase → Auth → Providers → Email → "Confirm email" off) so this lands
  // straight on the dashboard.
  redirect("/dashboard");
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
