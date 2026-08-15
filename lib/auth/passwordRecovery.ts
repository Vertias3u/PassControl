import { jwtVerify, SignJWT } from "jose";
import { visaSecretCandidates } from "./visa";

export const PASSWORD_RECOVERY_COOKIE = "pc-password-recovery";
export const PASSWORD_RECOVERY_MAX_AGE_S = 15 * 60;
const AUDIENCE = "passcontrol-password-recovery";
const PURPOSE = "password_recovery";

// Recovery tickets are signed with VISA_SECRET, so the derivation must be the
// SAME one visa.ts uses — this file trimmed and visa.ts did not, which was
// harmless only because nothing cross-verifies. Sharing the helper removes the
// chance that a future edit to one reading silently diverges from the other.
//
// Unlike visa.ts this path must not throw (it runs inside an auth route), so a
// below-floor secret yields no candidates and the ticket is simply not issued —
// rather than being minted under a weak key, which is what used to happen.
function signingSecret(): Uint8Array | null {
  return visaSecretCandidates(process.env.VISA_SECRET)[0] ?? null;
}

function verificationSecrets(): Uint8Array[] {
  return [
    ...visaSecretCandidates(process.env.VISA_SECRET),
    ...visaSecretCandidates(process.env.VISA_SECRET_PREV),
  ];
}

/** A short-lived, user-bound proof that this session came through the recovery callback. */
export async function issuePasswordRecoveryTicket(userId: string): Promise<string | null> {
  const secret = signingSecret();
  if (!secret || !userId) return null;
  return new SignJWT({ purpose: PURPOSE })
    .setProtectedHeader({ alg: "HS256", typ: "passcontrol-password-recovery+jwt" })
    .setSubject(userId)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${PASSWORD_RECOVERY_MAX_AGE_S}s`)
    .sign(secret);
}

export async function verifyPasswordRecoveryTicket(
  ticket: string | undefined,
  userId: string
): Promise<boolean> {
  if (!ticket || !userId) return false;
  for (const secret of verificationSecrets()) {
    try {
      const { payload } = await jwtVerify(ticket, secret, {
        algorithms: ["HS256"],
        audience: AUDIENCE,
      });
      if (payload.sub === userId && payload.purpose === PURPOSE) return true;
    } catch {
      // Try the previous visa secret during a zero-downtime secret rotation.
    }
  }
  return false;
}
