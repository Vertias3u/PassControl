// Offline verification of what a PassControl deployment signs.
//
// The plain-ESM twin of sdk/verify.ts, for `passcontrol verify`. Duplicated
// rather than imported because the shipped CLI is transpilation-free; the tests
// pin the two implementations to agree on the cases that matter.
//
// Nothing here needs a PassControl account, an API key, or a passport. You need
// the artifact and the issuer's origin. That is the whole point.
import { ed25519 } from "@noble/curves/ed25519";
import { RECEIPT_PROTOCOL } from "./protocols.mjs";

export const RECEIPT_TYP = "passcontrol-receipt+jwt";
export const AGENT_TOKEN_TYP = "passcontrol-agent+jwt";
// Receipts v2 add Direct Agent identity claims. This is a maximum, not an
// equality check: v1 receipts remain independently verifiable forever.
export const SUPPORTED_VER = RECEIPT_PROTOCOL.maximum;

const fromB64url = (value) =>
  new Uint8Array(Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64"));

const decodeJson = (segment) => JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));

/**
 * Exact match after stripping a trailing slash. Prefix or suffix matching is
 * the classic issuer-confusion bug — `https://good.com.evil.com` and
 * `https://evil.com/?x=https://good.com` must both fail.
 */
export function matchesIssuer(iss, trusted) {
  const strip = (v) => String(v).replace(/\/+$/, "");
  return trusted.some((candidate) => strip(candidate) === strip(iss));
}

async function loadJwks(issuer, fetchImpl) {
  try {
    const res = await fetchImpl(new URL("/.well-known/jwks.json", issuer).toString());
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body?.keys) ? body.keys : [];
  } catch {
    return null;
  }
}

async function verifySigned(token, typ, { issuer, fetch: fetchImpl = fetch }) {
  const parts = String(token).split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, reason: "malformed" };
  }

  let header;
  let claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // EdDSA is pinned, never read from the token. A verifier that dispatches on
  // the token's own `alg` accepts alg:"none" and accepts an HS256 MAC keyed on
  // the public key it just fetched — which is public, so anyone can compute it.
  if (header?.alg !== "EdDSA") return { ok: false, reason: "bad_signature" };
  if (header?.typ !== typ) return { ok: false, reason: "wrong_type" };
  if (!claims?.iss || !matchesIssuer(claims.iss, [issuer])) {
    return { ok: false, reason: "untrusted_issuer" };
  }
  if (Number(claims.ver ?? 0) > SUPPORTED_VER) return { ok: false, reason: "unsupported_version" };

  const keys = await loadJwks(claims.iss, fetchImpl);
  if (!keys) return { ok: false, reason: "jwks_unreachable" };

  const candidates = keys.filter(
    (key) =>
      key?.kty === "OKP" &&
      key?.crv === "Ed25519" &&
      typeof key.x === "string" &&
      (!header.kid || !key.kid || key.kid === header.kid)
  );
  if (candidates.length === 0) return { ok: false, reason: "unknown_key" };

  const signature = fromB64url(parts[2]);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  for (const key of candidates) {
    try {
      if (ed25519.verify(signature, signed, fromB64url(key.x))) return { ok: true, claims };
    } catch {
      // A malformed JWK entry must not abort verification against the others.
    }
  }
  return { ok: false, reason: "bad_signature" };
}

export function verifyReceipt(jws, options) {
  return verifySigned(jws, RECEIPT_TYP, options);
}

export async function verifyAgentToken(token, options) {
  const { audience, now = () => Date.now() } = options;
  if (!audience) return { ok: false, reason: "wrong_audience" };

  const result = await verifySigned(token, AGENT_TOKEN_TYP, options);
  if (!result.ok) return result;

  if (result.claims.aud !== audience) return { ok: false, reason: "wrong_audience" };
  const seconds = Math.floor(now() / 1000);
  if (typeof result.claims.exp !== "number" || result.claims.exp <= seconds) {
    return { ok: false, reason: "expired" };
  }
  return result;
}

/** Human-readable one-liners. Kept here so the CLI and its tests agree on wording. */
export const FAILURE_REASONS = {
  malformed: "not a compact JWS",
  bad_signature: "signature does not verify against the issuer's published key",
  wrong_type: "this artifact is a different type than the one you asked to verify",
  untrusted_issuer: "the issuer in the artifact is not the one you named",
  unknown_key: "the issuer does not publish the key this was signed with",
  jwks_unreachable: "could not fetch the issuer's key set",
  unsupported_version: "signed by a newer PassControl than this CLI understands",
  wrong_audience: "minted for a different audience",
  expired: "expired",
};
