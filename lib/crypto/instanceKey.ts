// The Ed25519 keypair owned by the DEPLOYMENT, not by any agent.
//
// Every other private key in PassControl belongs to an agent and is generated
// client-side; the server only ever holds public keys. This one is different:
// it is how a deployment signs artifacts that outsiders verify — call receipts
// and agent-to-agent tokens — against the public half published at
// /.well-known/jwks.json. Nothing here ever touches a provider credential.
//
// Deliberately NOT modelled on lib/crypto/aesgcm.ts, which throws when
// CACHE_ENC_KEY is missing. That is correct there: the proxy cannot function
// without the cache key. Here a missing key means "receipts and agent tokens
// are off", which is a supported configuration — so every loader returns null
// instead. The receipt is built inline in the writeLog argument list inside
// reconcile(), and a throw at that point takes out the whole tasks array.
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

import { base64urlToBytes, bytesToBase64url, utf8ToBytes } from "../encoding";

const SEED_BYTES = 32;

export interface InstanceSigner {
  seed: Uint8Array;
  publicKey: Uint8Array;
  kid: string;
}

export interface InstanceVerifier {
  publicKey: Uint8Array;
  kid: string;
}

export interface PublicJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  alg: "EdDSA";
  use: "sig";
  kid: string;
}

/**
 * RFC 7638 JWK thumbprint over an Ed25519 public key.
 *
 * The required members for an OKP key are crv, kty and x, serialised with no
 * whitespace in lexicographic order. Deriving the kid rather than configuring
 * it means the operator supplies only a seed and both the current and previous
 * kid fall out of it — and any standard verifier can recompute it.
 */
export function jwkThumbprint(x: string): string {
  return bytesToBase64url(sha256(utf8ToBytes(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`)));
}

export function publicJwk(publicKey: Uint8Array): PublicJwk {
  const x = bytesToBase64url(publicKey);
  return { kty: "OKP", crv: "Ed25519", x, alg: "EdDSA", use: "sig", kid: jwkThumbprint(x) };
}

/** Decode a configured seed. Returns null on anything malformed — never throws. */
function decodeSeed(raw: string | undefined): Uint8Array | null {
  if (!raw) return null;
  try {
    // Accept standard base64 as well as base64url, the same normalisation
    // aesgcm.ts applies to CACHE_ENC_KEY.
    const seed = base64urlToBytes(raw.trim().replace(/\+/g, "-").replace(/\//g, "_"));
    return seed.length === SEED_BYTES ? seed : null;
  } catch {
    return null;
  }
}

function toSigner(seed: Uint8Array): InstanceSigner {
  const publicKey = ed25519.getPublicKey(seed);
  return { seed, publicKey, kid: publicJwk(publicKey).kid };
}

// Cached on the raw env string, not on a boolean. Keying the cache on the value
// means a rotated key is picked up on the next call; a plain `if (cached)` would
// keep signing with the old seed until the process restarted.
let cache: { raw: string; signer: InstanceSigner } | null = null;

/**
 * The key this deployment signs with, or null when none is configured.
 * Only the current key ever signs — see loadInstanceVerifiers for _PREV.
 */
export function loadInstanceSigner(): InstanceSigner | null {
  const raw = process.env.INSTANCE_SIGNING_KEY;
  if (!raw) return null;
  if (cache && cache.raw === raw) return cache.signer;
  const seed = decodeSeed(raw);
  if (!seed) return null;
  const signer = toSigner(seed);
  cache = { raw, signer };
  return signer;
}

/**
 * Every public key that should appear in the JWKS: the current one, plus the
 * previous one while a rotation is in flight.
 *
 * NOTE the semantics are the INVERSE of VISA_SECRET_PREV. For the symmetric
 * visa secret, _PREV means "still accept this on verify". Here we never sign
 * with the previous key — we only keep publishing its public half so artifacts
 * signed before the rotation still verify. Receipts carry no exp, so once
 * anything has been signed with a key its entry is effectively permanent.
 */
export function loadInstanceVerifiers(): InstanceVerifier[] {
  const out: InstanceVerifier[] = [];
  const current = loadInstanceSigner();
  if (current) out.push({ publicKey: current.publicKey, kid: current.kid });

  const prevSeed = decodeSeed(process.env.INSTANCE_SIGNING_KEY_PREV);
  if (prevSeed) {
    const prev = toSigner(prevSeed);
    // A rotation that has not moved yet would otherwise publish the key twice.
    if (!out.some((v) => v.kid === prev.kid)) {
      out.push({ publicKey: prev.publicKey, kid: prev.kid });
    }
  }
  return out;
}

/**
 * The `iss` claim, and the origin from which another instance resolves our
 * JWKS. Operator-supplied and validated as a bare https origin.
 *
 * Never derived from the Host header: that is attacker-controlled, and an
 * issuer an attacker can choose is an issuer they can point at a key set they
 * control. A path, query or fragment is rejected because it breaks both the
 * verifier's `new URL("/.well-known/jwks.json", iss)` resolution and the exact
 * string match against its trusted-issuer list.
 */
export function instanceIssuer(): string | null {
  const raw = process.env.PASSCONTROL_ISSUER?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.pathname !== "/" || url.search || url.hash) return null;
    if (url.username || url.password) return null;
    if (url.protocol === "https:") return url.origin;
    // Loopback-only http carve-out, so the local Docker stack (which serves
    // http://localhost:3000) can issue and verify receipts. Without it the whole
    // feature would be untryable on the one setup the quickstart recommends.
    // Deliberately loopback ONLY: a routable http issuer would let anyone on the
    // path serve their own JWKS and forge every artifact we ever signed.
    if (url.protocol === "http:" && isLoopback(url.hostname)) return url.origin;
    return null;
  } catch {
    return null;
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}
