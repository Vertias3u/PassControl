// The agent page's view of the soft pause (1.6.0, L4): the owner's line, where the
// agent is against it, and whether it has been let go on.
//
// Read on its own, not on the page's agent select, so a database without 0087
// loses this panel and not the page. The same reads the gateway makes
// (lib/budget-pause.ts), so the page shows the figure the gateway decides on.
import type { SwitchModel } from "@/lib/cheaper-model";
import type { SupabaseClient } from "@supabase/supabase-js";

import { pauseLine, readPauseView, type PauseLine } from "@/lib/budget-pause";
import { MICROCENTS_PER_CENT } from "@/lib/pricing";
import { pollTelegramDecisions } from "@/lib/alerts/approvals";
import { pausePromptOpen, readPauseLiftEnd } from "@/lib/state/pause";

export interface AgentPauseState {
  percent: number;
  /** The limit past the line, or null while the agent is below it (or its usage is unreadable). */
  line: PauseLine | null;
  /** When a lift ends, ISO; null with none. */
  liftedUntil: string | null;
  /** The lift could not be read: the gateway cannot assume permission to go past the line. */
  liftUnknown: boolean;
  switchTo: SwitchModel | null;
}

type Row = {
  pause_percent?: unknown;
  pause_action?: unknown;
  pause_switch_provider?: unknown;
  pause_switch_model?: unknown;
  budget_tokens?: unknown;
  budget_cents?: unknown;
  budget_period?: unknown;
  budget_period_cents?: unknown;
};

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Null when the agent has no pause line, or the line cannot be read. */
export async function readAgentPauseState(
  db: Pick<SupabaseClient, "from">,
  userId: string,
  agentId: string,
  nowMs = Date.now()
): Promise<AgentPauseState | null> {
  try {
    const columns = "pause_percent, budget_tokens, budget_cents, budget_period, budget_period_cents";
    const read = (selection: string) => db
      .from("agents")
      .select(selection)
      .eq("user_id", userId)
      .eq("id", agentId)
      .maybeSingle();
    let result = await read(`${columns}, pause_action, pause_switch_provider, pause_switch_model`);
    // 0087 installations still have a pause panel before the additive 0088 switch
    // columns arrive. Only a missing-column error retries the original read.
    if (result.error?.code === "42703" || result.error?.code === "PGRST204") {
      result = await read(columns);
    }
    const { data, error } = result;
    if (error || !data) return null;
    const row = data as Row;
    const percent = num(row.pause_percent);
    if (percent === null) return null;
    const cents = num(row.budget_cents);
    const periodCents = num(row.budget_period_cents);
    const kind = row.budget_period === "day" || row.budget_period === "month" ? row.budget_period : null;
    const view = await readPauseView(
      agentId,
      {
        capTokens: num(row.budget_tokens),
        capMicrocents: cents === null ? null : cents * MICROCENTS_PER_CENT,
        period: kind && periodCents !== null ? { kind, capMicrocents: periodCents * MICROCENTS_PER_CENT } : null,
      },
      nowMs
    ).catch(() => null);
    const line = view ? pauseLine(view, percent) : null;
    // A Telegram "Let it go on" tap (L4b) may be waiting to be read: read it first,
    // so the page does not show a pause the owner already lifted.
    if (line && (await pausePromptOpen(agentId).catch(() => false))) {
      await pollTelegramDecisions(userId, 0, 1500).catch(() => undefined);
    }
    let liftedUntil: string | null = null;
    let liftUnknown = false;
    try {
      const end = await readPauseLiftEnd(agentId, nowMs);
      liftedUntil = end === null ? null : new Date(end).toISOString();
    } catch {
      liftUnknown = true;
    }
    // Match the policy reader: only an explicit switch with both fields names
    // a continuing provider. Old rows and incomplete configuration still pause.
    const switchTo = row.pause_action === "switch" &&
      typeof row.pause_switch_provider === "string" && row.pause_switch_provider &&
      typeof row.pause_switch_model === "string" && row.pause_switch_model
      ? { provider: row.pause_switch_provider, model: row.pause_switch_model }
      : null;
    return { percent, line, liftedUntil, liftUnknown, switchTo };
  } catch {
    return null;
  }
}
