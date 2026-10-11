// POST /api/control/v1/agents/{id}/delegations/revoke — kill a worker's delegation
// (write scope). Bet D; plans/delegation-design.md §9.
//
// body: { jti: string }  one delegation link, and everything delegated under it
//    or: { all: true }   every delegation this agent issued before now, seen or not
//
// Permanent: a revocation is never withdrawn (0081). To let a worker go on, the agent
// delegates to it again. The agent itself is untouched; suspend it to stop it too.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { delegationRevokeMetadata, revokeAgentDelegation, revokeAllAgentDelegations } from "@/lib/delegation/manage";
import { recordAdminAction } from "@/lib/audit";
import { dispatchSecurityAlert } from "@/lib/alert";
import { logSecurityEvent } from "@/lib/seclog";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const handler = control("write", async ({ userId, db, params, keyId, requestId, req }) => {
  const id = params.id ?? "";
  if (!UUID_RE.test(id)) return errorResponse(400, "invalid_id", requestId);
  let body: { jti?: unknown; all?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_json", requestId);
  }
  const all = body.all === true;
  if (all === (typeof body.jti === "string")) return errorResponse(400, "invalid_delegation_revoke", requestId);

  let immediate: boolean;
  let metadata: Record<string, unknown>;
  if (all) {
    const r = await revokeAllAgentDelegations(db as never, userId, id);
    if (!r.ok) return errorResponse(r.status, r.code, requestId);
    immediate = r.immediate;
    // The watermark and the passports it covered: the public revocation list publishes
    // this raise from the audit row (P2.4).
    metadata = delegationRevokeMetadata({ all: true, validAfter: r.validAfter, passports: r.passports, immediate, via: "api", keyId });
  } else {
    const r = await revokeAgentDelegation(db as never, userId, id, String(body.jti));
    if (!r.ok) return errorResponse(r.status, r.code, requestId);
    immediate = r.immediate;
    metadata = delegationRevokeMetadata({ all: false, jti: String(body.jti), passports: r.passports, immediate, via: "api", keyId });
  }

  const fields = { user: userId, agentId: id, all, ...(all ? {} : { jti: String(body.jti) }) };
  logSecurityEvent("agent.delegation_revoke", fields);
  await dispatchSecurityAlert("agent.delegation_revoke", fields);
  await recordAdminAction({ userId, action: "agent.delegation_revoke", targetType: "agent", targetId: id, metadata });
  return jsonResponse(
    {
      data: {
        id,
        revoked: all ? "all_before_now" : String(body.jti),
        // false: recorded, but the gateway's fast copy could not be written; a worker
        // holding a current visa can call until that visa expires (5 minutes by default).
        immediate,
      },
    },
    requestId
  );
});

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handler(req, ctx);
}
