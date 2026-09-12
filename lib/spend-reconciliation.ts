import type { SupabaseClient } from "@supabase/supabase-js";

import { readReservedMany, type ReservedBudgetSummary } from "@/lib/state/holds";

export interface SpendCounterRow {
  id: string;
  spent_tokens?: number | null;
  spent_microcents?: number | null;
}

export interface SpendReconciliation {
  state: "reconciled" | "pending" | "unavailable";
  settled_tokens: number;
  settled_microcents: number;
  log_attributed_tokens: number | null;
  log_attributed_microcents: number | null;
  adjustment_tokens: number | null;
  adjustment_microcents: number | null;
  attributable_tokens: number | null;
  attributable_microcents: number | null;
  difference_tokens: number | null;
  difference_microcents: number | null;
  contributing_logs: number | null;
  contributing_adjustments: number | null;
  last_reconciled_at: string | null;
  holds_state: "available" | "unavailable";
  open_reserved_tokens: number | null;
  open_reserved_microcents: number | null;
  open_holds: number | null;
}

type ReservationReader = (
  agentIds: readonly string[]
) => Promise<Map<string, ReservedBudgetSummary>>;

/**
 * Explain the all-time budget counters without changing them.
 *
 * The durable RPC and Redis reservations are intentionally independent reads:
 * one can be unavailable while the other remains useful, and neither failure
 * is converted into a zero. The caller supplies already tenant-scoped agent
 * rows; the RPC repeats that boundary inside its service-role-only function.
 *
 * `db` is a thunk, not a client, because BUILDING the client can fail too:
 * `serviceClient()` throws when the service-role env is absent. Taking an
 * already-built client meant that throw landed at the call site, outside every
 * catch below — and the dashboard, whose whole discipline is to render a failed
 * read as unavailable rather than as zero, went down with it instead. Deferring
 * construction into the same failure domain as the read it exists for is what
 * makes "unavailable" reachable rather than fatal.
 */
export async function buildSpendReconciliation(
  db: () => SupabaseClient,
  userId: string,
  agents: readonly SpendCounterRow[],
  readReservations: ReservationReader = readReservedMany
): Promise<SpendReconciliation> {
  const settled = agents.reduce(
    (total, agent) => ({
      tokens: total.tokens + Number(agent.spent_tokens ?? 0),
      microcents: total.microcents + Number(agent.spent_microcents ?? 0),
    }),
    { tokens: 0, microcents: 0 }
  );

  const [explanationResult, reservationsResult] = await Promise.all([
    Promise.resolve()
      .then(() => db().rpc("explain_workspace_spend", { p_user_id: userId }))
      .then((result) => ({ data: result.data, error: result.error }))
      .catch(() => ({ data: null, error: true })),
    readReservations(agents.map((agent) => agent.id))
      .then((value) => ({ value, error: false as const }))
      .catch(() => ({ value: null, error: true as const })),
  ]);

  const rpcData = explanationResult.error ? null : explanationResult.data;
  const explanation = Array.isArray(rpcData) ? rpcData[0] ?? null : rpcData;
  const attributableTokens = explanation
    ? Number(explanation.attributable_tokens ?? 0)
    : null;
  const attributableMicrocents = explanation
    ? Number(explanation.attributable_microcents ?? 0)
    : null;
  const differenceTokens = attributableTokens === null
    ? null
    : settled.tokens - attributableTokens;
  const differenceMicrocents = attributableMicrocents === null
    ? null
    : settled.microcents - attributableMicrocents;
  const reservationTotals = reservationsResult.value
    ? [...reservationsResult.value.values()].reduce(
        (total, item) => ({
          tokens: total.tokens + item.tokens,
          microcents: total.microcents + item.microcents,
          openHolds: total.openHolds + item.openHolds,
        }),
        { tokens: 0, microcents: 0, openHolds: 0 }
      )
    : null;

  return {
    state: explanation === null
      ? "unavailable"
      : differenceMicrocents === 0 && differenceTokens === 0
        ? "reconciled"
        : "pending",
    settled_tokens: settled.tokens,
    settled_microcents: settled.microcents,
    log_attributed_tokens: explanation === null ? null : Number(explanation.log_tokens ?? 0),
    log_attributed_microcents: explanation === null ? null : Number(explanation.log_microcents ?? 0),
    adjustment_tokens: explanation === null ? null : Number(explanation.adjustment_tokens ?? 0),
    adjustment_microcents: explanation === null ? null : Number(explanation.adjustment_microcents ?? 0),
    attributable_tokens: attributableTokens,
    attributable_microcents: attributableMicrocents,
    difference_tokens: differenceTokens,
    difference_microcents: differenceMicrocents,
    contributing_logs: explanation === null ? null : Number(explanation.contributing_logs ?? 0),
    contributing_adjustments: explanation === null ? null : Number(explanation.contributing_adjustments ?? 0),
    last_reconciled_at: explanation?.last_reconciled_at ?? null,
    holds_state: reservationsResult.error ? "unavailable" : "available",
    open_reserved_tokens: reservationTotals?.tokens ?? null,
    open_reserved_microcents: reservationTotals?.microcents ?? null,
    open_holds: reservationTotals?.openHolds ?? null,
  };
}
