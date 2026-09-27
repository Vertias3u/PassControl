// POST /api/control/v1/agents/{id}/budget/rebuild — recompute this agent's
// spend from the record and rebase the hot-path counters onto it (write scope).
//
// ── The only sanctioned lowering of a spend counter in the product ──────────
//
// Everything else that touches `spent:` can only raise it. That asymmetry is the
// whole defence: a bug that loses a settlement costs the operator nothing, while
// a bug that lowers a counter hands out capacity for money already spent. This
// route is the deliberate exception, and it is audited for exactly that reason —
// an unaudited lowering would be indistinguishable from the accounting defect
// this subsystem exists to prevent.
//
// It is safe to re-run. `rebuild_agent_spend` computes a total from history
// rather than applying a delta, so calling it twice produces the same number
// twice.
//
// TWO JOBS, and both have to happen or the agent is worse off than before:
//
//   1. Postgres becomes authoritative again — the checkpoint is set (not
//      advanced) from the full history, so the next incremental fold starts
//      from a true watermark.
//   2. Redis is rebased onto a NEW epoch, written to both stores. That is what
//      clears a `blocked_budget_state` refusal: the refusal means Redis and
//      Postgres disagree about which generation of counters is live, and a
//      rebuild is the operator asserting which one it now is.
//
// The operator procedure, including how to decide the holds a rebuild leaves
// behind, is docs/budget-recovery.md.
//
// The policy cache is purged afterwards, and that is not optional — the epoch
// rides in that cache, so an unpurged agent keeps comparing against the old
// generation for a full TTL and keeps refusing every call.
export const runtime = "edge";

import { control } from "@/lib/control/handler";
import { jsonResponse, errorResponse } from "@/lib/control/respond";
import { rebuildBudgetState } from "@/lib/state/holds";
import { periodStart, type PeriodKind } from "@/lib/period";
import { MICROCENTS_PER_CENT } from "@/lib/pricing";
import { purgeAgentPolicy } from "@/lib/state/redis";
import { recordAdminAction } from "@/lib/audit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RebuildRow {
  spent_tokens?: unknown;
  spent_microcents?: unknown;
}

const handler = control("write", async ({ userId, db, params, keyId, requestId }) => {
  const id = params.id ?? "";
  if (!UUID_RE.test(id)) return errorResponse(400, "invalid_id", requestId);

  // Tenant scope by hand: the service-role client bypasses RLS, and both the RPC
  // and every Redis key below are addressed by agent id alone.
  // The periodic limit (0073) is read on its own rung: a database without the
  // columns answers 42703, and that must not stop an operator recovering an
  // agent's cumulative counters.
  const withPeriod = await db
    .from("agents")
    .select("id, budget_epoch, budget_period, budget_period_cents")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();
  const lookup =
    (withPeriod.error as { code?: string } | null)?.code === "42703"
      ? await db.from("agents").select("id, budget_epoch").eq("user_id", userId).eq("id", id).maybeSingle()
      : withPeriod;
  const { data: agent, error: lookupError } = lookup;
  if (lookupError) return errorResponse(500, "query_failed", requestId);
  if (!agent) return errorResponse(404, "not_found", requestId);

  const { data: rebuilt, error: rpcError } = await db.rpc("rebuild_agent_spend", { p_agent_id: id });
  if (rpcError) return errorResponse(500, "query_failed", requestId);
  const row = (Array.isArray(rebuilt) ? rebuilt[0] : rebuilt) as RebuildRow | undefined;
  const spentTokens = Number(row?.spent_tokens) || 0;
  const spentMicrocents = Number(row?.spent_microcents) || 0;

  // THE PERIOD IS REBUILT FROM THE SAME LEDGER (K1). The new epoch below makes
  // the agent's period snapshot invalid; rewriting it here, from the ledger's own
  // total for the current period, is what stops a rebuild from handing the
  // period's spend back as capacity. Read BEFORE anything is written, and a
  // failure refuses the whole rebuild — the operator retries, rather than
  // getting a half-recovery that looks complete.
  const agentRow = agent as { budget_period?: unknown; budget_period_cents?: unknown };
  const periodKind: PeriodKind | null =
    agentRow.budget_period === "day" || agentRow.budget_period === "month" ? agentRow.budget_period : null;
  const periodCents =
    typeof agentRow.budget_period_cents === "number" && Number.isFinite(agentRow.budget_period_cents)
      ? agentRow.budget_period_cents
      : null;
  const nowMs = Date.now();
  let period: { kind: PeriodKind; capMicrocents: number; spentMicrocents: number } | undefined;
  if (periodKind !== null && periodCents !== null) {
    const { data: periodData, error: periodError } = await db.rpc("agent_period_spend", {
      p_agent_id: id,
      p_since: periodStart(periodKind, nowMs).toISOString(),
    });
    if (periodError) return errorResponse(500, "query_failed", requestId);
    const periodRow = (Array.isArray(periodData) ? periodData[0] : periodData) as RebuildRow | undefined;
    period = {
      kind: periodKind,
      capMicrocents: Math.round(periodCents * MICROCENTS_PER_CENT),
      spentMicrocents: Number(periodRow?.spent_microcents) || 0,
    };
  }

  const epoch = crypto.randomUUID();

  // POSTGRES FIRST, THEN REDIS, and the order is the safe one.
  //
  // If the Redis write never happens, Postgres names an epoch Redis does not
  // hold — which is precisely the "state lost" condition, so the agent keeps
  // refusing and an operator re-runs this. If Redis went first and Postgres
  // failed, Redis would hold a NEW epoch while Postgres still named the old one:
  // the same refusal, but now with counters that had already been rebased, so a
  // second rebuild would compute the same total and reach the same place anyway.
  // Both orders are recoverable; this one never leaves a moment where Redis
  // permits spending under a generation nothing has recorded.
  const { error: writeError } = await db
    .from("agents")
    .update({ budget_epoch: epoch, budget_state_established_at: new Date().toISOString() })
    .eq("id", id);
  if (writeError) return errorResponse(500, "query_failed", requestId);

  const state = await rebuildBudgetState({
    agentId: id,
    epoch,
    spentTokens,
    spentMicrocents,
    ...(period ? { period, nowMs } : {}),
  });

  // MANDATORY. The cached policy carries the epoch the proxy compares against,
  // so leaving a stale entry means every call keeps failing the check this
  // rebuild just fixed, for the length of a TTL, with no sign of why.
  await purgeAgentPolicy(userId, id);

  await recordAdminAction({
    userId,
    action: "budget.rebuild",
    targetType: "agent",
    targetId: id,
    metadata: {
      via: "api",
      key_id: keyId,
      // Both epochs, because this row is the only record that the counters
      // changed generation, and "from null" is itself the interesting case: it
      // says the agent was being rebuilt during the cutover rather than
      // recovered from a loss.
      from_epoch: (agent as { budget_epoch?: unknown }).budget_epoch ?? null,
      to_epoch: epoch,
      spent_tokens: spentTokens,
      spent_microcents: spentMicrocents,
      // Open holds survive a rebuild deliberately — they are attempts nobody has
      // decided yet, and a rebuild is not a decision. Their estimates become the
      // new `reserved:`.
      open_holds: state.openHolds,
      reserved_tokens: state.reservedTokens,
      reserved_microcents: state.reservedMicrocents,
      // What the open holds add up to, beside what the counter actually holds.
      // They differ only if an invariant broke, and the difference is REPORTED
      // rather than corrected — a rebuild that silently overwrote the
      // atomically-maintained counter would be the scan-and-SET defect this
      // whole change removed, arriving through the recovery route.
      computed_reserved_tokens: state.computedReservedTokens,
      computed_reserved_microcents: state.computedReservedMicrocents,
      seeded_reserved: state.seededReserved,
      ...(period ? { period: period.kind, period_spent_microcents: period.spentMicrocents } : {}),
    },
  });

  return jsonResponse(
    {
      data: {
        agent_id: id,
        budget_epoch: epoch,
        spent_tokens: spentTokens,
        spent_microcents: spentMicrocents,
        reserved_tokens: state.reservedTokens,
        reserved_microcents: state.reservedMicrocents,
        // The sum of the open holds' estimates. Equal to `reserved_tokens`
        // unless something is wrong, and shown separately so that "unless" is
        // visible instead of being quietly written away.
        computed_reserved_tokens: state.computedReservedTokens,
        computed_reserved_microcents: state.computedReservedMicrocents,
        // True only when the counter was absent and this rebuild established
        // it. False is the ordinary answer: the counter was already correct.
        seeded_reserved: state.seededReserved,
        // More open holds than one read returns, so the computed sums above are
        // partial. A rebuild is not the fix for an agent in this state.
        holds_truncated: state.truncated,
        // Still open, still undecided. Read them at /holds and resolve each one
        // individually; a rebuild deliberately does not clear them.
        open_holds: state.openHolds,
      },
    },
    requestId
  );
});

export function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  return handler(req, ctx);
}
