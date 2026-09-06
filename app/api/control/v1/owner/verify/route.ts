// POST /api/control/v1/owner/verify — run the control check now (write scope).
//
// Fetches the proof for whichever identifier was declared — the well-known
// document on a domain, or the public passcontrol-owner repository under a
// GitHub account — and looks for the token issued by PUT /owner. Success stamps
// the matching tier; failure counts, and only three consecutive failures demote
// a previously verified binding. One exception, in lib/owner/manage.ts: GitHub
// being unreachable spends no strike, because that is a CDN neither we nor the
// owner operates.
//
// Rate limited beyond the standard control-plane limits: this is the one
// control-plane endpoint that makes the gateway issue an outbound request to a
// host the caller chose, so it gets its own tighter budget.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { rateLimit } from "@/lib/ratelimit";
import { verifyOwnerControl } from "@/lib/owner/manage";
import { recordAdminAction } from "@/lib/audit";

const VERIFY_LIMIT = 10;
const VERIFY_WINDOW_S = 60 * 60;

const handler = control("write", async ({ userId, db, keyId, requestId }) => {
  const limit = await rateLimit(`owner-verify:${userId}`, VERIFY_LIMIT, VERIFY_WINDOW_S);
  if (!limit.success) return errorResponse(429, "rate_limited", requestId);

  const result = await verifyOwnerControl(db, userId);
  if (!result.ok) return errorResponse(result.status, result.code, requestId);

  await recordAdminAction({
    userId,
    action: "owner.verify",
    targetType: "owner",
    targetId: userId,
    metadata: { via: "api", key_id: keyId, verified: result.data.verified },
  });

  // `reason` is a fixed enum from lib/owner/domain.ts or lib/owner/github.ts,
  // never anything derived from the fetched document — see those headers for
  // why that matters.
  return jsonResponse(
    {
      data: {
        verified: result.data.verified,
        tier: result.data.owner.tier,
        ...(result.data.reason ? { reason: result.data.reason } : {}),
      },
    },
    requestId
  );
});

export function POST(req: Request): Promise<Response> {
  return handler(req);
}
