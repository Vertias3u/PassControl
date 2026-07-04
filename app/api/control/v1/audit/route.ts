// GET /api/control/v1/audit — admin-action audit trail (read scope). Tenant-scoped.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { AUDIT_COLS } from "@/lib/control/columns";
import { clampLimit } from "@/lib/control/params";

const handler = control("read", async ({ req, userId, db, requestId }) => {
  const limit = clampLimit(new URL(req.url).searchParams.get("limit"));

  const { data, error } = await db
    .from("admin_audit")
    .select(AUDIT_COLS)
    .eq("user_id", userId) // tenant boundary
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return errorResponse(500, "query_failed", requestId);
  return jsonResponse({ data: data ?? [] }, requestId);
});

export function GET(req: Request): Promise<Response> {
  return handler(req);
}
