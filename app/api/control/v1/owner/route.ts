// /api/control/v1/owner — declare and publish who a tenant's passports belong to.
//
// GET  — the current binding (read scope).
// PUT  — declare a claim; always lands at tier `unverified` (write scope).
// PATCH — publish or unpublish an existing binding (write scope).
//
// A caller never sets `tier` or `verified_at`: they say what they claim, and
// lib/owner/manage.ts decides what was proven. See migration 0017.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { readJsonBody } from "@/lib/control/body";
import { readOwner, setOwner, setOwnerPublished } from "@/lib/owner/manage";
import { OWNER_WELL_KNOWN_PATH } from "@/lib/owner/domain";
import { recordAdminAction } from "@/lib/audit";

const getHandler = control("read", async ({ userId, db, requestId }) => {
  const result = await readOwner(db, userId);
  if (!result.ok) return errorResponse(result.status, result.code, requestId);
  return jsonResponse({ data: result.data }, requestId);
});

const putHandler = control("write", async ({ req, userId, db, keyId, requestId }) => {
  const body = await readJsonBody(req);
  if (!body.ok) return errorResponse(body.status, body.code, requestId);

  const result = await setOwner(db, userId, body.body as Record<string, unknown>);
  if (!result.ok) return errorResponse(result.status, result.code, requestId);

  await recordAdminAction({
    userId,
    action: "owner.set",
    targetType: "owner",
    targetId: userId,
    // The subject is what the owner asked us to publish, so it is not a secret —
    // but the verification token is, so it is never recorded here.
    metadata: { via: "api", key_id: keyId, kind: result.data.kind },
  });

  return jsonResponse(
    {
      data: result.data,
      // Tell them exactly what to do next rather than making them read docs.
      ...(result.data.kind === "domain"
        ? {
            instructions: {
              publish_at: `https://${result.data.subject}${OWNER_WELL_KNOWN_PATH}`,
              publish_line: result.data.verification_token,
              then: "POST /api/control/v1/owner/verify",
            },
          }
        : {}),
    },
    requestId
  );
});

const patchHandler = control("write", async ({ req, userId, db, keyId, requestId }) => {
  const body = await readJsonBody(req);
  if (!body.ok) return errorResponse(body.status, body.code, requestId);

  const published = (body.body as Record<string, unknown>)?.published;
  if (typeof published !== "boolean") return errorResponse(400, "invalid_published", requestId);

  const result = await setOwnerPublished(db, userId, published);
  if (!result.ok) return errorResponse(result.status, result.code, requestId);

  await recordAdminAction({
    userId,
    action: "owner.publish",
    targetType: "owner",
    targetId: userId,
    metadata: { via: "api", key_id: keyId, published },
  });

  return jsonResponse({ data: result.data }, requestId);
});

export function GET(req: Request): Promise<Response> {
  return getHandler(req);
}
export function PUT(req: Request): Promise<Response> {
  return putHandler(req);
}
export function PATCH(req: Request): Promise<Response> {
  return patchHandler(req);
}
