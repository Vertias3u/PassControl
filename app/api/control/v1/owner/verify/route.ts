// POST /api/control/v1/owner/verify — run the domain check now (write scope).
//
// Fetches https://<subject>/.well-known/passcontrol-owner.txt and looks for the
// token issued by PUT /owner. Success stamps tier `domain`; failure counts, and
// only three consecutive failures demote a previously verified binding.
//
// Rate limited beyond the standard control-plane limits: this is the one
// control-plane endpoint that makes the gateway issue an outbound request to a
// host the caller chose, so it gets its own tighter budget.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { rateLimit } from "@/lib/ratelimit";
import { verifyOwnerDomain } from "@/lib/owner/manage";
import { recordAdminAction } from "@/lib/audit";

const VERIFY_LIMIT = 10;
const VERIFY_WINDOW_S = 60 * 60;

const handler = control("write", async ({ userId, db, keyId, requestId }) => {
  const limit = await rateLimit(`owner-verify:${userId}`, VERIFY_LIMIT, VERIFY_WINDOW_S);
  if (!limit.success) return errorResponse(429, "rate_limited", requestId);

  const result = await verifyOwnerDomain(db, userId);
  if (!result.ok) return errorResponse(result.status, result.code, requestId);

  await recordAdminAction({
    userId,
    action: "owner.verify",
    targetType: "owner",
    targetId: userId,
    metadata: { via: "api", key_id: keyId, verified: result.data.verified },
  });

  // `reason` is a fixed enum from lib/owner/domain.ts, never anything derived
  // from the fetched document — see that file's header for why that matters.
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
