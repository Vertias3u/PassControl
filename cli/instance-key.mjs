// Operator-side helpers for the deployment's Ed25519 signing key.
//
// The app half lives in lib/crypto/instanceKey.ts. This is the plain-ESM twin
// the CLI uses to GENERATE a key and to check that a running deployment
// actually publishes it. The kid derivation is duplicated rather than imported
// because the shipped CLI is deliberately transpilation-free — so
// cli/__tests__/instance-key.test.mjs pins the two derivations to agree.
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromB64url = (value) =>
  new Uint8Array(Buffer.from(String(value).replace(/-/g, "+").replace(/_/g, "/"), "base64"));

/** RFC 7638 JWK thumbprint — the same value the app publishes as `kid`. */
export function instanceKidFromSeed(seed) {
  const publicKey = ed25519.getPublicKey(fromB64url(seed));
  const x = b64url(publicKey);
  return b64url(sha256(new TextEncoder().encode(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`)));
}

/** Generate a fresh instance signing key. The seed is printed once, never stored. */
export function generateInstanceKey() {
  const seed = b64url(ed25519.utils.randomPrivateKey());
  return { seed, kid: instanceKidFromSeed(seed) };
}

/**
 * Turn a retiring SEED into the `<kid>:<x>` pair that goes in
 * INSTANCE_SIGNING_KEY_HISTORY — public half only, so a retired key can never
 * sign again.
 *
 * This exists because the operator cannot derive a public key by hand. Without
 * it they would paste the seed, which is also 32 base64url bytes and would sail
 * through any length check; the app rejects that pair because the kid does not
 * recompute, but "rejected" only helps if there is a right value to type
 * instead. Throws on anything that is not a 32-byte seed.
 */
export function retiredKeyEntry(seed) {
  const bytes = fromB64url(seed);
  if (bytes.length !== 32) throw new Error("A signing seed is 32 bytes, base64url-encoded.");
  const x = b64url(ed25519.getPublicKey(bytes));
  return { entry: `${instanceKidFromSeed(seed)}:${x}`, kid: instanceKidFromSeed(seed) };
}

/**
 * Verify that PASSCONTROL_ISSUER resolves to a deployment publishing OUR key.
 *
 * A missing signing key is loud — nothing gets signed. The quiet failure is an
 * issuer pointing at a host that serves a different key set (or none): every
 * receipt then carries an `iss` whose JWKS cannot verify it, so third-party
 * verification fails universally while the gateway itself looks perfectly
 * healthy. This is the check that makes a self-hosted deployment debuggable
 * without reading someone else's logs.
 */
export async function checkIssuerPublishesKey({ issuer, kid, fetch: fetchImpl = fetch }) {
  const url = new URL("/.well-known/jwks.json", issuer).toString();
  let payload;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return { ok: false, reason: `${url} responded ${res.status}` };
    payload = await res.json();
  } catch (error) {
    return { ok: false, reason: `${url} is unreachable (${error.message})` };
  }

  const keys = Array.isArray(payload?.keys) ? payload.keys : [];
  if (keys.length === 0) return { ok: false, reason: `${url} publishes no keys` };
  if (!keys.some((key) => key?.kid === kid)) {
    return {
      ok: false,
      reason: `${url} does not publish the key this deployment signs with (${kid})`,
    };
  }
  return { ok: true, reason: `${url} publishes ${kid}` };
}
