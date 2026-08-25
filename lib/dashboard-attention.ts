export const BUDGET_ATTENTION_RATIO = 0.8;

const DAY_MS = 86_400_000;
const RECENT_BURN_MS = 7 * DAY_MS;
const RECENT_REFUSAL_MS = DAY_MS;
const INACTIVE_MS = 7 * DAY_MS;
const EXPIRY_WARNING_MS = 14 * DAY_MS;
const NEAR_PROJECTION_MS = 7 * DAY_MS;

export interface AttentionAgent {
  id: string;
  name: string;
  status: string;
  budget_tokens: number | null;
  budget_cents: number | null;
  spent_tokens: number | null;
  spent_microcents: number | null;
  expires_at?: string | null;
  /**
   * The reconcile/challenge stamp. Optional because most callers care only
   * about budgets — but when it IS present it must be resolved the same way the
   * fleet table resolves it, or the two disagree. See buildFleetAttention.
   */
  last_seen_at?: string | null;
}

export interface AttentionLog {
  agent_id: string | null;
  created_at: string | null;
  status: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_microcents: number | null;
}

export type AttentionKind =
  | "suspended"
  | "passport"
  | "budget"
  | "refusals"
  | "inactive";

export interface AttentionReason {
  kind: AttentionKind;
  label: string;
  detail: string;
  tone: "danger" | "warning" | "neutral";
}

export interface FleetAttentionItem {
  agentId: string;
  agentName: string;
  score: number;
  reasons: AttentionReason[];
  lastSeenAt: string | null;
  recentRefusals: number;
  budgetRatio: number;
  projectedExhaustionAt: string | null;
}

export function budgetRiskRatio(agent: AttentionAgent): number {
  const token =
    agent.budget_tokens != null && agent.budget_tokens > 0
      ? Math.max(0, agent.spent_tokens ?? 0) / agent.budget_tokens
      : 0;
  const cost =
    agent.budget_cents != null && agent.budget_cents > 0
      ? Math.max(0, agent.spent_microcents ?? 0) / (agent.budget_cents * 1_000_000)
      : 0;
  return Math.max(token, cost);
}

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The newest usable `created_at` per agent in one bounded log scan.
 *
 * The single derivation of "when did we last see this agent from its calls".
 * `buildFleetAttention` and `withLastSeenFromLogs` both read it, so the operator
 * queue and the fleet table cannot report different answers — which they did,
 * visibly, in one viewport, before this existed.
 */
function newestCallByAgent(logs: readonly AttentionLog[], nowMs: number): Map<string, number> {
  const newest = new Map<string, number>();
  for (const log of logs) {
    if (!log.agent_id) continue;
    const at = timestamp(log.created_at);
    // A future timestamp is discarded rather than clamped, exactly as the
    // attention scan discards it: a clock-skewed row must not become "now".
    if (at === null || at > nowMs) continue;
    const seen = newest.get(log.agent_id);
    if (seen === undefined || at > seen) newest.set(log.agent_id, at);
  }
  return newest;
}

/**
 * Resolve each agent's `last_seen_at` against the log scan, taking whichever
 * evidence is newer.
 *
 * `agents.last_seen_at` is written only by the nightly reconcile flush of
 * `lastseen:<agid>`, so it lags by up to a day — and for a Direct Agent Key
 * agent it was never written at all until the proxy learned to stamp it, which
 * left the fleet table reading "never" for an agent that had called minutes
 * before. A recorded call is evidence the agent was seen, so it belongs here.
 *
 * The column can still legitimately LEAD: a passport stamps it at the challenge,
 * before any call is recorded. So this takes the maximum, never a side. And it
 * only ever adds evidence — an agent with neither a stamp nor a call keeps its
 * honest `null`, because "never" is a real answer and must not be invented away.
 */
export function withLastSeenFromLogs<T extends { id: string; last_seen_at: string | null }>(
  agents: readonly T[],
  logs: readonly AttentionLog[],
  now: Date = new Date()
): T[] {
  const newest = newestCallByAgent(logs, now.getTime());
  return agents.map((agent) => {
    const fromLogs = newest.get(agent.id);
    if (fromLogs === undefined) return agent;
    const stamped = timestamp(agent.last_seen_at);
    if (stamped !== null && stamped >= fromLogs) return agent;
    return { ...agent, last_seen_at: new Date(fromLogs).toISOString() };
  });
}

function projectedDate(
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

/**
 * Builds the operator queue from one bounded tenant log scan. The reconciled
 * agent counters remain the numerator beside the fleet meters; logs contribute
 * only recent burn, refusal evidence, and last-seen evidence.
 */
export function buildFleetAttention(
  agents: readonly AttentionAgent[],
  logs: readonly AttentionLog[],
  now: Date = new Date()
): FleetAttentionItem[] {
  const nowMs = now.getTime();
  const byAgent = new Map<string, AttentionLog[]>();
  for (const log of logs) {
    if (!log.agent_id) continue;
    const rows = byAgent.get(log.agent_id) ?? [];
    rows.push(log);
    byAgent.set(log.agent_id, rows);
  }
  // Shared with the fleet table via `withLastSeenFromLogs`, so the queue and the
  // table cannot answer "when was this agent last seen" differently.
  //
  // Sharing the scan is not enough on its own: the table takes the MAXIMUM of
  // this scan and the stored column, and the scan is bounded (ATTENTION_SCAN_DAYS
  // / ATTENTION_SCAN_LIMIT). A busy tenant's older calls fall outside it, and
  // reading the scan alone would print "No recent activity" beside the timestamp
  // the table renders from the column. So the same maximum is taken below.
  const newestCall = newestCallByAgent(logs, nowMs);

  const items: FleetAttentionItem[] = [];
  for (const agent of agents) {
    if (agent.status === "revoked") continue;
    const rows = byAgent.get(agent.id) ?? [];
    // Same rule as withLastSeenFromLogs: whichever evidence is newer, and a
    // future stamp is discarded rather than clamped (timestamp() does not, so
    // it is checked here exactly as newestCallByAgent checks a log row).
    const fromLogs = newestCall.get(agent.id) ?? null;
    const stamped = timestamp(agent.last_seen_at ?? null);
    const fromColumn = stamped !== null && stamped <= nowMs ? stamped : null;
    const evidence = [fromLogs, fromColumn].filter((at): at is number => at !== null);
    // Max, not a preferred side — and still null when there is no evidence at
    // all, because "never" is a real answer and must not be invented away.
    const lastSeenMs = evidence.length === 0 ? null : Math.max(...evidence);
    let recentRefusals = 0;
    let burnedTokens = 0;
    let burnedMicrocents = 0;
    let oldestBurnMs = nowMs;

    for (const row of rows) {
      const at = timestamp(row.created_at);
      if (at === null || at > nowMs) continue;
      const age = nowMs - at;
      if (age <= RECENT_REFUSAL_MS && (row.status ?? "").startsWith("blocked_")) {
        recentRefusals += 1;
      }
      if (age <= RECENT_BURN_MS) {
        burnedTokens += Math.max(0, row.input_tokens ?? 0) + Math.max(0, row.output_tokens ?? 0);
        burnedMicrocents += Math.max(0, row.cost_microcents ?? 0);
        oldestBurnMs = Math.min(oldestBurnMs, at);
      }
    }

    const observedMs = Math.min(
      RECENT_BURN_MS,
      Math.max(DAY_MS, nowMs - oldestBurnMs)
    );
    const tokenProjection = projectedDate(
      Math.max(0, agent.spent_tokens ?? 0),
      agent.budget_tokens,
      burnedTokens,
      observedMs,
      nowMs
    );
    const costProjection = projectedDate(
      Math.max(0, agent.spent_microcents ?? 0),
      agent.budget_cents == null ? null : agent.budget_cents * 1_000_000,
      burnedMicrocents,
      observedMs,
      nowMs
    );
    const projections = [tokenProjection, costProjection].filter(
      (value): value is number => value !== null
    );
    const projectionMs = projections.length ? Math.min(...projections) : null;
    const ratio = budgetRiskRatio(agent);
    const reasons: AttentionReason[] = [];
    let score = 0;

    if (agent.status === "suspended") {
      reasons.push({
        kind: "suspended",
        label: "Suspended",
        detail: "Every new call is refused until an operator reactivates this agent.",
        tone: "danger",
      });
      score = Math.max(score, 100);
    }

    const expiryMs = timestamp(agent.expires_at);
    if (expiryMs !== null && expiryMs <= nowMs + EXPIRY_WARNING_MS) {
      const expired = expiryMs <= nowMs;
      reasons.push({
        kind: "passport",
        label: expired ? "Passport expired" : "Passport expiring",
        detail: expired
          ? "This public key can no longer mint a visa."
          : "Rotate or extend it before the deadline.",
        tone: expired ? "danger" : "warning",
      });
      score = Math.max(score, expired ? 96 : 74);
    }

    const projectedSoon = projectionMs !== null && projectionMs <= nowMs + NEAR_PROJECTION_MS;
    if (ratio >= BUDGET_ATTENTION_RATIO || projectedSoon) {
      reasons.push({
        kind: "budget",
        label: ratio >= 1 ? "Budget exhausted" : projectedSoon ? "Budget burn risk" : "Budget near limit",
        detail:
          ratio >= 1
            ? "The reconciled budget meter has reached its cap."
            : `${Math.round(ratio * 100)}% of the tighter reconciled budget is used.`,
        tone: ratio >= 1 || (projectionMs !== null && projectionMs <= nowMs + DAY_MS) ? "danger" : "warning",
      });
      score = Math.max(score, ratio >= 1 ? 94 : projectedSoon ? 86 : 82);
    }

    if (recentRefusals > 0) {
      reasons.push({
        kind: "refusals",
        label: `${recentRefusals} recent refusal${recentRefusals === 1 ? "" : "s"}`,
        detail: "Blocked attempts recorded in the last 24 hours.",
        tone: "warning",
      });
      score = Math.max(score, 70 + Math.min(9, recentRefusals));
    }

    if (lastSeenMs === null || nowMs - lastSeenMs >= INACTIVE_MS) {
      reasons.push({
        kind: "inactive",
        label: lastSeenMs === null ? "No recent activity" : "Inactive",
        detail:
          lastSeenMs === null
            ? "No call appears in the bounded 30-day activity scan."
            : "No governed call has been recorded for at least seven days.",
        tone: "neutral",
      });
      score = Math.max(score, lastSeenMs === null ? 60 : 58);
    }

    if (!reasons.length) continue;
    items.push({
      agentId: agent.id,
      agentName: agent.name,
      score: score + Math.min(4, reasons.length - 1),
      reasons,
      lastSeenAt: lastSeenMs === null ? null : new Date(lastSeenMs).toISOString(),
      recentRefusals,
      budgetRatio: ratio,
      projectedExhaustionAt:
        projectionMs === null ? null : new Date(projectionMs).toISOString(),
    });
  }

  return items.sort((a, b) => b.score - a.score || a.agentName.localeCompare(b.agentName));
}
