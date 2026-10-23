// The soft pause (1.6.0, L4): an agent stops at N % of its budget until its owner
// lets it go on, well before the hard limit refuses it (`agents.pause_percent`, 0087).
//
// A SOFT limit, and the code keeps it one:
//   * the proxy checks it once, before any hold, and the hard budget's atomic
//     reserve still runs behind it. Two calls racing past the line can both get
//     through; the hard limit cannot be raced, and that is the one that protects
//     the money;
//   * it decides from the same BudgetView `/self` shows (lib/budget-view.ts), so
//     the refusal and the status line quote the same figure;
//   * a usage that cannot be read never pauses. The hard budget still decides, and
//     it fails closed on its own state. A lift that cannot be read is the other
//     way round: past the line the agent stays paused (lib/state/pause.ts), because
//     the owner chose the pause and only the owner lets it go.
import { budgetView, readPeriodCounted, type BudgetView, type PeriodInput } from "@/lib/budget-view";
import { secondsUntilPeriodEnd, type PeriodKind } from "@/lib/period";
import { readBudgetSnapshot } from "@/lib/state/redis";

/** How long "let it go on" lasts. */
export const PAUSE_LIFT_SECONDS = 3600;

export interface PauseLine {
  limit: "period" | "cost" | "tokens";
  period?: PeriodKind;
  /** The owner's line, 1–99. */
  percent: number;
  /** How far in the agent is, rounded down. */
  usedPercent: number;
  used: number;
  cap: number;
}

/** True when `used` is at or past `percent` of `cap`. Integer maths: no float edge at the line. */
function past(used: number | null, cap: number, percent: number): used is number {
  return used !== null && cap > 0 && used * 100 >= cap * percent;
}

/**
 * The first limit at or past the pause line, or null when the agent may go on.
 * Null too when nothing can be read: an unknown is never a pause.
 */
export function pauseLine(view: BudgetView, percent: number): PauseLine | null {
  const line = (limit: PauseLine["limit"], used: number, cap: number, period?: PeriodKind): PauseLine => ({
    limit,
    ...(period ? { period } : {}),
    percent,
    usedPercent: Math.floor((used * 100) / cap),
    used,
    cap,
  });
  const p = view.period;
  if (p && !("unknown" in p) && past(p.used_microcents, p.limit_microcents, percent)) {
    return line("period", p.used_microcents, p.limit_microcents, p.kind);
  }
  const c = view.cost;
  if (c && past(c.used_microcents, c.limit_microcents, percent)) return line("cost", c.used_microcents, c.limit_microcents);
  const t = view.tokens;
  if (t && past(t.used, t.limit, percent)) return line("tokens", t.used, t.limit);
  return null;
}

const usd = (microcents: number) => `$${(microcents / 100_000_000).toFixed(2)}`;

/** What was reached, in words: "today's spend is 82% of its limit ($16.40 of $20.00)". */
export function pauseReached(line: PauseLine): string {
  return line.limit === "period"
    ? `${line.period === "month" ? "this month's" : "today's"} spend is ${line.usedPercent}% of its limit (${usd(line.used)} of ${usd(line.cap)})`
    : line.limit === "cost"
      ? `its total spend is ${line.usedPercent}% of its budget (${usd(line.used)} of ${usd(line.cap)})`
      : `its token use is ${line.usedPercent}% of its limit (${line.used.toLocaleString("en-US")} of ${line.cap.toLocaleString("en-US")} tokens)`;
}

/** The refusal's reason, for the agent and its log. Names no rule it cannot see. */
export function pauseMessage(line: PauseLine): string {
  return (
    `PassControl paused this agent: ${pauseReached(line)}, past the ${line.percent}% pause line. ` +
    "Its owner can let it go on for an hour from the agent's page in the dashboard; the limit itself still applies."
  );
}

/** How long a lift lasts: an hour, or until a periodic limit resets, whichever is sooner. */
export function liftSeconds(period: PeriodKind | null, nowMs: number): number {
  return period ? Math.max(1, Math.min(PAUSE_LIFT_SECONDS, secondsUntilPeriodEnd(period, nowMs))) : PAUSE_LIFT_SECONDS;
}

/**
 * The usage the pause line is drawn on, read as `/self` reads it. The counters
 * only: the proxy has no business reading the database mirror on the hot path, and
 * a counter it cannot read is an unknown, which never pauses.
 */
export async function readPauseView(
  agentId: string,
  caps: { capTokens: number | null; capMicrocents: number | null; period: { kind: PeriodKind; capMicrocents: number } | null },
  nowMs: number
): Promise<BudgetView> {
  const [snapshot, period] = await Promise.all([
    caps.capTokens != null || caps.capMicrocents != null ? readBudgetSnapshot(agentId).catch(() => null) : Promise.resolve(null),
    (async (): Promise<PeriodInput> =>
      caps.period
        ? {
            mode: "set",
            kind: caps.period.kind,
            capMicrocents: caps.period.capMicrocents,
            counted: await readPeriodCounted(agentId, caps.period.kind, nowMs),
          }
        : { mode: "none" })(),
  ]);
  return budgetView({ capTokens: caps.capTokens, capMicrocents: caps.capMicrocents, snapshot, mirror: null, period, nowMs });
}

/** The pause as GET /api/v1/self states it (L4c). */
export interface PauseStatus {
  percent: number;
  /** True when the proxy would refuse the next call for the pause. */
  paused: boolean;
  /** The limit past the line, or null below it. */
  limit: PauseLine["limit"] | null;
  /** When the owner's lift ends, or null with none. */
  lifted_until: string | null;
  /**
   * The owner's cheaper model at the line (L7, 0088), present only when one is
   * set. `active` while the gateway sends this provider's calls to it: past the
   * line, with no lift. Then `paused` is false, though a call to any other
   * provider, or an embeddings call, still pauses.
   */
  switch_to?: { provider: string; model: string; active: boolean };
}

/**
 * Where an agent is against its pause line, decided as the proxy decides it: an
 * unknown usage is below the line, and past it a lift that cannot be read is no
 * lift. The lift is read only past the line. Not the proxy's Telegram drain: a tap
 * not read yet is read on the agent's next call, and `/self` writes nothing.
 */
export async function pauseStatus(
  view: BudgetView,
  percent: number,
  readLiftEnd: () => Promise<number | null>,
  switchTo: { provider: string; model: string } | null = null,
  /** Whether the gateway would send the switch: false when the scope no longer allows it. */
  switchUsable = true
): Promise<PauseStatus> {
  const line = pauseLine(view, percent);
  const sw = (active: boolean) => (switchTo ? { switch_to: { provider: switchTo.provider, model: switchTo.model, active } } : {});
  if (!line) return { percent, paused: false, limit: null, lifted_until: null, ...sw(false) };
  const end = await readLiftEnd().catch(() => null);
  return end === null
    ? { percent, paused: !(switchTo && switchUsable), limit: line.limit, lifted_until: null, ...sw(switchUsable) }
    : { percent, paused: false, limit: line.limit, lifted_until: new Date(end).toISOString(), ...sw(false) };
}
