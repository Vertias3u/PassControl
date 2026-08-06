// Minimal RFC 7515 compact JWS, EdDSA (Ed25519) only.
//
// Why hand-rolled rather than jose: jose cannot SIGN EdDSA on the edge runtime.
// Its browser build — the one Next resolves for `runtime = "edge"` — rejects raw
// Uint8Array key material unless the algorithm starts with "HS", and routes JWK
// input through crypto.subtle.importKey(..., { name: "Ed25519" }), which
// lib/crypto/ed25519.ts already documents as unreliable across edge runtimes.
// @noble/curves signing is proven on edge here (app/api/demo/run/route.ts).
//
// The OUTPUT is still a standard RFC 8037 JWS: stock jose verifies it off-edge
// against the JWK we publish, and tests/jws.test.ts pins exactly that.
import { ed25519 } from "@noble/curves/ed25519";

import { base64urlToBytes, bytesToBase64url, bytesToUtf8, utf8ToBytes } from "../encoding";

/**
 * RFC 8725 explicit typing. Receipts and agent tokens are signed by the same
 * instance key, so without a typ check a historical receipt would satisfy a
 * live authentication decision. Every verifier that knows what it expects
 * should say so.
 */
export const RECEIPT_TYP = "passcontrol-receipt+jwt";
export const AGENT_TOKEN_TYP = "passcontrol-agent+jwt";

/**
 * Agent-token format version. Lives here rather than in the route because a
 * Next route file may only export HTTP verbs and route config — exporting
 * anything else fails the production build (tsc alone does not catch it).
 * Additive-only, same rule as RECEIPT_VER in lib/receipt.ts.
 */
export const AGENT_TOKEN_VER = 1;

export interface SignInput {
  typ: string;
  kid: string;
  claims: Record<string, unknown>;
  seed: Uint8Array;
}

export interface VerifiedJws {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

export function signCompactJws({ typ, kid, claims, seed }: SignInput): string {
  const header = bytesToBase64url(utf8ToBytes(JSON.stringify({ alg: "EdDSA", typ, kid })));
  const payload = bytesToBase64url(utf8ToBytes(JSON.stringify(claims)));
  const input = `${header}.${payload}`;
  return `${input}.${bytesToBase64url(ed25519.sign(utf8ToBytes(input), seed))}`;
}

/**
 * Verify a compact JWS against one Ed25519 public key. Returns null on any
 * failure — malformed input, wrong key, tampered payload, unexpected typ.
 *
 * `alg` is pinned to EdDSA rather than read from the token. A verifier that
 * dispatches on the token's own `alg` can be handed alg:"none", or an HS256 MAC
 * keyed on the public key it just fetched from the JWKS — the classic algorithm
 * confusion attack, which would make this whole mechanism decorative.
 */
export function verifyCompactJws(
  token: string,
  publicKey: Uint8Array,
  expect?: { typ?: string }
): VerifiedJws | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    if (!headerPart || !payloadPart || !signaturePart) return null;

    const header = JSON.parse(bytesToUtf8(base64urlToBytes(headerPart)));
    if (header?.alg !== "EdDSA") return null;
    if (expect?.typ && header?.typ !== expect.typ) return null;

    const signature = base64urlToBytes(signaturePart);
    const signed = utf8ToBytes(`${headerPart}.${payloadPart}`);
    if (!ed25519.verify(signature, signed, publicKey)) return null;

    return { header, claims: JSON.parse(bytesToUtf8(base64urlToBytes(payloadPart))) };
  } catch {
    return null;
  }
}
