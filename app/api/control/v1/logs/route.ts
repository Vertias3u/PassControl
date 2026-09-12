// GET /api/control/v1/logs — gateway call logs (read scope). Tenant-scoped by userId.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { LOG_COLS } from "@/lib/control/columns";
import { clampLimit } from "@/lib/control/params";
import { isHousekeeping, isInference } from "@/lib/call-class";
import { base64urlToBytes, bytesToUtf8, jsonToBase64url } from "@/lib/encoding";

function decodeCursor(value: string | null): { created_at: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(bytesToUtf8(base64urlToBytes(value)));
    if (
      typeof parsed?.created_at !== "string" ||
      !Number.isFinite(Date.parse(parsed.created_at)) ||
      typeof parsed?.id !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(parsed.id)
    ) return null;
    return { created_at: new Date(parsed.created_at).toISOString(), id: parsed.id };
  } catch {
    return null;
  }
}

const handler = control("read", async ({ req, userId, db, requestId }) => {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agent_id");
  const status = url.searchParams.get("status");
  const limit = clampLimit(url.searchParams.get("limit"));
  const rawCursor = url.searchParams.get("cursor");
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) return errorResponse(400, "invalid_cursor", requestId);

  let q = db
    .from("agent_logs")
    .select(LOG_COLS)
    .eq("user_id", userId) // tenant boundary
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (agentId) q = q.eq("agent_id", agentId);
  if (status) q = q.eq("status", status);
  if (cursor) {
    q = q.or(
      `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`
    );
  }

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
  const allRows = data ?? [];
  const hasMore = allRows.length > limit;
  const rows = allRows.slice(0, limit);
  const requested = url.searchParams.get("class");
  const filtered =
    requested === "inference"
      ? rows.filter(isInference)
      : requested === "housekeeping"
        ? rows.filter(isHousekeeping)
        : rows;

  const last = rows.at(-1);
  const nextCursor = hasMore && last?.created_at && last?.id
    ? jsonToBase64url({ created_at: last.created_at, id: last.id })
    : null;
  return jsonResponse({ data: filtered, next_cursor: nextCursor }, requestId);
});

export function GET(req: Request): Promise<Response> {
  return handler(req);
}
