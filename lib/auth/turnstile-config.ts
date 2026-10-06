// Cloudflare Turnstile: the one switch that decides both the widget and the
// page policy, so the two can never disagree.
//
// Imported by middleware (edge), by the client forms, and by the server
// actions. No imports, on purpose: anything heavier would ride into the
// browser bundle with it.
//
// SUPABASE IS THE ONLY ENFORCER. With a site key set, the forms render the
// widget and the actions forward its token as `captchaToken`. Whether a
// tokenless request is refused is Supabase's decision (Auth → Bot and Abuse
// Protection), never this app's: an app-side refusal would turn a Turnstile
// outage or a blocked script into a lockout that only a redeploy can undo.
// Kept that way, the rollback is one dashboard toggle.
//
// `NEXT_PUBLIC_` values are inlined at BUILD time. Setting the key in Vercel
// takes effect on the next build, not on a restart.

/** Where Cloudflare serves the widget's script and iframe. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

/** The hidden input the widget fills inside its form. */
export const TURNSTILE_RESPONSE_FIELD = "cf-turnstile-response";

/**
 * The pages whose forms call a captcha-protected Supabase endpoint: signUp,
 * signInWithPassword, resetPasswordForEmail, resend. `/login/reset` is not one: it
 * sets a new password on a session the emailed link already established.
 */
export const TURNSTILE_PATHS: readonly string[] = ["/login", "/signup", "/login/forgot", "/signup/resend"];

export function turnstileSiteKey(): string | null {
  return null;
}

export function needsTurnstile(pathname: string): boolean {
  return turnstileSiteKey() !== null && TURNSTILE_PATHS.includes(pathname);
}

/** The widget's token from a submitted form, or undefined when there is none. */
export function captchaTokenFrom(formData: FormData): string | undefined {
  const value = formData.get(TURNSTILE_RESPONSE_FIELD);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Supabase refused the request at its captcha check, not on its merits. */
export function isCaptchaFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "captcha_failed"
  );
}

export const HUMAN_CHECK_FAILED =
  "The human check did not go through. Complete it again, then retry.";
