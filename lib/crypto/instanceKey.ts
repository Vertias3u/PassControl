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
import { base64urlToBytes, bytesToBase64url } from "../encoding";
import { jwkThumbprint } from "./ed25519";

export { jwkThumbprint } from "./ed25519";

const SEED_BYTES = 32;
const PUBLIC_KEY_BYTES = 32;

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
 * One retired PUBLIC key, written `<kid>:<x>`.
 *
 * The kid is redundant — it is derivable from x — and that redundancy is the
 * entire point. A seed and an Ed25519 public key are both 32 base64url bytes,
 * and every rotation instruction we ship trains the operator to paste a SEED
 * into a rotation variable. A history that accepted bare key material would
 * take a pasted seed, derive a kid from seed bytes, publish a key nothing has
 * ever signed with, and leave the receipts it was meant to preserve failing
 * exactly as before — silently, with the operator believing they were saved.
 * Requiring the pair means a seed fails structurally instead of publishing a
 * lie. `passcontrol keygen instance --retire <seed>` prints the pair.
 *
 * Returns null on anything malformed. One bad entry must never take the key
 * set down with it: the current key going missing is a total outage, and a
 * history list is exactly the kind of long append-only value that acquires a
 * stray comma at 2am.
 */
function decodeHistoryEntry(raw: string): InstanceVerifier | null {
  const sep = raw.indexOf(":");
  if (sep <= 0) return null;
  const kid = raw.slice(0, sep).trim();
  const x = raw.slice(sep + 1).trim();
  if (!kid || !x) return null;
  try {
    const publicKey = base64urlToBytes(x.replace(/\+/g, "-").replace(/\//g, "_"));
    if (publicKey.length !== PUBLIC_KEY_BYTES) return null;
    // Recomputed, not trusted. This is the check that catches a pasted seed.
    return publicJwk(publicKey).kid === kid ? { publicKey, kid } : null;
  } catch {
    return null;
  }
}

// Same reasoning as the signer cache: keyed on the raw string so an appended
// entry is picked up without a restart. The JWKS route is edge and this is a
// per-request path, so recomputing N thumbprints each time is worth avoiding.
let historyCache: { raw: string; verifiers: InstanceVerifier[] } | null = null;

function loadHistoryVerifiers(): InstanceVerifier[] {
  const raw = process.env.INSTANCE_SIGNING_KEY_HISTORY;
  if (!raw) return [];
  if (historyCache && historyCache.raw === raw) return historyCache.verifiers;
  const verifiers = raw
    .split(/[\s,]+/)
    .map((entry) => decodeHistoryEntry(entry))
    .filter((v): v is InstanceVerifier => v !== null);
  historyCache = { raw, verifiers };
  return verifiers;
}

/**
 * Every public key that should appear in the JWKS: the current one, the
 * previous one while a rotation is in flight, and every key retired before
 * that.
 *
 * NOTE the semantics are the INVERSE of VISA_SECRET_PREV. For the symmetric
 * visa secret, _PREV means "still accept this on verify". Here we never sign
 * with anything but the current key — we keep publishing old public halves so
 * artifacts signed before a rotation still verify. Receipts carry no exp, so
 * once anything has been signed with a key its entry is permanent.
 *
 * "Permanent" is what `_PREV` alone could not deliver, and that gap is the bug
 * this shape closes. One scalar holds one generation: A→B keeps A, and the
 * next rotation B→C has nowhere to put A. Every receipt signed under A then
 * leaves the key set at once, and the public verifier reports the `kid` it can
 * no longer find — which reads to a stranger as an accusation rather than as a
 * retired key. `_HISTORY` is the durable half and takes PUBLIC keys only: a
 * retired private seed left sitting in configuration can mint new receipts
 * backdated under the old kid, so history that stored seeds would trade one
 * truth defect for a worse one.
 */
export function loadInstanceVerifiers(): InstanceVerifier[] {
  const out: InstanceVerifier[] = [];
  const push = (verifier: InstanceVerifier) => {
    // A key named in two places — the in-flight _PREV that has also, correctly,
    // been appended to the permanent history — is published once. A duplicate
    // kid in a JWKS is the kind of thing a strict verifier rejects outright.
    if (!out.some((v) => v.kid === verifier.kid)) out.push(verifier);
  };

  const current = loadInstanceSigner();
  if (current) push({ publicKey: current.publicKey, kid: current.kid });

  const prevSeed = decodeSeed(process.env.INSTANCE_SIGNING_KEY_PREV);
  if (prevSeed) {
    const prev = toSigner(prevSeed);
    push({ publicKey: prev.publicKey, kid: prev.kid });
  }

  for (const retired of loadHistoryVerifiers()) push(retired);
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
