// GET /api/control/v1/agents/{id} — fetch one of the caller's agents (read scope).
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { AGENT_COLS } from "@/lib/control/columns";
import { revokeAgent, updateAgent } from "@/lib/fleet";
import { readJsonBody } from "@/lib/control/body";
import { recordAdminAction } from "@/lib/audit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const handler = control("read", async ({ userId, db, params, requestId }) => {
  const id = params.id ?? "";
  if (!UUID_RE.test(id)) return errorResponse(400, "invalid_id", requestId);

  const { data, error } = await db
    .from("agents")
    .select(AGENT_COLS)
    .eq("user_id", userId) // tenant boundary
    .eq("id", id)
    .maybeSingle();
  if (error) return errorResponse(500, "query_failed", requestId);
  if (!data) return errorResponse(404, "not_found", requestId);
  return jsonResponse({ data }, requestId);
});

// Exact Next route signature (dynamic segment), delegating to the wrapper.
export function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handler(req, ctx);
}

// DELETE = revoke (terminal). Write scope.
const deleteHandler = control("write", async ({ userId, db, params, keyId, requestId }) => {
  const id = params.id ?? "";
  if (!UUID_RE.test(id)) return errorResponse(400, "invalid_id", requestId);

  const r = await revokeAgent(db, userId, id);
  if (!r.ok) return errorResponse(r.status, r.code, requestId);

  await recordAdminAction({
    userId,
    action: "agent.revoke",
    targetType: "agent",
    targetId: id,
    metadata: { via: "api", key_id: keyId },
  });
  return jsonResponse({ data: { id, status: "revoked" } }, requestId);
});

export function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return deleteHandler(req, ctx);
}

// PATCH = update name / scopes / budgets (partial). Write scope.
const patchHandler = control("write", async ({ req, userId, db, params, keyId, requestId }) => {
  const id = params.id ?? "";
  if (!UUID_RE.test(id)) return errorResponse(400, "invalid_id", requestId);

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return errorResponse(parsed.status, parsed.code, requestId);

  const r = await updateAgent(db, userId, id, parsed.body);
  if (!r.ok) return errorResponse(r.status, r.code, requestId);

  await recordAdminAction({
    userId,
    action: "agent.update",
    targetType: "agent",
    targetId: id,
    metadata: { fields: Object.keys(parsed.body ?? {}).join(","), via: "api", key_id: keyId },
  });
  return jsonResponse({ data: { id } }, requestId);
});

export function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return patchHandler(req, ctx);
}
