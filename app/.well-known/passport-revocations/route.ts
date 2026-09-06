import { loadInstanceSigner, instanceIssuer } from "@/lib/crypto/instanceKey";
import { signCompactJws } from "@/lib/crypto/jws";
import { serviceClient } from "@/lib/supabase";
import {
  REVOCATION_LIST_TYP,
  buildRevocationListClaims,
  loadRevocationEntries,
} from "@/lib/revocation-list";

export const runtime = "edge";
export const dynamic = "force-dynamic";

// Served at /.well-known/passport-revocations, beside /.well-known/jwks.json.
//
// Those two documents are one mechanism. JWKS lets a stranger verify that we
// signed a receipt; this lets them check that the passport inside it was still
// good at the time. Fetch both once and every receipt this instance has ever
// issued becomes checkable offline, after we are unreachable, with no account
// and no shared secret.
//
// A compact JWS, not JSON, and signed with the same instance key as receipts —
// one signing path, and `typ` is REVOCATION_LIST_TYP so a revocation list can
// never be verified as a receipt or vice versa. The `iat` inside the signature
// is what stops an old copy being replayed to hide a later revocation.
//
// What is IN it, and what is deliberately not, is decided by monotonicity and
// documented in lib/revocation-list.ts. The short version: only permanent
// deaths, so an entry is never withdrawn; suspension and kill state are never
// published.
const DEFAULT_MAX_AGE_SECONDS = 300;

function maxAgeSeconds(): number {
  const raw = Number(process.env.REVOCATION_LIST_MAX_AGE_SECONDS ?? DEFAULT_MAX_AGE_SECONDS);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_MAX_AGE_SECONDS;
  return Math.floor(raw);
}

/**
 * 503, never an empty list.
 *
 * This is the same rule /api/verify follows for an unreachable database, and it
 * matters more here: an empty revocation list is not "we cannot say", it is the
 * positive claim "nothing has been revoked". Serving that during an outage — or
 * from an instance with no signing key — would tell a verifier that a passport
 * we know to be dead is fine. An error makes them ask again; a false answer
 * makes them stop asking.
 */
function errorResponse(status: number, code: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code } }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      ...extra,
    },
  });
}

const unavailable = (code: string) => errorResponse(503, code);

export async function GET(req: Request): Promise<Response> {
  const signer = loadInstanceSigner();
  const issuer = instanceIssuer();
  // An unsigned revocation list is worthless — anyone could serve one omitting
  // the entry that matters — so an instance that cannot sign says so rather
  // than publishing a document nobody should trust. Checked before the read so
  // an instance that can never answer costs the database nothing.
  if (!signer || !issuer) return unavailable("signing_not_configured");

  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const clientIp =
    forwarded.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";

  const list = await loadRevocationEntries(serviceClient(), clientIp);
  // 429 rather than 503: "ask again in a minute" and "this instance cannot
  // answer" are different instructions to a machine, and neither is an empty
  // list. The limiter lives inside the loader, so this route cannot skip it.
  if (!list.ok) {
    return list.reason === "throttled"
      ? errorResponse(429, "rate_limited", { "retry-after": "60" })
      : unavailable("revocation_list_unavailable");
  }
  const entries = list.entries;

  const jws = signCompactJws({
    typ: REVOCATION_LIST_TYP,
    kid: signer.kid,
    claims: buildRevocationListClaims({ issuer, entries }),
    seed: signer.seed,
  });

  return new Response(jws, {
    status: 200,
    headers: {
      "content-type": "application/jose",
      // Short, and with a short stale window. JWKS can afford a day of
      // stale-while-revalidate because keys change on a human timescale; a
      // revocation an operator just made should reach verifiers in minutes.
      "cache-control": `public, max-age=${maxAgeSeconds()}, stale-while-revalidate=600`,
      // next.config.mjs sets Cross-Origin-Resource-Policy: same-origin globally,
      // which is right everywhere else and wrong for a document other
      // deployments exist to read. Verification is a plain cross-origin fetch.
      "cross-origin-resource-policy": "cross-origin",
      "access-control-allow-origin": "*",
    },
  });
}
