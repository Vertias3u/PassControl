// Calendar UTC periods for the periodic spend limit (K1).
//
// Pure, and deliberately NOT in lib/state/holds.ts: the proxy needs this
// arithmetic for its own answers (the period a ledger seed covers, the
// retry-after on a refusal), and every proxy suite mocks the holds module
// wholesale. Arithmetic that disappears under a mock is arithmetic nobody tests.

/** The calendar UTC period a periodic limit counts over. */
export type PeriodKind = "day" | "month";

/**
 * What the caller knows about an agent's periodic limit.
 *
 *   skip    — this caller does not govern periods at all (a path that predates
 *             them). The snapshot is left exactly as it is.
 *   none    — the agent has no periodic limit. The snapshot is DELETED, so a
 *             limit the owner removed can never be enforced from it later.
 *   set     — the live limit, read from the agent row this call.
 *   unknown — the limit could not be read. The script enforces the last limit
 *             this generation actually enforced, if it has one, and otherwise
 *             nothing extra: an unknown must not become a new denial path, and
 *             the cumulative caps still hold.
 */
export type PeriodLimit =
  | { mode: "skip" }
  | { mode: "none" }
  | { mode: "set"; kind: PeriodKind; capMicrocents: number }
  | { mode: "unknown" };

/** The period keys current at `nowMs`, UTC. Lexically ordered within a kind. */
export function periodKeys(nowMs: number): { day: string; month: string } {
  const iso = new Date(nowMs).toISOString();
  return { day: `d:${iso.slice(0, 10)}`, month: `m:${iso.slice(0, 7)}` };
}

/** When the `kind` period containing `nowMs` began, UTC. */
export function periodStart(kind: PeriodKind, nowMs: number): Date {
  const d = new Date(nowMs);
  return kind === "day"
    ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Whole seconds until the next `kind` boundary after `nowMs`, at least 1. */
export function secondsUntilPeriodEnd(kind: PeriodKind, nowMs: number): number {
  const d = new Date(nowMs);
  const next =
    kind === "day"
      ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
      : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - nowMs) / 1000));
}
