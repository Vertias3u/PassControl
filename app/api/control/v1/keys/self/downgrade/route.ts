// POST /api/control/v1/keys/self/downgrade — make the control key that
// authenticated this request read-only. Like /keys/self/revoke, it takes no key id:
// possession grants authority over this key and no other one. There is no route the
// other way; write scope is only ever minted (Settings, or a browser-approved login).
//
// Why it exists (review C-01, 2026-11-15): `passcontrol login` saves its key in the
// same file as the agent's passport, where the governed agent can read it. Login now
// lowers that key to read before saving it, so what the agent can find on disk can
// look but not act: it cannot lift a stop, resume, change limits or create agents.
// A write command asks for a one-command key, approved in the browser, instead.
export const runtime = "edge";

import { recordAdminAction } from "@/lib/audit";
import { control } from "@/lib/control/handler";
import { errorResponse, jsonResponse } from "@/lib/control/respond";

// Read: lowering a key's own authority needs no more than holding the key.
const handler = control("read", async ({ userId, keyId, db, requestId }) => {
  const { data, error } = await db
    .from("api_keys")
    .update({ scope: "read" })
    .eq("user_id", userId) // tenant boundary: the service-role client bypasses RLS
    .eq("id", keyId)
    .is("revoked_at", null)
    .select("scope, key_prefix")
    .maybeSingle();

  if (error) return errorResponse(500, "query_failed", requestId);
  if (!data) {
    // As /keys/self/revoke: missing and revoked are told apart only inside this tenant.
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
    action: "apikey.downgrade",
    targetType: "api_key",
    targetId: keyId,
    metadata: { prefix: data.key_prefix, via: "api" },
  });

  return jsonResponse({ data: { scope: "read", prefix: data.key_prefix } }, requestId);
});

export function POST(req: Request): Promise<Response> {
  return handler(req);
}
