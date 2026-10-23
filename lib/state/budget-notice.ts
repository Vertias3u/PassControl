// Budget notices sent at most once a period (1.6.0): the owner's alert that an
// agent switched to its cheaper model at the pause line (L7), and the heads-up
// that a limit will be reached soon (L8).
//
// One key per notice, agent and period, expiring when the period ends, so the
// next period's notice needs nothing to clear it. A lifetime limit has no period:
// its window is thirty days. The 10-minute alert throttle (claimAlertSlot) is a
// different thing: it stops a burst, and this stops a notice repeating all day.
import { redis } from "./redis";
import { periodKeys, secondsUntilPeriodEnd, type PeriodKind } from "@/lib/period";

export type BudgetNotice = "switched" | "headsup";

const LIFETIME_WINDOW_S = 30 * 86400;

function window(period: PeriodKind | null, nowMs: number): { tag: string; ttl: number } {
  if (period === null) return { tag: "life", ttl: LIFETIME_WINDOW_S };
  return { tag: periodKeys(nowMs)[period], ttl: secondsUntilPeriodEnd(period, nowMs) };
}

const key = (notice: BudgetNotice, agentId: string, tag: string) => `budget_notice:${notice}:${agentId}:${tag}`;

/** True the first time in this period, and false after. Throws when Redis cannot answer: send nothing. */
export async function claimBudgetNotice(agentId: string, notice: BudgetNotice, period: PeriodKind | null, nowMs: number): Promise<boolean> {
  const w = window(period, nowMs);
  return (await redis().set(key(notice, agentId, w.tag), "1", { ex: w.ttl, nx: true })) !== null;
}

/** Spend this period's notice without sending it: a heads-up after a pause or a switch says nothing new. */
export async function markBudgetNotice(agentId: string, notice: BudgetNotice, period: PeriodKind | null, nowMs: number): Promise<void> {
  const w = window(period, nowMs);
  await redis().set(key(notice, agentId, w.tag), "1", { ex: w.ttl });
}

/** Whether this period's notice is spent. A read before the work of deciding one; throws like claimBudgetNotice. */
export async function budgetNoticeSent(agentId: string, notice: BudgetNotice, period: PeriodKind | null, nowMs: number): Promise<boolean> {
  return (await redis().get(key(notice, agentId, window(period, nowMs).tag))) !== null;
}
