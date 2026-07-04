// GET /api/control/v1/kill-switch — current per-tenant kill state (read scope).
// Reads Redis kill state scoped to the caller's userId (no cross-tenant access possible).
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { readKillState } from "@/lib/state/killswitch";
import { readJsonBody } from "@/lib/control/body";
import { setTenantKill } from "@/lib/fleet";
import { recordAdminAction } from "@/lib/audit";

const handler = control("read", async ({ userId, requestId }) => {
  const kill = await readKillState(userId);
  return jsonResponse({ data: { armed: kill.userKill, platform_kill: kill.platformKill } }, requestId);
});

export function GET(req: Request): Promise<Response> {
  return handler(req);
}

// PUT { "armed": boolean } — arm/disarm the per-tenant master kill (write scope).
const putHandler = control("write", async ({ req, userId, db, keyId, requestId }) => {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return errorResponse(parsed.status, parsed.code, requestId);
  const on = parsed.body?.armed;
  if (typeof on !== "boolean") return errorResponse(422, "invalid_request", requestId);

  const r = await setTenantKill(db, userId, on);
  if (!r.ok) return errorResponse(r.status, r.code, requestId);

  await recordAdminAction({
    userId,
    action: "killswitch.master",
    metadata: { on, via: "api", key_id: keyId, affected: r.value.affected },
  });
  return jsonResponse({ data: { armed: on, affected: r.value.affected } }, requestId);
});

export function PUT(req: Request): Promise<Response> {
  return putHandler(req);
}
