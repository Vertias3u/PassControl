// GET /api/control/v1/account — the account behind the caller's control key.
//
// The key lookup already established the tenant identity. This endpoint accepts
// no user id and asks Auth Admin for exactly that authenticated id, so it cannot
// become an account-directory or cross-tenant lookup surface.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { errorResponse, jsonResponse } from "@/lib/control/respond";

const handler = control("read", async ({ userId, scope, db, requestId }) => {
  const { data, error } = await db.auth.admin.getUserById(userId);
  if (error || !data?.user || data.user.id !== userId) {
    return errorResponse(503, "account_unavailable", requestId);
  }

  return jsonResponse(
    {
      data: {
        email: typeof data.user.email === "string" ? data.user.email : null,
        control_key_scope: scope,
      },
    },
    requestId
  );
});

export function GET(req: Request): Promise<Response> {
  return handler(req);
}
