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

  const items: FleetAttentionItem[] = [];
  for (const agent of agents) {
    if (agent.status === "revoked") continue;
    const rows = byAgent.get(agent.id) ?? [];
    let lastSeenMs: number | null = null;
    let recentRefusals = 0;
    let burnedTokens = 0;
    let burnedMicrocents = 0;
    let oldestBurnMs = nowMs;

    for (const row of rows) {
      const at = timestamp(row.created_at);
      if (at === null || at > nowMs) continue;
      if (lastSeenMs === null || at > lastSeenMs) lastSeenMs = at;
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
