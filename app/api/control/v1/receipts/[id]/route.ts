// GET /api/control/v1/receipts/{id} — one call and its signed receipt (read scope).
//
// Why this is authenticated rather than public.
//
// The receipt itself is designed to be handed to a stranger: it verifies
// OFFLINE against /.well-known/jwks.json, so whoever receives it needs nothing
// from us. But the OWNER decides who receives it. A public endpoint keyed on a
// call id would make every call's provider, model, verdict and cost readable to
// anyone who guessed or scraped an id, which is exactly what migration 0015
// refused to do for the public passport page ("traffic history is private,
// always"). Bearer artifact, private retrieval — the same posture as PAVP.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { RECEIPT_COLS } from "@/lib/control/columns";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const handler = control("read", async ({ userId, db, params, requestId }) => {
  const id = params.id ?? "";
  if (!UUID_RE.test(id)) return errorResponse(400, "invalid_id", requestId);

  const { data, error } = await db
    .from("agent_logs")
    .select(RECEIPT_COLS)
    .eq("user_id", userId) // tenant boundary — service_role bypasses RLS
    .eq("id", id)
    .maybeSingle();
  if (error) return errorResponse(500, "query_failed", requestId);
  // 404 rather than 403 for another tenant's id: a 403 would confirm the id
  // exists, turning this into a cross-tenant existence oracle.
  if (!data) return errorResponse(404, "not_found", requestId);

  const row = data as Record<string, unknown>;
  return jsonResponse(
    {
      data: {
        ...row,
        // An explicit reason beats a bare null. The overwhelmingly likely cause
        // is that the deployment has no INSTANCE_SIGNING_KEY, which is a
        // configuration answer, not a missing-data answer.
        ...(row.receipt ? {} : { reason: "receipts_not_enabled" }),
      },
    },
    requestId
  );
});

export function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handler(req, ctx);
}
