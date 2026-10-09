// An agent's limits as "limit, used, remaining", from the counters the gate compares.
//
// Shared by `GET /api/v1/self` (the agent reading its own budget) and the decision
// trace (an owner projecting a call), so the two cannot disagree: an agent told it
// has $0.30 left and then refused would have been shown a number that was never
// the one enforced.
//
// Presentation only. Nothing here reserves, settles or decides; the atomic hold
// script (lib/state/holds.ts) is the enforcement and reads its own counters.
import { serviceClient } from "@/lib/supabase";
import { periodStart, secondsUntilPeriodEnd, type PeriodKind } from "@/lib/period";
import { readPeriodUsageMany } from "@/lib/state/holds";
import type { BudgetSnapshot } from "@/lib/state/redis";

/** The periodic limit as the caller read it, with what it has counted (null: unreadable). */
export type PeriodInput =
  | { mode: "none" }
  | { mode: "unknown" }
  | { mode: "set"; kind: PeriodKind; capMicrocents: number; counted: number | null };

export interface BudgetView {
  tokens: { limit: number; used: number | null; remaining: number | null } | null;
  cost: { limit_microcents: number; used_microcents: number | null; remaining_microcents: number | null } | null;
  period:
    | {
        kind: PeriodKind;
        limit_microcents: number;
        used_microcents: number | null;
        remaining_microcents: number | null;
        resets_in_seconds: number;
      }
    | { unknown: true }
    | null;
}

const remaining = (limit: number, used: number | null) => (used === null ? null : Math.max(0, limit - used));

/**
 * `used` is spent PLUS reserved: a call in flight holds budget, and the gate compares
 * the next call against both. Spent comes from the hot-path counter, or the database
 * mirror where the counter is missing, as the trace has always done. Null when
 * neither can be read: unknown is never zero.
 */
export function budgetView(input: {
  capTokens: number | null;
  capMicrocents: number | null;
  /** The four counters; null when they could not be read at all. */
  snapshot: BudgetSnapshot | null;
  /** `agents.spent_*`, the best-effort mirror; null when unread. */
  mirror: { spentTokens: number; spentMicrocents: number } | null;
  period: PeriodInput;
  nowMs: number;
}): BudgetView {
  const { snapshot, mirror } = input;
  const spentTokens = snapshot?.spentTokens ?? mirror?.spentTokens ?? null;
  const spentMicrocents = snapshot?.spentMicrocents ?? mirror?.spentMicrocents ?? null;
  const usedTokens = snapshot && spentTokens !== null ? spentTokens + snapshot.reservedTokens : null;
  const usedMicrocents = snapshot && spentMicrocents !== null ? spentMicrocents + snapshot.reservedMicrocents : null;
  const p = input.period;
  return {
    tokens:
      input.capTokens === null
        ? null
        : { limit: input.capTokens, used: usedTokens, remaining: remaining(input.capTokens, usedTokens) },
    cost:
      input.capMicrocents === null
        ? null
        : {
            limit_microcents: input.capMicrocents,
            used_microcents: usedMicrocents,
            remaining_microcents: remaining(input.capMicrocents, usedMicrocents),
          },
    period:
      p.mode === "none"
        ? null
        : p.mode === "unknown"
          ? { unknown: true }
          : {
              kind: p.kind,
              limit_microcents: p.capMicrocents,
              used_microcents: p.counted,
              remaining_microcents: remaining(p.capMicrocents, p.counted),
              resets_in_seconds: secondsUntilPeriodEnd(p.kind, input.nowMs),
            },
  };
}

/**
 * What the periodic limit has counted this period, as the gateway would count it
 * on the next call: its own snapshot when it has one, or the ledger's figure when
 * it would seed from it, plus what is held. Null when neither can be read, so a
 * reader makes no period claim at all rather than projecting an admission.
 */
export async function readPeriodCounted(agentId: string, kind: PeriodKind, nowMs: number): Promise<number | null> {
  try {
    const usage = (await readPeriodUsageMany([{ id: agentId, kind }], nowMs)).get(agentId);
    if (!usage) return null;
    if (usage.state === "tracked") return usage.usedMicrocents + usage.heldMicrocents;
    const { data, error } = await serviceClient().rpc("agent_period_spend", {
      p_agent_id: agentId,
      p_since: periodStart(kind, nowMs).toISOString(),
    });
    if (error) return null;
    const row = (Array.isArray(data) ? data[0] : data) as { spent_microcents?: unknown } | undefined;
    const seed = Number(row?.spent_microcents);
    return Number.isFinite(seed) ? seed + usage.heldMicrocents : null;
  } catch {
    return null;
  }
}
