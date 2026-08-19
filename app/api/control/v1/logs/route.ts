// GET /api/control/v1/logs — gateway call logs (read scope). Tenant-scoped by userId.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { LOG_COLS } from "@/lib/control/columns";
import { clampLimit } from "@/lib/control/params";
import { isHousekeeping, isInference } from "@/lib/call-class";

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

  // `class` is additive and the default is unchanged: with no parameter this
  // endpoint returns every row exactly as it always has. Narrowing the default
  // would be a silent contract change for anything already reading it, and this
  // endpoint's job is the complete record.
  //
  // Filtered in code rather than in the query because the classification is
  // derived, not stored (see lib/call-class.ts) — there is no column to filter
  // on, and the alternative would be a column that could never be backfilled.
  // The rows are already bounded by `limit`.
  const rows = data ?? [];
  const requested = url.searchParams.get("class");
  const filtered =
    requested === "inference"
      ? rows.filter(isInference)
      : requested === "housekeeping"
        ? rows.filter(isHousekeeping)
        : rows;

  return jsonResponse({ data: filtered }, requestId);
});

export function GET(req: Request): Promise<Response> {
  return handler(req);
}
