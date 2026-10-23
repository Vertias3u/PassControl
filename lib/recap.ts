/** Read-only weekly recap. Delivery belongs to the alert/cron adapters. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient } from "@/lib/supabase";
import { inertName } from "@/lib/alerts/destination";

export interface RecapPeriod {
  /** Half-open UTC week: start is included, end is excluded. */
  start: string;
  end: string;
  previousStart: string;
}

export interface RecapTotals {
  spentMicrocents: number;
  previousSpentMicrocents: number;
  calls: number;
  refusedCalls: number;
  pausedCalls: number;
}

export interface RecapAgent extends RecapTotals {
  id: string;
  name: string;
  /** Most-used models by admitted call count, then provider/model for ties. */
  topModels: { provider: string; model: string; calls: number }[];
}

export type WeeklyRecap = {
  state: "ready" | "empty";
  period: RecapPeriod;
  totals: RecapTotals;
  /** At most ten; totals still include all agents. */
  agents: RecapAgent[];
  moreAgents: number;
  text: string;
} | {
  state: "unavailable";
  period: RecapPeriod;
  /** Never hand a delivery adapter partial numbers or a false empty week. */
  text: null;
};

const WEEK_MS = 7 * 86_400_000;
const MAX_AGENTS = 10;

/** Last completed Monday-to-Monday week: the card and Monday delivery agree. */
export function weeklyRecapPeriod(at = new Date()): RecapPeriod {
  const monday = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
    - ((at.getUTCDay() + 6) % 7) * 86_400_000;
  return {
    start: new Date(monday - WEEK_MS).toISOString(),
    end: new Date(monday).toISOString(),
    previousStart: new Date(monday - 2 * WEEK_MS).toISOString(),
  };
}

export function formatRecapMoney(microcents: number): string {
  return `$${(microcents / 100_000_000).toFixed(2)}`;
}

function recapName(value: string): string {
  // inertName removes control characters and backticks. Plain-text chat can
  // still turn @names into mentions, so also remove mention/markup delimiters.
  return inertName(value).replace(/[@<>*_~|\[\]\\]/gu, "").trim() || "unnamed agent";
}

function modelLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9._:/-]/gu, "?").slice(0, 64) || "unknown";
}

/** Both outputs use these same numbers; formatting never reads the database. */
export function buildWeeklyRecap(period: RecapPeriod, rows: RecapAgent[]): WeeklyRecap {
  const totals = rows.reduce<RecapTotals>((sum, row) => ({
    spentMicrocents: sum.spentMicrocents + row.spentMicrocents,
    previousSpentMicrocents: sum.previousSpentMicrocents + row.previousSpentMicrocents,
    calls: sum.calls + row.calls,
    refusedCalls: sum.refusedCalls + row.refusedCalls,
    pausedCalls: sum.pausedCalls + row.pausedCalls,
  }), { spentMicrocents: 0, previousSpentMicrocents: 0, calls: 0, refusedCalls: 0, pausedCalls: 0 });
  if (Object.values(totals).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    return { state: "unavailable", period, text: null };
  }
  const dates = `${period.start.slice(0, 10)} to ${period.end.slice(0, 10)} UTC`;
  if (totals.calls === 0 && totals.spentMicrocents === 0) {
    return { state: "empty", period, totals, agents: [], moreAgents: 0, text: `No activity for ${dates}.` };
  }
  const active = rows.filter((row) => row.calls > 0 || row.spentMicrocents > 0 || row.previousSpentMicrocents > 0)
    .map((row) => ({ ...row, name: recapName(row.name), topModels: row.topModels.slice(0, 3).map((model) => ({
      ...model, provider: modelLabel(model.provider), model: modelLabel(model.model),
    })) }))
    .sort((a, b) => b.spentMicrocents - a.spentMicrocents || a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"));
  const agents = active.slice(0, MAX_AGENTS);
  const moreAgents = active.length - agents.length;
  const lines = [`Weekly spend recap: ${dates} (Monday 00:00 to Monday 00:00).`];
  for (const agent of agents) {
    const models = agent.topModels.map((model) => `${model.provider}/${model.model} (${model.calls})`).join(", ") || "none";
    lines.push(`${agent.name}: ${formatRecapMoney(agent.spentMicrocents)} (previous ${formatRecapMoney(agent.previousSpentMicrocents)}); top models by calls: ${models}; ${agent.refusedCalls} refused, ${agent.pausedCalls} paused.`);
  }
  if (moreAgents > 0) lines.push(`and ${moreAgents} more`);
  return { state: "ready", period, totals, agents, moreAgents, text: lines.join("\n") };
}

const PAGE_SIZE = 500;
const SPEND_CONCURRENCY = 4;

type AgentRow = { id: string; name: string; user_id: string };
type CallRow = { agent_id: string | null; status: string; provider: string | null; model: string | null };
type ModelCount = RecapAgent["topModels"][number];

/** SQL bigint may arrive as a string. Missing or unsafe amounts are not zero. */
function amount(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") throw new Error("Missing ledger amount");
  if (typeof value === "string" && !/^\d+$/u.test(value)) throw new Error("Invalid ledger amount");
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid ledger amount");
  return number;
}

async function spendSince(db: SupabaseClient, ownedAgentId: string, since: string): Promise<number> {
  // This legacy RPC has no user_id argument/return column. Only IDs from the
  // tenant-filtered agents query below may reach it (owner-approved contract).
  const { data, error } = await db.rpc("agent_period_spend", { p_agent_id: ownedAgentId, p_since: since });
  if (error || !Array.isArray(data) || data.length !== 1) throw new Error("Unreadable ledger spend");
  return amount(data[0]?.spent_microcents);
}

async function weeklySpend(db: SupabaseClient, ownedAgentId: string, period: RecapPeriod) {
  // agent_period_spend is cumulative since a moment. Subtract adjacent Monday
  // totals to get each closed week, including adjustments. Read the excluded
  // tail before and after: if it changed, independent snapshots could charge a
  // current-week call to a closed week. Return unavailable and let a later read
  // retry rather than publish that mixed result.
  const tail = await spendSince(db, ownedAgentId, period.end);
  const [current, previous] = await Promise.all([
    spendSince(db, ownedAgentId, period.start),
    spendSince(db, ownedAgentId, period.previousStart),
  ]);
  const tailAfter = await spendSince(db, ownedAgentId, period.end);
  if (tail !== tailAfter || current < tail || previous < current) throw new Error("Ledger changed during recap read");
  return { spentMicrocents: current - tail, previousSpentMicrocents: previous - current };
}

/**
 * One read pipeline for both outputs, for the last completed UTC week.
 * All table pages explicitly filter the tenant; RPC IDs come ONLY from that
 * owned fleet. No writes, alert sends, Redis or enforcement-path dependencies.
 */
export async function readWeeklyRecap(userId: string, at = new Date()): Promise<WeeklyRecap> {
  const period = weeklyRecapPeriod(at);
  try {
    if (!userId) throw new Error("A workspace is required");
    // Construction can fail too (missing service env); keep it inside the same
    // boundary as query failures so the rest of the overview still renders.
    const db = serviceClient();
    const agents = new Map<string, RecapAgent>();
    const models = new Map<string, Map<string, ModelCount>>();
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await db.from("agents").select("id,name,user_id")
        .eq("user_id", userId).order("id").range(offset, offset + PAGE_SIZE - 1);
      if (error || !Array.isArray(data)) throw new Error("Unreadable owned fleet");
      for (const row of data as AgentRow[]) {
        if (row.user_id !== userId || !row.id || typeof row.name !== "string") throw new Error("Invalid owned agent");
        agents.set(row.id, { id: row.id, name: row.name, spentMicrocents: 0, previousSpentMicrocents: 0,
          calls: 0, refusedCalls: 0, pausedCalls: 0, topModels: [] });
        models.set(row.id, new Map());
      }
      if (data.length < PAGE_SIZE) break;
    }
    // Fold only the small metadata needed for counts; never load receipts,
    // credentials or the complete log history into the recap.
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await db.from("agent_logs").select("agent_id,status,provider,model")
        .eq("user_id", userId).gte("created_at", period.start).lt("created_at", period.end)
        .order("id").range(offset, offset + PAGE_SIZE - 1);
      if (error || !Array.isArray(data)) throw new Error("Unreadable call metadata");
      for (const row of data as CallRow[]) {
        const agent = row.agent_id ? agents.get(row.agent_id) : undefined;
        if (!agent || typeof row.status !== "string") throw new Error("Unresolved call ownership");
        agent.calls++;
        if (row.status === "blocked_budget_pause") agent.pausedCalls++;
        else if (row.status.startsWith("blocked_")) agent.refusedCalls++;
        if ((row.status === "ok" || row.status === "usage_unknown") && row.model) {
          const provider = row.provider ?? "unknown";
          const key = JSON.stringify([provider, row.model]);
          const counts = models.get(agent.id)!;
          const model = counts.get(key) ?? { provider, model: row.model, calls: 0 };
          model.calls++;
          counts.set(key, model);
        }
      }
      if (data.length < PAGE_SIZE) break;
    }
    const rows = [...agents.values()];
    // Bound RPC concurrency for a large fleet instead of issuing four calls for
    // every agent at once. The metadata and spend still feed just one recap.
    for (let offset = 0; offset < rows.length; offset += SPEND_CONCURRENCY) {
      await Promise.all(rows.slice(offset, offset + SPEND_CONCURRENCY).map(async (agent) => {
        Object.assign(agent, await weeklySpend(db, agent.id, period));
        agent.topModels = [...models.get(agent.id)!.values()]
          .sort((a, b) => b.calls - a.calls || a.provider.localeCompare(b.provider, "en") || a.model.localeCompare(b.model, "en"))
          .slice(0, 3);
      }));
    }
    return buildWeeklyRecap(period, rows);
  } catch {
    return { state: "unavailable", period, text: null };
  }
}
