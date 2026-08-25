// GET /api/version — which build is answering, and nothing else.
//
// Unauthenticated on purpose, and it discloses nothing new: RELEASE_VERSION is
// already rendered in the site footer, in the JSON-LD `softwareVersion`, and in
// /llms.txt. What it adds is a machine-readable answer, so `passcontrol version`
// can tell an operator that their CLI and the gateway they are pointed at are
// different builds — the single most common cause of "this worked yesterday".
//
// ── What is deliberately NOT here ───────────────────────────────────────────
//
// The migration state. How far behind a deployment's database is doubles as a
// list of which fixes it does not have yet, which is exactly the sort of thing
// an unauthenticated endpoint must not volunteer. That lives on
// /api/control/v1/system, behind the operator gate that already exists for it.
//
// Under /api/, so next.config.mjs already applies no-store and the middleware
// matcher already excludes it — no cookie round trip on a document meant to be
// cheap to fetch.
export const runtime = "edge";

import { RELEASE_VERSION } from "@/lib/version";

export function GET(): Response {
  return Response.json(
    { version: RELEASE_VERSION },
    {
      headers: {
        // Verification and version probes are things other deployments do from
        // their own servers, same as /api/verify/[passportId].
        "access-control-allow-origin": "*",
      },
    }
  );
}
