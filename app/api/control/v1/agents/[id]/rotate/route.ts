// POST /api/control/v1/agents/{id}/rotate — retire this passport's key and
// install a new one, keeping the agent (write scope).
//
// body: { passportPubkey: string, graceSeconds?: number, expiresAt?: string | null }
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

  let body: { passportPubkey?: unknown; graceSeconds?: unknown; expiresAt?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_json", requestId);
  }

  const grace = body.graceSeconds === undefined ? DEFAULT_GRACE_S : Number(body.graceSeconds);
  const r = await rotatePassport(
    db,
    userId,
    id,
    String(body.passportPubkey ?? ""),
    grace,
    body.expiresAt === undefined ? undefined : body.expiresAt === null ? null : String(body.expiresAt)
  );
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
    // Both keys are recorded, and both are public. The NEW one because an audit
    // row saying a key changed without saying to what is not much of an audit
    // row. The RETIRED one because this row is the only place it survives:
    // lib/reconcile.ts clears previous_passport_pubkey once the grace window
    // closes, and the public revocation list is built from this field — a
    // rotation recorded without it is a dead key no verifier can be told about.
    //
    // From fleet, never from the request: the submitted value is normalized
    // before it is stored, so echoing the request here would record a key that
    // is not on the row and cannot authenticate.
    metadata: {
      fields: "passport_pubkey",
      via: "api",
      key_id: keyId,
      rotated: true,
      from: r.value.previousPassportPubkey,
      to: r.value.passportPubkey,
      previous_valid_until: r.value.previousValidUntil,
      expires_at: r.value.expiresAt,
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
        expires_at: r.value.expiresAt,
        max_grace_seconds: MAX_ROTATION_GRACE_S,
      },
    },
    requestId
  );
});

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handler(req, ctx);
}
