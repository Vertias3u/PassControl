// The heads-up before a limit (1.6.0, L8): one alert to the workspace a few hours
// before an agent reaches its daily or monthly limit, at the rate it has spent this
// period. When the owner drew a pause line on the limit, it aims at the line, and
// says whether the agent will pause there or switch to its cheaper model.
//
// Checked after a charged call settles, inside waitUntil: never on the request
// path, and it never throws. Periodic limits only: a lifetime cap's rate comes from
// the ledger's last day (readRecentSpend), a database read per call. Once a period
// (lib/state/budget-notice.ts), and a pause, a period refusal or a switch spends the
// period's heads-up, since it would only say what they said.
import { MIN_OBSERVED_MS, projectedDate } from "@/lib/budget-pace";
import { periodStart, secondsUntilPeriodEnd, type PeriodKind } from "@/lib/period";

/** How far ahead a heads-up looks. */
export const HEADSUP_WINDOW_MS = 3 * 3600_000;

export interface HeadsUp {
  /** The limit itself, or the pause line on it, where the agent pauses or switches. */
  target: "limit" | "pause" | "switch";
  atMs: number;
  targetMicrocents: number;
  switchModel?: string;
}

export function headsUp(input: {
  kind: PeriodKind;
  capMicrocents: number;
  usedMicrocents: number;
  nowMs: number;
  pausePercent: number | null;
  switchModel: string | null;
}): HeadsUp | null {
  const { kind, capMicrocents, usedMicrocents: used, nowMs, pausePercent } = input;
  if (!(capMicrocents > 0) || !(used > 0)) return null;
  const line = pausePercent !== null && pausePercent >= 1 && pausePercent <= 99;
  const target = line ? Math.floor((capMicrocents * pausePercent) / 100) : capMicrocents;
  // Reached already: the refusal, the pause or the switch says so itself.
  if (used >= target) return null;
  const elapsed = nowMs - periodStart(kind, nowMs).getTime();
  if (elapsed < MIN_OBSERVED_MS) return null;
  const at = projectedDate(used, target, used, elapsed, nowMs);
  if (at === null || at - nowMs > HEADSUP_WINDOW_MS) return null;
  if (at > nowMs + secondsUntilPeriodEnd(kind, nowMs) * 1000) return null;
  if (!line) return { target: "limit", atMs: at, targetMicrocents: target };
  return input.switchModel
    ? { target: "switch", atMs: at, targetMicrocents: target, switchModel: input.switchModel }
    : { target: "pause", atMs: at, targetMicrocents: target };
}

/** What notifyWorkspace carries for a heads-up. */
export interface HeadsUpAlert {
  target: HeadsUp["target"];
  /** ISO time the target is reached at this rate. */
  at: string;
  period: PeriodKind;
  spentMicrocents: number;
  targetMicrocents: number;
  percent?: number;
  model?: string;
}

export async function noteHeadsUp(input: {
  userId: string;
  agentId: string;
  kind: PeriodKind;
  capMicrocents: number;
  pausePercent: number | null;
  switchModel: string | null;
  origin: string;
  nowMs: number;
  sent: (agentId: string, notice: "headsup", period: PeriodKind, nowMs: number) => Promise<boolean>;
  claim: (agentId: string, notice: "headsup", period: PeriodKind, nowMs: number) => Promise<boolean>;
  readCounted: (agentId: string, kind: PeriodKind, nowMs: number) => Promise<number | null>;
  notify: (alert: {
    userId: string;
    agentId: string;
    type: "budget";
    status: "budget_headsup";
    origin: string;
    headsUp: HeadsUpAlert;
  }) => Promise<void>;
}): Promise<boolean> {
  try {
    // The cheap read first: the usage read below can reach Postgres.
    if (await input.sent(input.agentId, "headsup", input.kind, input.nowMs)) return false;
    const used = await input.readCounted(input.agentId, input.kind, input.nowMs);
    if (used === null) return false;
    const h = headsUp({ ...input, usedMicrocents: used });
    if (!h) return false;
    if (!(await input.claim(input.agentId, "headsup", input.kind, input.nowMs))) return false;
    await input.notify({
      userId: input.userId,
      agentId: input.agentId,
      type: "budget",
      status: "budget_headsup",
      origin: input.origin,
      headsUp: {
        target: h.target,
        at: new Date(h.atMs).toISOString(),
        period: input.kind,
        spentMicrocents: used,
        targetMicrocents: h.targetMicrocents,
        ...(h.target !== "limit" && input.pausePercent !== null ? { percent: input.pausePercent } : {}),
        ...(h.switchModel ? { model: h.switchModel } : {}),
      },
    });
    return true;
  } catch {
    return false;
  }
}
