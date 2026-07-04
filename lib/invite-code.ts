// Tiny signup gate: registration requires a shared invite code (env INVITE_CODE).
// On a $0 budget this keeps strangers from creating accounts in front of your
// provider keys and burning your spend. Returns an error message, or null if ok.
import { timingSafeEqual } from "./crypto/constantTime";

export function validateInviteCode(code: string, expected: string): string | null {
  if (!expected) return "Signups are currently closed.";
  const trimmed = code.trim();
  if (!trimmed) return "An invite code is required.";
  // Constant-time compare so the invite code can't be recovered byte-by-byte
  // via response timing.
  if (!timingSafeEqual(trimmed, expected)) return "Invalid invite code.";
  return null;
}
