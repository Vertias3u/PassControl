// When an agent reaches its budget at the rate it is spending (1.6.0).
//
// Computed once, on the server, and handed out by `GET /api/v1/self`: the agent's
// own note, the status line and the alerts all quote this one answer. The CLI
// cannot import the dashboard's TypeScript, so a second copy there is how two
// surfaces would have come to disagree.
//
// Presentation only, like lib/budget-view.ts: nothing here reserves or refuses.
import { periodStart } from "@/lib/period";
import type { BudgetView } from "@/lib/budget-view";

const DAY_MS = 86_400_000;
/** A period younger than this has one or two calls in it: too few to call a rate. */
export const MIN_OBSERVED_MS = 10 * 60_000;

export interface BudgetPace {
  /** ISO time the limit is reached at this rate; null when it is not on its way. */
  reaches_limit_at: string | null;
  /** Which limit: the daily/monthly one, or the agent's overall cost or token cap. */
  limit: "period" | "cost" | "tokens";
  /** The rate's evidence: this period so far, or the last 24 hours of spend. */
  basis: "this_period" | "last_24h";
}

/** What the agent spent in the last 24 hours, from the ledger; null if unreadable. */
export interface RecentSpend {
  tokens: number;
  microcents: number;
}

/**
 * When `spent` reaches `limit` at `burned` per `observedMs`, or null when it is not
 * on its way. Shared with the dashboard's attention queue.
 */
export function projectedDate(
  spent: number,
  limit: number | null,
  burned: number,
  observedMs: number,
  nowMs: number
): number | null {
  if (limit == null || limit <= 0 || burned <= 0 || observedMs <= 0) return null;
  if (spent >= limit) return nowMs;
  const perMs = burned / observedMs;
  const projected = nowMs + (limit - spent) / perMs;
  return Number.isFinite(projected) && Math.abs(projected) <= 8.64e15 ? projected : null;
}

interface Candidate {
  limit: BudgetPace["limit"];
  basis: BudgetPace["basis"];
  at: number | null;
}

function lifetime(
  limit: "cost" | "tokens",
  cap: number,
  used: number | null,
  burned: number | null,
  nowMs: number
): Candidate | null {
  if (used === null || burned === null) return null;
  const at = used >= cap ? nowMs : projectedDate(used, cap, burned, DAY_MS, nowMs);
  return { limit, basis: "last_24h", at };
}

/**
 * The limit the agent reaches first at its current rate. Null when nothing can be
 * said honestly: no limit, an unreadable count, or too little time observed.
 */
export function budgetPace(view: BudgetView, recent: RecentSpend | null, nowMs: number): BudgetPace | null {
  const candidates: Candidate[] = [];

  const period = view.period;
  if (period && !("unknown" in period) && period.used_microcents !== null) {
    const elapsed = nowMs - periodStart(period.kind, nowMs).getTime();
    if (elapsed >= MIN_OBSERVED_MS) {
      const used = period.used_microcents;
      const resetsAt = nowMs + period.resets_in_seconds * 1000;
      const projected = used >= period.limit_microcents ? nowMs : projectedDate(used, period.limit_microcents, used, elapsed, nowMs);
      candidates.push({ limit: "period", basis: "this_period", at: projected !== null && projected <= resetsAt ? projected : null });
    }
  }
  if (view.cost) {
    const c = lifetime("cost", view.cost.limit_microcents, view.cost.used_microcents, recent?.microcents ?? null, nowMs);
    if (c) candidates.push(c);
  }
  if (view.tokens) {
    const c = lifetime("tokens", view.tokens.limit, view.tokens.used, recent?.tokens ?? null, nowMs);
    if (c) candidates.push(c);
  }
  const reaching = candidates.filter((c) => c.at !== null).sort((a, b) => (a.at as number) - (b.at as number));
  const chosen = reaching[0] ?? candidates[0];
  if (!chosen) return null;
  return {
    reaches_limit_at: chosen.at === null ? null : new Date(chosen.at).toISOString(),
    limit: chosen.limit,
    basis: chosen.basis,
  };
}
