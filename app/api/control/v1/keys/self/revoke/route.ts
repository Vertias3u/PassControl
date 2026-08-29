// POST /api/control/v1/keys/self/revoke — revoke the control key that
// authenticated this request. There is deliberately no key id in the request:
// possession grants authority over this key and no other one.
export const runtime = "edge";

import { recordAdminAction } from "@/lib/audit";
import { control } from "@/lib/control/handler";
import { errorResponse, jsonResponse } from "@/lib/control/respond";

const handler = control("write", async ({ userId, keyId, db, requestId }) => {
  const revokedAt = new Date().toISOString();
  const { data, error } = await db
    .from("api_keys")
    .update({ revoked_at: revokedAt })
    .eq("user_id", userId) // tenant boundary: the service-role client bypasses RLS
    .eq("id", keyId)
    .is("revoked_at", null)
    .select("revoked_at, key_prefix")
    .maybeSingle();

  if (error) return errorResponse(500, "query_failed", requestId);
  if (!data) {
    // The guarded update intentionally conflates missing and already revoked.
    // Resolve that ambiguity without ever looking outside the authenticated
    // tenant, so another tenant's id remains indistinguishable from absence.
    const { data: existing, error: lookupError } = await db
      .from("api_keys")
      .select("id, revoked_at")
      .eq("user_id", userId) // tenant boundary
      .eq("id", keyId)
      .maybeSingle();
    if (lookupError) return errorResponse(500, "query_failed", requestId);
    if (!existing) return errorResponse(404, "not_found", requestId);
    return errorResponse(409, "already_revoked", requestId);
  }

  await recordAdminAction({
    userId,
    action: "apikey.revoke",
    targetType: "api_key",
    targetId: keyId,
    metadata: { prefix: data.key_prefix, via: "api" },
  });

  return jsonResponse(
    { data: { revoked_at: data.revoked_at, prefix: data.key_prefix } },
    requestId
  );
});

export function POST(req: Request): Promise<Response> {
  return handler(req);
}
