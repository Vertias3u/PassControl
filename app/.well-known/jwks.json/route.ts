import { loadInstanceVerifiers, publicJwk } from "@/lib/crypto/instanceKey";

export const runtime = "edge";

// Served at /.well-known/jwks.json (RFC 8615 + RFC 7517).
//
// This is the trust anchor for everything PassControl signs that someone else
// verifies: call receipts and agent-to-agent tokens. A third party fetches this
// once, matches `kid`, and can then verify our artifacts entirely OFFLINE — no
// callback, no account, no shared secret. That is the whole point: a receipt
// stays checkable after we are unreachable, and a self-hosted instance is its
// own issuer rather than depending on ours.
//
// A route-segment directory containing a dot works here — app/llms.txt/route.ts
// is the precedent. No next.config rewrite is needed.
//
// Only PUBLIC key material is ever assembled here; publicJwk() builds the JWK
// field by field from the public key and has no access to a seed.
const DEFAULT_MAX_AGE_SECONDS = 300;

function maxAgeSeconds(): number {
  const raw = Number(process.env.JWKS_MAX_AGE_SECONDS ?? DEFAULT_MAX_AGE_SECONDS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MAX_AGE_SECONDS;
  return Math.floor(raw);
}

export async function GET(): Promise<Response> {
  // An unconfigured deployment publishes an empty key set with 200. That is a
  // true and machine-readable statement; a 500 would read as an outage and
  // invite verifiers to retry against a deployment that is working as intended.
  const keys = loadInstanceVerifiers().map((verifier) => publicJwk(verifier.publicKey));

  return new Response(JSON.stringify({ keys }), {
    status: 200,
    headers: {
      "content-type": "application/jwk-set+json; charset=utf-8",
      "cache-control": `public, max-age=${maxAgeSeconds()}, stale-while-revalidate=86400`,
      // next.config.mjs sets Cross-Origin-Resource-Policy: same-origin globally,
      // which is right everywhere else and wrong for the one document other
      // deployments exist to read. Same for CORS: verification is a plain fetch.
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    },
  });
}
