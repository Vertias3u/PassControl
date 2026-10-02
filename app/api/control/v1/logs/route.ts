// GET /api/control/v1/logs — gateway call logs (read scope). Tenant-scoped by userId.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { LOG_COLS, LOG_COLS_WITH_SERVICE } from "@/lib/control/columns";
import { clampLimit } from "@/lib/control/params";
import { classifyCall, isHousekeeping, isInference, type ClassifiableCall } from "@/lib/call-class";
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

type LogRow = ClassifiableCall & { id?: string; created_at?: string } & Record<string, unknown>;

const handler = control("read", async ({ req, userId, db, requestId }) => {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agent_id");
  const status = url.searchParams.get("status");
  const limit = clampLimit(url.searchParams.get("limit"));
  const rawCursor = url.searchParams.get("cursor");
  const cursor = decodeCursor(rawCursor);
  if (rawCursor && !cursor) return errorResponse(400, "invalid_cursor", requestId);

  const query = (columns: string) => {
    let q = db
      .from("agent_logs")
      .select(columns)
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
    return q;
  };

  // A database without 0074 refuses a select naming call_kind/endpoint
  // (42703). Such a database has no service calls to describe, so the record
  // is complete without them; `class=service` still finds any by provider.
  // Typed by hand: a column list chosen at run time defeats the client's
  // select-string inference.
  type Read = { data: LogRow[] | null; error: { code?: string } | null };
  let { data, error } = (await query(LOG_COLS_WITH_SERVICE)) as unknown as Read;
  if (error?.code === "42703") ({ data, error } = (await query(LOG_COLS)) as unknown as Read);
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
        : requested === "service"
          ? rows.filter((row) => classifyCall(row).klass === "service")
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
