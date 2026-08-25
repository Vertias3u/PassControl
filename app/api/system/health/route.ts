// GET /api/system/health — process liveness, and nothing else.
//
// Anonymous infrastructure needs a stable answer to "is the application
// serving HTTP?" It must not learn whether Redis, Vault, Auth, or the migration
// ledger is healthy: those details expose both deployment posture and the fixes
// a database may be missing. Authenticated operator detail remains on the
// existing /dashboard/system and /api/control/v1/system surfaces.
//
// This route deliberately performs no dependency probe. A degraded dependency
// is a warning, never a reason for the health route itself to refuse service.
export const runtime = "edge";

export function GET(): Response {
  return Response.json(
    { status: "ok" },
    { headers: { "access-control-allow-origin": "*" } }
  );
}
