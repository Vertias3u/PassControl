// POST /api/control/v1/agents/{id}/rotate — retire this passport's key and
// install a new one, keeping the agent (write scope).
//
// body: { passportPubkey: string, graceSeconds?: number }
//
// The gateway never sees the private half, and there is nothing here that could
// generate one: the caller creates the keypair on its own machine and sends the
// PUBLIC key. That is the whole product, and it is why this route takes a key
// rather than returning one.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { rotatePassport, MAX_ROTATION_GRACE_S } from "@/lib/fleet";
import { recordAdminAction } from "@/lib/audit";
import { dispatchSecurityAlert } from "@/lib/alert";
import { logSecurityEvent } from "@/lib/seclog";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An hour: long enough to redeploy a fleet, short enough not to be forgotten. */
const DEFAULT_GRACE_S = 3600;

const handler = control("write", async ({ userId, db, params, keyId, requestId, req }) => {
  const id = params.id ?? "";
  if (!UUID_RE.test(id)) return errorResponse(400, "invalid_id", requestId);

  let body: { passportPubkey?: unknown; graceSeconds?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_json", requestId);
  }

  const grace = body.graceSeconds === undefined ? DEFAULT_GRACE_S : Number(body.graceSeconds);
  const r = await rotatePassport(db, userId, id, String(body.passportPubkey ?? ""), grace);
  // The message comes from respond.ts MESSAGES, keyed by code — no library
  // string is reflected into a response.
  if (!r.ok) return errorResponse(r.status, r.code, requestId);

  // Rotation is exactly the class of event killswitch.master already alerts on:
  // it changes which key can speak for this agent. An operator who did not do it
  // needs to hear about it immediately, not at the next audit read.
  logSecurityEvent("agent.passport_rotate", { user: userId, agentId: id });
  await dispatchSecurityAlert("agent.passport_rotate", { user: userId, agentId: id });
  await recordAdminAction({
    userId,
    action: "agent.update",
    targetType: "agent",
    targetId: id,
    // The NEW public key is recorded — it is public, and an audit row saying a
    // key changed without saying to what is not much of an audit row. The
    // retired key is not repeated here; it is already on the row until the
    // sweep clears it, and this metadata is served by GET /audit.
    //
    // From fleet, never from the request: the submitted value is normalized
    // before it is stored, so echoing the request here would record a key that
    // is not on the row and cannot authenticate.
    metadata: {
      fields: "passport_pubkey",
      via: "api",
      key_id: keyId,
      rotated: true,
      to: r.value.passportPubkey,
      previous_valid_until: r.value.previousValidUntil,
    },
  });
  return jsonResponse(
    {
      data: {
        id,
        // The stored key, so a caller can compare what it sent with what now
        // authenticates instead of being handed its own input back.
        passport_pubkey: r.value.passportPubkey,
        previous_valid_until: r.value.previousValidUntil,
        max_grace_seconds: MAX_ROTATION_GRACE_S,
      },
    },
    requestId
  );
});

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handler(req, ctx);
}
