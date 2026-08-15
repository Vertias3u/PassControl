// Work-visa (Scoped Access JWT) mint + verify. HS256 via jose.
//
// The same gateway mints and verifies, so a symmetric secret is appropriate.
// VISA_SECRET_PREV enables zero-downtime rotation: we sign with the current
// secret and accept either current or previous on verify.
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { utf8ToBytes } from "../encoding";

export const VISA_ISS = "passport.gateway";
export const VISA_AUD = "llm-proxy";
export const VISA_VER = 1;

export interface ScopeEntry {
  provider: string;
  models: string[];
}

export interface VisaClaims extends JWTPayload {
  sub: string; // passport_id (base64url Ed25519 pubkey)
  agid: string; // agent id
  uid: string; // owner user id (tenant-scoped kill + log scoping, no hot-path DB read)
  jti: string; // per-visa id
  scope: ScopeEntry[];
  bt: number | null; // budget_tokens snapshot at mint (null = unlimited)
  bc: number | null; // budget_cents snapshot at mint (null = no cost cap)
  st: number; // spent_tokens snapshot at mint (seeds the Redis counter NX)
  sc: number; // spent_microcents snapshot at mint (seeds the Redis cost counter NX)
  ver: number;
}

/** Pull the visa out of whichever header the caller's native SDK uses, so the
 *  gateway is drop-in: the OpenAI SDK sends `Authorization: Bearer <key>`, the
 *  Anthropic SDK sends `x-api-key: <key>`. Authorization Bearer is preferred;
 *  x-api-key is the fallback. The token is verified cryptographically afterwards,
 *  so accepting it from either header carries no extra trust. Returns "" if none. */
export function extractVisaToken(headers: Headers): string {
  const auth = headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  return (headers.get("x-api-key") ?? "").trim();
}

/**
 * A visa's lifetime, in seconds. Default 300, clamped to [300, 900].
 *
 * Exported because the visa carries a SNAPSHOT of the agent's scope (see
 * `mintVisa` below) and the proxy gates on `claims.scope`, not on the row. So
 * an edit to an agent's scope does not bite until the visa holding the old one
 * expires — and any UI explaining that delay must render this number rather
 * than say "5 minutes", which is wrong on any deployment that raised
 * VISA_TTL_SECONDS. Same rule as the advertised version string.
 */
export function visaTtlSeconds(): number {
  const raw = Number(process.env.VISA_TTL_SECONDS ?? "300");
  if (!Number.isFinite(raw)) return 300;
  return Math.min(900, Math.max(300, Math.floor(raw)));
}

export const VISA_SECRET_MIN_BYTES = 32;

/**
 * The secret as actually used for signing: surrounding whitespace is an artefact
 * of how the value was set (`openssl rand -base64 32 | pbcopy`, a dashboard
 * paste), not part of the secret. Returns null if there is no usable secret.
 *
 * Why this matters, given that reading it raw is self-consistent: VISA_SECRET_PREV
 * is set by a human copying the old value. If the old value carried a trailing
 * newline and the copy loses it, _PREV is a DIFFERENT key and every visa minted
 * before the rotation fails — the precise outage zero-downtime rotation exists to
 * prevent. Same class of trap as the CACHE_ENC_KEY newline (see aesgcm.ts).
 *
 * The floor is measured on the trimmed value because whitespace is not entropy.
 * The raw fallback exists only so that a deployment whose secret satisfies the
 * floor TODAY cannot be pushed below it by this change — that would throw on the
 * hot path and take mint and verify down together.
 *
 * Shared with lib/auth/passwordRecovery.ts, which reads the same variable and had
 * always trimmed it. tests/visa-secret-normalisation.test.ts pins the parity.
 */
export function normaliseVisaSecret(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (utf8ToBytes(trimmed).length >= VISA_SECRET_MIN_BYTES) return trimmed;
  if (utf8ToBytes(value).length >= VISA_SECRET_MIN_BYTES) return value;
  return null;
}

/**
 * Every key a token signed under `value` could legitimately carry: the
 * normalised form first (what we sign with), then the raw form when it differs.
 * Accepting the raw form is what makes deploying this change safe — a visa
 * minted moments ago by the previous build was signed with the untrimmed bytes
 * and must keep verifying until it expires. Both forms come from the same
 * operator-set material, so this grants no new capability to a forger.
 */
export function visaSecretCandidates(value: string | undefined): Uint8Array[] {
  const chosen = normaliseVisaSecret(value);
  if (chosen === null || value === undefined) return [];
  const out = [utf8ToBytes(chosen)];
  if (value !== chosen) out.push(utf8ToBytes(value));
  return out;
}

/** Non-empty by construction: the throw is the only path out of an unusable secret. */
function secretVariants(
  name: "VISA_SECRET" | "VISA_SECRET_PREV",
  value: string,
): [Uint8Array, ...Uint8Array[]] {
  const [primary, ...rest] = visaSecretCandidates(value);
  if (!primary) {
    throw new Error(`${name} must be at least ${VISA_SECRET_MIN_BYTES} bytes for HS256 visa signing`);
  }
  return [primary, ...rest];
}

function currentSecret(): Uint8Array {
  const s = process.env.VISA_SECRET;
  if (!s) throw new Error("VISA_SECRET is not set");
  return secretVariants("VISA_SECRET", s)[0];
}

function acceptedSecrets(): Uint8Array[] {
  const s = process.env.VISA_SECRET;
  if (!s) throw new Error("VISA_SECRET is not set");
  const secrets: Uint8Array[] = secretVariants("VISA_SECRET", s);
  // A whitespace-only _PREV means "no rotation in progress", not "broken secret".
  // Blanking a dashboard field leaves "" or "\n" far more often than it deletes
  // the variable, and `"\n"` is truthy — so testing the raw value here used to
  // enter the branch and throw. That throw is on the VERIFY path, which would
  // 500 every agent call. A cleared secret reads as absent.
  const prev = process.env.VISA_SECRET_PREV;
  if (prev && prev.trim()) {
    secrets.push(...secretVariants("VISA_SECRET_PREV", prev));
  }
  return secrets;
}

export interface MintVisaInput {
  passportId: string;
  agentId: string;
  userId: string;
  jti: string;
  scope: ScopeEntry[];
  budgetTokens: number | null;
  budgetCents: number | null;
  spentTokens: number;
  spentMicrocents: number;
}

export async function mintVisa(input: MintVisaInput): Promise<{ token: string; expSeconds: number }> {
  const ttl = visaTtlSeconds();
  const token = await new SignJWT({
    agid: input.agentId,
    uid: input.userId,
    scope: input.scope,
    bt: input.budgetTokens,
    bc: input.budgetCents,
    st: input.spentTokens,
    sc: input.spentMicrocents,
    ver: VISA_VER,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(VISA_ISS)
    .setAudience(VISA_AUD)
    .setSubject(input.passportId)
    .setJti(input.jti)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(currentSecret());
  return { token, expSeconds: ttl };
}

/** Verify a visa against current (and previous) secrets. Returns claims or null. */
export async function verifyVisa(token: string): Promise<VisaClaims | null> {
  for (const secret of acceptedSecrets()) {
    try {
      const { payload } = await jwtVerify(token, secret, {
        issuer: VISA_ISS,
        audience: VISA_AUD,
        algorithms: ["HS256"],
      });
      const claims = payload as VisaClaims;
      // Reject any token missing a required claim or carrying an unexpected
      // version (jose has already enforced signature, alg, iss, aud, exp/nbf).
      if (!claims.sub || !claims.agid || !claims.uid || !claims.jti || !Array.isArray(claims.scope))
        return null;
      if (
        typeof claims.st !== "number" ||
        !Number.isFinite(claims.st) ||
        typeof claims.sc !== "number" ||
        !Number.isFinite(claims.sc)
      )
        return null;
      if (!(claims.bt == null || (typeof claims.bt === "number" && Number.isFinite(claims.bt))))
        return null;
      if (!(claims.bc == null || (typeof claims.bc === "number" && Number.isFinite(claims.bc))))
        return null;
      if (claims.ver !== VISA_VER) return null;
      return claims;
    } catch {
      // try next secret
    }
  }
  return null;
}
