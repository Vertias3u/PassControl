// GET /api/control/v1/system — restricted, read-only instance diagnostics.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { errorResponse, jsonResponse } from "@/lib/control/respond";
import { getSystemHealthSnapshot } from "@/lib/system-health";
import { systemOperatorForControl } from "@/lib/system-health/operator";
import type { SystemOperatorReason } from "@/lib/system-health/operator";

const REFUSALS: Partial<Record<SystemOperatorReason, string>> = {
  enrollment_required: "system_totp_required",
  not_configured: "system_not_configured",
  misconfigured: "system_allowlist_invalid",
};

const handler = control("read", async ({ userId, db, requestId }) => {
  // Do not use the cookie/session gate here. A headless API key is authorized by
  // the key owner's Auth-admin identity and verified TOTP enrollment instead.
  const operator = await systemOperatorForControl(db, userId);
  if (!operator.ok) {
    // Still one status and still no access; only the code differs, so an
    // operator can tell "this key is not allowed" from "this instance allows
    // nobody" instead of debugging one opaque 403 for four different causes.
    return errorResponse(403, REFUSALS[operator.reason] ?? "system_forbidden", requestId);
  }
  return jsonResponse(await getSystemHealthSnapshot(), requestId);
});

export function GET(req: Request): Promise<Response> {
  return handler(req);
}
