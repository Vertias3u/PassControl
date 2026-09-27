// How a periodic spend limit (K1) is described on the dashboard.
//
// Pure, and shared by the fleet table and the agent header, so the two can
// never word the same number differently. It has three honest states and must
// not collapse them:
//
//   tracked      — the gateway's own figure for this period, from its snapshot.
//   not_started  — no snapshot yet. The gateway will count this period from the
//                  audit log on the agent's next call; until then it has no
//                  figure of its own, and printing "$0.00" would be a claim.
//   unavailable  — the read failed. Also not zero.
//
// Reservations still in flight are named separately: they count against the
// period until they settle, and one that never settles keeps counting against
// every later period until an operator resolves it.
import { MICROCENTS_PER_CENT } from "./pricing";
import type { PeriodKind } from "./period";

export interface PeriodUsageView {
  state: "tracked" | "not_started";
  usedMicrocents: number;
  heldMicrocents: number;
  openHolds: number;
}

export interface PeriodLimitSummary {
  state: "tracked" | "not_started" | "unavailable";
  /** One line for a table cell or a header. */
  text: string;
  /** Used + held, in cents, when tracked — for a meter. */
  countedCents: number | null;
  capCents: number;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/**
 * Money from micro-cents, to the cent when it is whole cents and to a hundredth
 * of a cent otherwise. Rounding $0.0075 to "$0.01 of $0.01 used" says the limit
 * is spent when three quarters of it is — found in a browser, on a small limit.
 */
export const usdFromMicrocents = (microcents: number): string =>
  microcents % MICROCENTS_PER_CENT === 0
    ? usd(microcents / MICROCENTS_PER_CENT)
    : `$${(microcents / (100 * MICROCENTS_PER_CENT)).toFixed(4)}`;

export function periodPhrase(kind: PeriodKind): string {
  return kind === "day" ? "today (UTC)" : "this month (UTC)";
}

export function periodLimitSummary(
  kind: PeriodKind,
  capCents: number,
  usage: PeriodUsageView | null | undefined
): PeriodLimitSummary {
  const per = kind === "day" ? "per UTC day" : "per UTC month";
  if (!usage) {
    return {
      state: "unavailable",
      text: `${usd(capCents)} ${per} — current usage unavailable`,
      countedCents: null,
      capCents,
    };
  }
  if (usage.state === "not_started") {
    return {
      state: "not_started",
      text: `${usd(capCents)} ${per} — counted from the audit log on the next call`,
      countedCents: null,
      capCents,
    };
  }
  const heldClause =
    usage.heldMicrocents > 0
      ? `, plus ${usdFromMicrocents(usage.heldMicrocents)} held by ${usage.openHolds} unfinished attempt${usage.openHolds === 1 ? "" : "s"}`
      : "";
  return {
    state: "tracked",
    text: `${usdFromMicrocents(usage.usedMicrocents)} of ${usd(capCents)} used ${periodPhrase(kind)}${heldClause}`,
    // Fractional cents on purpose: a meter's fill is a ratio, not a label.
    countedCents: (usage.usedMicrocents + usage.heldMicrocents) / MICROCENTS_PER_CENT,
    capCents,
  };
}
