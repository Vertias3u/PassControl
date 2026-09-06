// POST /api/control/v1/agents/{id}/holds/{attemptId}/resolve — an operator's
// decision about an attempt whose ending never ran (write scope).
//
// body: { outcome: "spent" | "not_spent", tokens?: number, microcents?: number }
//
// ── Why a human, and why this is the only way out ───────────────────────────
//
// An open hold means the gateway dispatched a request and never learned what it
// cost. Nothing inside this system can find out: the provider billed, or did
// not, on the far side of a connection that died. Every automatic answer is a
// guess, and a guess that resolves to "not spent" hands back capacity for money
// that was really spent — the exact defect this subsystem replaced. So the hold
// stays, indefinitely, until someone with the evidence says which it was.
//
// The evidence is the receipt and the provider's own dashboard. Neither is here.
// docs/budget-recovery.md is the procedure for reading both.
//
// Goes through the same compare-and-set as every other transition, so a retried
// or duplicated resolve is a no-op that returns the first one's numbers rather
// than a second refund. `applied: false` in the response is that case, and it is
// not an error.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { resolveHold, releaseUndispatched } from "@/lib/state/holds";
import { recordAdminAction } from "@/lib/audit";
import { captureError } from "@/lib/observability";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Guards a typo'd body from becoming an absurd charge, in the units each
// dimension is actually stored in.
//
// THE CEILING MUST EXCEED WHAT A HOLD CAN RESERVE, or there are holds an
// operator cannot record as spent: the endpoint would 400 and the only answer it
// would still accept is `not_spent`. That is the one direction this subsystem
// exists to prevent, arriving through the recovery route. An earlier draft got
// this exactly backwards — it capped cost at 100_000_000 µ¢ while calling it a
// hundred dollars, which is 1 USD (lib/pricing.ts: 1 USD = 100_000_000 µ¢), and
// any sizeable call reserves more than that.
const MAX_TOKENS = 100_000_000;
/** 100 USD. See lib/pricing.ts for the unit. */
const MAX_MICROCENTS = 10_000_000_000;

function amount(v: unknown, max: number): number | null {
  if (v === undefined || v === null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > max) return null;
  return Math.floor(n);
}

const handler = control("write", async ({ userId, db, params, keyId, requestId, req }) => {
  const id = params.id ?? "";
  const attemptId = params.attemptId ?? "";
  if (!UUID_RE.test(id) || !UUID_RE.test(attemptId)) {
    return errorResponse(400, "invalid_id", requestId);
  }

  let body: { outcome?: unknown; tokens?: unknown; microcents?: unknown };
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_json", requestId);
  }

  const outcome = String(body.outcome ?? "");
  if (outcome !== "spent" && outcome !== "not_spent") {
    return errorResponse(400, "invalid_request", requestId);
  }
  const tokens = amount(body.tokens, MAX_TOKENS);
  const microcents = amount(body.microcents, MAX_MICROCENTS);
  if (tokens === null || microcents === null) return errorResponse(400, "invalid_request", requestId);

  // A "spent" WITH NO AMOUNTS IS REFUSED, and this is not pedantry about
  // required fields. Omitted amounts default to zero, so the shortest possible
  // spend body would charge nothing — identical in effect to `not_spent`, from
  // the endpoint whose entire purpose is to make sure real spending is charged,
  // reachable by leaving a field out. An explicit zero still works, and still
  // means something different from `not_spent`; what is rejected is not saying.
  if (outcome === "spent" && body.tokens === undefined && body.microcents === undefined) {
    return errorResponse(400, "invalid_request", requestId);
  }

  // TENANT CHECK BEFORE ANY REDIS WRITE, for the reason the list route states:
  // hold keys are namespaced by agent id alone, and the service-role client
  // bypasses RLS. Without this an operator could settle — or refund — another
  // tenant's in-flight spending by guessing two ids.
  const { data: agent, error } = await db
    .from("agents")
    .select("id")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  if (error) return errorResponse(500, "query_failed", requestId);
  if (!agent) return errorResponse(404, "not_found", requestId);

  // "not_spent" is the FULL release, and it is the same transition the proxy
  // takes when it can prove a request never left the building. The operator is
  // asserting that proof by hand; the script does not care which of them said so.
  //
  // "spent" charges what the operator supplies. Zero is a legitimate answer here
  // — a call that reached the provider and cost nothing — and it is NOT the same
  // statement as "not_spent", because the hold's estimate is released either way
  // but only one of them claims the request never happened.
  const result =
    outcome === "not_spent"
      ? await releaseUndispatched({ agentId: id, attemptId })
      : await resolveHold({ agentId: id, attemptId, tokens, microcents });

  // ── The charge has to reach the ledger, because the counters are gone ──────
  //
  // A degraded settle closed the hold and moved nothing, and the documented
  // recovery from here is a rebuild — which recomputes spend from `agent_logs`.
  // `admin_audit` is not an input to that, and must not become one: it records
  // what a human did, not what an agent spent. So without this write the
  // operator's own figure survives only as evidence of a decision, and the
  // rebuild they are about to run comes back short by exactly the amount they
  // just supplied. Both halves work and the sequence loses money.
  //
  // ONLY on the degraded branch. When the settle applied, Redis has the charge
  // and the rebuild reads it from the checkpoint the mirror maintains; writing
  // a row here as well would charge it twice.
  //
  // NOT an agent_logs row, and that is a rule rather than a preference. That
  // table is the gateway's record of calls it handled: migration 0006 makes it
  // append-only, 0026's CHECK requires every row to carry a complete passport or
  // direct-key identity, and a test asserts lib/log.ts is its only application
  // writer. An operator recovering an abandoned attempt has no visa and no key —
  // the identity died with the worker — so a row here could only satisfy that
  // CHECK by inventing one, in the table that feeds receipts and statements.
  // This is a different kind of fact and gets its own table (migration 0056).
  //
  // The PRIMARY KEY on `attempt_id` is what makes this an ordinary insert
  // rather than a read-then-write: one decision per attempt, so a retried or
  // duplicated resolve cannot charge twice and two operators racing cannot both
  // succeed. Overlap with a proxy row that already logged this attempt is
  // handled where it belongs, in the rebuild — see 0056's NOT EXISTS.
  let ledgerRecorded = !result.degraded;
  let ledgerCorrected = false;
  if (result.degraded) {
    // THE OPERATOR'S OWN FIGURES, not the ones the script echoed back. On a
    // first resolve the two are identical — the script's `resolved` outcome
    // applies exactly what was supplied. They diverge on a REPLAY, where the
    // script returns the FIRST resolution's stored amounts, and that divergence
    // is the whole point: a figure recorded here is a person's reconstruction,
    // and a person who mistypes one has to be able to fix it.
    const decision = {
      attempt_id: attemptId,
      agent_id: id,
      user_id: userId,
      tokens,
      microcents,
    };
    let { error: ledgerError } = await db.from("agent_spend_adjustments").insert(decision);
    // 23505 is the unique violation: this attempt already has a decision. That
    // is not a failure and it is not necessarily a no-op either — it is either
    // the same operator clicking twice, or one correcting a figure they got
    // wrong. Both are answered by writing the new figures over the old, which
    // is idempotent for the first and the only remedy for the second: nothing
    // else can reach this row, and until a rebuild runs it is the ONLY record
    // of what that attempt cost. Every version is in `admin_audit`.
    if ((ledgerError as { code?: string } | null)?.code === "23505") {
      ledgerCorrected = true;
      ({ error: ledgerError } = await db
        .from("agent_spend_adjustments")
        .update({ tokens, microcents })
        .eq("attempt_id", attemptId));
    }
    ledgerRecorded = !ledgerError;
    if (!ledgerRecorded) {
      // Loud. The hold is closed, the counters are gone, and this row was the
      // only place the charge could still live. The resolve is safe to repeat
      // and a repeat retries this write — a replayed degraded settle reports
      // degraded again for exactly that reason — so the operator has a way out,
      // but only if they are told.
      await captureError(ledgerError, {
        route: "control.holds.resolve",
        code: "ledger_write_failed",
        agentId: id,
      }).catch(() => {});
    }
  }

  // Written whether or not the transition applied. A replay is itself worth a
  // row: it records that a second operator (or a second click) tried, which is
  // the difference between "resolved once" and "nearly refunded twice".
  await recordAdminAction({
    userId,
    action: "budget.hold_resolve",
    targetType: "agent",
    targetId: id,
    metadata: {
      attempt_id: attemptId,
      outcome,
      via: "api",
      key_id: keyId,
      // What was ASKED for and what actually MOVED, separately. They differ on
      // a replay, and a trail that recorded only the request would read as two
      // charges where there was one.
      requested_tokens: tokens,
      requested_microcents: microcents,
      applied: result.applied,
      applied_tokens: result.appliedTokens,
      applied_microcents: result.appliedMicrocents,
      anomaly: result.anomaly === true,
      // A refused release is worth a row of its own: it records an operator
      // trying to write off a request that was actually sent.
      refused_dispatched: result.conflict === true,
      // Different cause, different remedy, so it gets its own field rather than
      // riding on the one above. The hold closed and the amounts are recorded,
      // but the agent's counters were gone, so nothing was added to them.
      state_lost: result.degraded === true,
      // Whether the charge actually reached the rebuild's input. False is the
      // one outcome here that needs a human to come back.
      ledger_recorded: ledgerRecorded,
      // And whether it replaced an earlier figure for this attempt rather than
      // creating the first one. That is the difference between a second click
      // and somebody fixing a mistake, and the trail should say which.
      ledger_corrected: ledgerCorrected,
    },
  });

  return jsonResponse(
    {
      data: {
        agent_id: id,
        attempt_id: attemptId,
        outcome,
        // False means the hold had already reached a terminal state. The numbers
        // beside it are the FIRST resolution's, not this call's.
        applied: result.applied,
        applied_tokens: result.appliedTokens,
        applied_microcents: result.appliedMicrocents,
        // THE OTHER REASON `applied` CAN BE FALSE, and it means something
        // completely different from a replay. The hold is open, real, and
        // refused THIS outcome: the attempt consumed its dispatch permission,
        // so the request may have reached the provider and cannot be recorded
        // as one that never happened. The hold is still there and still needs a
        // decision — `spent` with an amount, or evidence. An operator who read
        // only `applied: false` would think it was already handled and leave an
        // open hold behind believing it closed.
        refused_dispatched: result.conflict === true,
        // THE THIRD REASON `applied` CAN BE FALSE, and the only one that is not
        // about this attempt at all. The hold closed and the amounts above are
        // what it cost, but this agent's counters no longer exist, so nothing
        // was added to them and nothing could be — writing them back would
        // recreate the agent's whole budget at the size of one call. The
        // attempt is DONE; the agent is not, and stays refused at admission
        // until POST .../budget/rebuild recomputes it from the audit trail.
        // See docs/budget-recovery.md.
        state_lost: result.degraded === true,
        // Only meaningful beside `state_lost: true`. False means the charge did
        // NOT reach the rebuild's input, so the rebuild you are about to run
        // will come back short. Repeat this resolve — it retries the write —
        // before rebuilding.
        ledger_recorded: ledgerRecorded,
        // WHAT THIS CALL ACTUALLY RECORDED, which on a correction is NOT
        // `applied_tokens` above. Those are the hold's, and the hold keeps the
        // first resolution's figures forever — so an operator fixing a typo
        // would otherwise read back the very number they came to replace, from
        // a 200, and conclude the correction had not taken. They are different
        // questions: one is what the attempt was closed at, this is what the
        // rebuild will read.
        recorded_tokens: result.degraded ? tokens : null,
        recorded_microcents: result.degraded ? microcents : null,
        // True when this replaced an earlier figure rather than writing the
        // first one — the confirmation that a correction landed.
        ledger_corrected: ledgerCorrected,
        // No hold record at all — not open, not a tombstone. Either the attempt
        // id never existed, or it settled more than the tombstone window ago.
        // Nothing moved.
        unknown_attempt: result.anomaly === true,
      },
    },
    requestId
  );
});

export function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; attemptId: string }> }
): Promise<Response> {
  return handler(req, ctx);
}
