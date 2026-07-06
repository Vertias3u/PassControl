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

function ttlSeconds(): number {
  const raw = Number(process.env.VISA_TTL_SECONDS ?? "300");
  if (!Number.isFinite(raw)) return 300;
  return Math.min(900, Math.max(300, Math.floor(raw)));
}

function currentSecret(): Uint8Array {
  const s = process.env.VISA_SECRET;
  if (!s) throw new Error("VISA_SECRET is not set");
  return utf8ToBytes(s);
}

function acceptedSecrets(): Uint8Array[] {
  const secrets = [currentSecret()];
  if (process.env.VISA_SECRET_PREV) secrets.push(utf8ToBytes(process.env.VISA_SECRET_PREV));
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
  const ttl = ttlSeconds();
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
