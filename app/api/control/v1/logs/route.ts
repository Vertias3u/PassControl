// GET /api/control/v1/logs — gateway call logs (read scope). Tenant-scoped by userId.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { LOG_COLS } from "@/lib/control/columns";
import { clampLimit } from "@/lib/control/params";

const handler = control("read", async ({ req, userId, db, requestId }) => {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agent_id");
  const status = url.searchParams.get("status");
  const limit = clampLimit(url.searchParams.get("limit"));

  let q = db
    .from("agent_logs")
    .select(LOG_COLS)
    .eq("user_id", userId) // tenant boundary
    .order("created_at", { ascending: false })
    .limit(limit);
  if (agentId) q = q.eq("agent_id", agentId);
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) return errorResponse(500, "query_failed", requestId);
  return jsonResponse({ data: data ?? [] }, requestId);
});

export function GET(req: Request): Promise<Response> {
  return handler(req);
}
