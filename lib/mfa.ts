// MFA step-up helpers.
//
// Supabase models MFA as Assurance Level: password login = aal1; verifying a TOTP
// factor elevates to aal2. A user who HAS a verified factor must reach aal2 before
// the dashboard.
//
// TWO HELPERS, AND THEY ARE NOT INTERCHANGEABLE.
//
//   needsMfaStepUp  — navigation only. Lenient. Never authorizes anything.
//   mfaAuthorizedUser — authorization. Strict, fails closed, returns the user.
//   mfaSatisfied      — the same authorization decision without the user.
//
// The split exists because of a real bypass. `getAuthenticatorAssuranceLevel()`
// called with no argument reports two levels with two very different pedigrees
// (verified against @supabase/auth-js 2.108.2,
// dist/main/GoTrueClient.js:4890-4911):
//
//   currentLevel <- decodeJWT(session.access_token).aal   — a SIGNED claim
//   nextLevel    <- session.user.factors                  — UNSIGNED cookie data
//
// `session` there comes from storage, and on the server storage is the request's
// cookies (@supabase/ssr 0.5.2, dist/main/cookies.js:229-250: base64-decode then
// JSON.parse). auth-js validates it with `_isValidSession`, which only checks
// that the keys `access_token`, `refresh_token` and `expires_at` are present.
// Nothing authenticates `session.user`.
//
// So an attacker holding an aal1 session for an MFA-enrolled account — a phished
// password, a stolen cookie, XSS; @supabase/ssr sets httpOnly:false — can leave
// the signed tokens untouched, empty the outer wrapper's `user.factors`, and turn
// `nextLevel` from aal2 into aal1. `stepUpRequired(aal1, aal1)` is false, and the
// step-up is gone. That is precisely the attacker MFA step-up exists to stop.
//
// The rule that falls out: never let an authorization decision depend on
// `session.user`. `mfaSatisfied` below does not read it at all.
import { decodeJwt } from "jose";
import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import type { SupabaseClient, User } from "@supabase/supabase-js";

export type Aal = "aal1" | "aal2" | null;

/** True iff the session is authenticated but a TOTP step-up is still required. */
export function stepUpRequired(currentLevel: Aal, nextLevel: Aal): boolean {
  return currentLevel === "aal1" && nextLevel === "aal2";
}

/** Should this session be sent to /login/verify before a protected PAGE renders?
 *
 *  NAVIGATION ONLY. Do not use this to authorize a write — it is bypassable by
 *  editing the session cookie (see the note at the top of this file), and it
 *  fails OPEN on error so that a transient GoTrue blip cannot lock a legitimate
 *  (usually non-MFA) user out of their own dashboard. Both properties are
 *  acceptable for deciding which page to show and unacceptable for deciding
 *  whether to rotate a passport or widen a scope.
 *
 *  The older justification for the fail-open — "the gate is also re-checked on
 *  the dashboard" — is true of a redirect and FALSE of a Server Action. A Server
 *  Action is addressable over HTTP by its id; there is no later re-check, the
 *  action IS the decision, and the cost of failing closed there is a retried
 *  button press, not a lockout. That reasoning is what made using this helper as
 *  an authorization gate look safe. Use `mfaSatisfied` for those. */
export async function needsMfaStepUp(supabase: SupabaseClient): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return false;
    return stepUpRequired(data.currentLevel as Aal, data.nextLevel as Aal);
  } catch {
    return false;
  }
}

/** Why a strict gate refused. `indeterminate` means we could not establish the
 *  assurance level — which is a refusal, not a pass. */
export type MfaGateResult =
  | { ok: true }
  | { ok: false; reason: "unauthenticated" | "step_up_required" | "indeterminate" };

export type MfaAuthorizedUserResult =
  | { ok: true; user: User }
  | { ok: false; reason: "unauthenticated" | "step_up_required" | "indeterminate" };

/**
 * Return the authenticated user only after this session has cleared MFA.
 * Strict, and fails CLOSED on every uncertainty.
 * This is the gate for consequential writes: passport rotation and expiry, owner
 * declaration and publication, policy drafts and promotion, break-glass.
 *
 * Two facts are needed, and each is taken from the only trustworthy source:
 *
 *   1. Does the user have a verified factor?  ->  `getUser()`, which is a network
 *      call to the auth server (auth-js GoTrueClient.js:2611-2637), so the
 *      factor list is authentic. NOT `session.user.factors`.
 *   2. Is this session at aal2?  ->  the `aal` claim decoded from the access
 *      token that `getUser()` just accepted. The claim is inside the signed JWT:
 *      forging it invalidates the signature, and the auth server would then have
 *      rejected the token at step 1, so we would never reach step 2.
 *
 * Nothing else is consulted. In particular `session.user` is never read — only
 * `session.access_token`, which is a bearer credential the auth server has
 * already vouched for in this same request.
 *
 * The helper intentionally accepts no pre-fetched user. Its `getUser()` call is
 * the corroboration that makes it safe to decode the AAL claim from the cookie's
 * access token. An optional user parameter used to skip that call, but also let
 * a future caller accidentally pair a fabricated/cached user with a self-minted
 * `{aal:"aal2"}` token. Returning the verified user makes the safe path just as
 * convenient without leaving that bypass-shaped API available.
 */
export async function mfaAuthorizedUser(
  supabase: SupabaseClient
): Promise<MfaAuthorizedUserResult> {
  try {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError || !userData?.user) {
      // Both refuse. The distinction is only so a caller can say "sign in
      // again" versus "try again" — never so one of them can be let through.
      return { ok: false, reason: isAuthRetryableFetchError(userError) ? "indeterminate" : "unauthenticated" };
    }
    const user = userData.user;

    // No verified factor means no step-up is possible, so there is nothing to
    // clear. This is the common path for a non-MFA user and must stay open —
    // note it is decided from the SERVER's factor list, so a cookie that invents
    // a factor cannot be used to deny service either.
    const verified = (user.factors ?? []).filter((factor) => factor.status === "verified");
    if (verified.length === 0) return { ok: true, user };

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    if (sessionError || !accessToken) return { ok: false, reason: "indeterminate" };

    let aal: unknown;
    try {
      aal = (decodeJwt(accessToken) as Record<string, unknown>).aal;
    } catch {
      return { ok: false, reason: "indeterminate" };
    }

    return aal === "aal2" ? { ok: true, user } : { ok: false, reason: "step_up_required" };
  } catch {
    // A throw is an unknown assurance level, and an unknown assurance level is a
    // refusal. The lenient helper's fail-open reasoning does not apply here.
    return { ok: false, reason: "indeterminate" };
  }
}

/** The strict authorization answer for callers that do not need the user. */
export async function mfaSatisfied(supabase: SupabaseClient): Promise<MfaGateResult> {
  const result = await mfaAuthorizedUser(supabase);
  return result.ok ? { ok: true } : result;
}
