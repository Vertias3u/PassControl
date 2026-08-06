// GET /api/verify/{passportId} — PAVP, machine-readable.
//
// The same question and the same answer as /verify/<id>, in JSON instead of
// HTML. It exists because verification became something software does: an agent
// token verifier (Phase 3) checks signatures entirely offline against the
// issuer's JWKS, but a verifier that wants LIVE revocation state — "is this
// passport still active right now?" — needs somewhere to ask.
//
// It reuses lookupPublicPassport unchanged, so the readable surface, the shape
// checks, the per-IP rate limit and the outage semantics are all shared with the
// page. There is deliberately no second code path to keep in sync, and no new
// public surface: the body is exactly PUBLIC_PASSPORT_FIELDS.
//
// Being under /api/ means the middleware matcher already excludes it and
// next.config.mjs already applies no-store — both correct for a liveness check.
export const runtime = "edge";

import { serviceClient } from "@/lib/supabase";
import { lookupPublicPassport } from "@/lib/verify/passport";

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Verification is something other deployments do, from their own servers.
      "access-control-allow-origin": "*",
      ...extra,
    },
  });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ passportId: string }> }
): Promise<Response> {
  // Next has already percent-decoded this segment; decoding again throws
  // URIError on input like `100%2525`. Same trap the page documents.
  const { passportId } = await ctx.params;

  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const clientIp =
    forwarded.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";

  const result = await lookupPublicPassport(serviceClient(), passportId ?? "", clientIp);

  if (result.ok) return json({ data: result.passport }, 200);

  if (result.reason === "throttled") {
    return json({ error: { code: "rate_limited" } }, 429, { "retry-after": "60" });
  }
  // 503, never 404, on an outage. Answering "no such passport" when the database
  // is unreachable is a false statement about someone's identity — and a
  // machine consumer is far more likely than a human to act on it.
  if (result.reason === "unavailable") {
    return json({ error: { code: "verification_unavailable" } }, 503);
  }
  return json({ error: { code: "not_found" } }, 404);
}
