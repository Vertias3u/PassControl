// GET /api/control/v1/agents — list the caller's agents (read scope).
// Tenant isolation: service-role bypasses RLS, so the query is scoped by userId.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { AGENT_COLS } from "@/lib/control/columns";
import { readJsonBody } from "@/lib/control/body";
import { createAgent } from "@/lib/fleet";
import { recordAdminAction } from "@/lib/audit";

const handler = control("read", async ({ req, userId, db, requestId }) => {
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);

  let q = db
    .from("agents")
    .select(AGENT_COLS)
    .eq("user_id", userId) // tenant boundary
    .order("created_at", { ascending: false })
    .limit(limit);
  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) return errorResponse(500, "query_failed", requestId);
  return jsonResponse({ data: data ?? [] }, requestId);
});

// Collection route (no dynamic segment): Next accepts a single-arg handler.
export function GET(req: Request): Promise<Response> {
  return handler(req);
}

const postHandler = control("write", async ({ req, userId, db, keyId, requestId }) => {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return errorResponse(parsed.status, parsed.code, requestId);

  const r = await createAgent(db, userId, parsed.body);
  if (!r.ok) return errorResponse(r.status, r.code, requestId);

  await recordAdminAction({
    userId,
    action: "agent.create",
    targetType: "agent",
    targetId: r.value.id,
    metadata: { name: r.value.name, via: "api", key_id: keyId },
  });
  return jsonResponse({ data: { id: r.value.id, name: r.value.name } }, requestId, 201);
});

export function POST(req: Request): Promise<Response> {
  return postHandler(req);
}
