// MFA step-up gate helpers (shared by the login action + dashboard page).
//
// Supabase models MFA as Assurance Level: password login = aal1; verifying a TOTP
// factor elevates to aal2. A user who HAS a verified factor must reach aal2 before
// the dashboard. `getAuthenticatorAssuranceLevel()` reports currentLevel (from the
// session) and nextLevel (aal2 if they have a factor).
import type { SupabaseClient } from "@supabase/supabase-js";

export type Aal = "aal1" | "aal2" | null;

/** True iff the session is authenticated but a TOTP step-up is still required. */
export function stepUpRequired(currentLevel: Aal, nextLevel: Aal): boolean {
  return currentLevel === "aal1" && nextLevel === "aal2";
}

/** Does this session need to complete MFA before reaching protected pages?
 *  Fails OPEN (false) on error — a transient GoTrue blip must never lock out a
 *  legitimate (usually non-MFA) user; the gate is also re-checked on the dashboard. */
export async function needsMfaStepUp(supabase: SupabaseClient): Promise<boolean> {
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error || !data) return false;
    return stepUpRequired(data.currentLevel as Aal, data.nextLevel as Aal);
  } catch {
    return false;
  }
}
