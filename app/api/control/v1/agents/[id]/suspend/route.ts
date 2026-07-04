// POST /api/control/v1/agents/{id}/suspend — per-agent kill (write scope).
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { setAgentSuspended } from "@/lib/fleet";
import { recordAdminAction } from "@/lib/audit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const handler = control("write", async ({ userId, db, params, keyId, requestId }) => {
  const id = params.id ?? "";
  if (!UUID_RE.test(id)) return errorResponse(400, "invalid_id", requestId);

  const r = await setAgentSuspended(db, userId, id, true);
  if (!r.ok) return errorResponse(r.status, r.code, requestId);

  await recordAdminAction({
    userId,
    action: "agent.suspend",
    targetType: "agent",
    targetId: id,
    metadata: { suspended: true, via: "api", key_id: keyId },
  });
  return jsonResponse({ data: { id, status: "suspended" } }, requestId);
});

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handler(req, ctx);
}
