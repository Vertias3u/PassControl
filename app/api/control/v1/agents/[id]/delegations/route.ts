// GET /api/control/v1/agents/{id}/delegations — the delegations the gateway has seen
// workers exchange for this agent, newest first, each marked revoked or not (read scope).
// Bet D; plans/delegation-design.md §9.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { listDelegations } from "@/lib/delegation/manage";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const handler = control("read", async ({ userId, db, params, requestId }) => {
  const id = params.id ?? "";
  if (!UUID_RE.test(id)) return errorResponse(400, "invalid_id", requestId);
  const r = await listDelegations(db as never, userId, id);
  if (!r.ok) return errorResponse(r.status, r.code, requestId);
  return jsonResponse({ data: r.delegations }, requestId);
});

export function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handler(req, ctx);
}
