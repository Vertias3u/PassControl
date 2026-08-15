// Tiny signup gate: registration requires a shared invite code (env INVITE_CODE).
// On a $0 budget this keeps strangers from creating accounts in front of your
// provider keys and burning your spend. Returns an error message, or null if ok.
import { timingSafeEqual } from "./crypto/constantTime";

export type SignupMode = "open" | "invite" | "closed";
export type InviteSource = "shared" | "database";

/**
 * Deployment-level signup policy. Invalid and missing values deliberately fall
 * back to invite-only so a typo can never open registration by accident.
 */
export function signupMode(raw = process.env.PASSCONTROL_SIGNUP_MODE): SignupMode {
  const mode = raw?.trim().toLowerCase();
  return mode === "open" || mode === "closed" || mode === "invite" ? mode : "invite";
}

/** Database invitations are explicitly enabled only after migration 0025 and
 * its operator surface are deployed. Every absent/invalid value preserves the
 * current shared-code behavior. */
export function inviteSource(raw = process.env.PASSCONTROL_INVITE_SOURCE): InviteSource {
  return raw?.trim().toLowerCase() === "database" ? "database" : "shared";
}

export function validateInviteCode(code: string, expected: string): string | null {
  if (!expected) return "Signups are currently closed.";
  const trimmed = code.trim();
  if (!trimmed) return "An invite code is required.";
  // Constant-time compare so the invite code can't be recovered byte-by-byte
  // via response timing.
  if (!timingSafeEqual(trimmed, expected)) return "Invalid invite code.";
  return null;
}

export function validateSignupAccess(
  mode: SignupMode,
  code: string,
  expected: string
): string | null {
  if (mode === "closed") return "Signups are currently closed.";
  if (mode === "open") return null;
  return validateInviteCode(code, expected);
}
