// GET /api/control/v1/agents/{id}/holds — attempts still holding budget (read scope).
//
// An OPEN HOLD is an attempt that started and whose ending never ran: a worker
// that died, a response body nobody consumed, a throw between dispatch and
// settlement. Its capacity stays consumed — deliberately and indefinitely,
// because releasing it on a timer is the defect this subsystem was built to
// remove — so something has to let a human see and decide them.
//
// The operator procedure is docs/budget-recovery.md.
//
// Read-only, and it never repairs anything it finds. Deciding whether a call was
// billed needs evidence this process does not have: the receipt, and the
// provider's own dashboard.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { listOpenHolds } from "@/lib/state/holds";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One page of holds. An agent with more than this has a problem that resolving
 *  them one at a time is not going to fix. */
const HOLD_PAGE = 200;

const handler = control("read", async ({ userId, db, params, requestId }) => {
  const id = params.id ?? "";
  if (!UUID_RE.test(id)) return errorResponse(400, "invalid_id", requestId);

  // TENANT CHECK BEFORE THE REDIS READ. Hold keys are namespaced by agent id
  // alone — agent ids are globally unique, but that is not the same as scoped —
  // so without this an operator could enumerate another tenant's in-flight
  // spending by guessing an id. The service-role client bypasses RLS, so this
  // scoping is done here by hand (trust boundary #5).
  const { data: agent, error } = await db
    .from("agents")
    .select("id")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) return errorResponse(500, "query_failed", requestId);
  if (!agent) return errorResponse(404, "not_found", requestId);

  const holds = await listOpenHolds(id, HOLD_PAGE);
  return jsonResponse(
    {
      data: {
        agent_id: id,
        // Said out loud rather than left to be inferred from a count. The whole
        // procedure is "work through these one at a time", and an operator who
        // cleared a full page would otherwise believe they were finished. The
        // rebuild endpoint reports the same thing for the same reason.
        truncated: holds.length >= HOLD_PAGE,
        holds: holds.map((h) => ({
          attempt_id: h.attemptId,
          created_at: h.createdAtMs ? new Date(h.createdAtMs).toISOString() : null,
          age_ms: h.ageMs,
          // Both dimensions, because a hold reserves both and an operator
          // resolving one has to say what happened to each.
          estimate_tokens: h.estimateTokens,
          estimate_microcents: h.estimateMicrocents,
          // What the attempt was about to call. THE ONLY IDENTIFYING DETAIL AN
          // OPERATOR GETS: an abandoned hold has no agent_logs row and so no
          // receipt — the row is written by the settlement path, which is the
          // path that did not run — and the attempt id appears nowhere else in
          // the product. These two plus `created_at` are what makes the line on
          // the provider's own billing page findable. Empty on holds opened
          // before this field existed.
          provider: h.provider || null,
          model: h.model || null,
          // WHETHER `not_spent` IS EVEN AVAILABLE FOR THIS ONE. True means the
          // attempt consumed its dispatch permission and the request may have
          // reached the provider, so the settle script will refuse to release
          // it — the operator's only honest options are `spent` with an amount,
          // or leaving it open until they have the evidence. False means it
          // provably never left.
          may_have_dispatched: h.mayHaveDispatched,
        })),
      },
    },
    requestId
  );
});

export function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handler(req, ctx);
}
