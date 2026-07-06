// Audit-log writes (service role). agent_logs is the append-only source of truth;
// agents.spent_* is a best-effort mirror for the dashboard.
import { serviceClient } from "./supabase";

export interface LogEntry {
  agentId: string;
  userId: string | null;
  passportId: string;
  jti: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costMicrocents?: number;
  status:
    | "ok"
    | "blocked_budget"
    | "blocked_endpoint"
    | "blocked_suspended"
    | "blocked_scope"
    | "upstream_error";
  latencyMs?: number;
}

export async function writeLog(entry: LogEntry): Promise<void> {
  const db = serviceClient();
  await db.from("agent_logs").insert({
    agent_id: entry.agentId,
    user_id: entry.userId,
    passport_id: entry.passportId,
    jti: entry.jti,
    provider: entry.provider ?? null,
    model: entry.model ?? null,
    input_tokens: entry.inputTokens ?? null,
    output_tokens: entry.outputTokens ?? null,
    cost_microcents: entry.costMicrocents != null ? Math.round(entry.costMicrocents) : null,
    status: entry.status,
    latency_ms: entry.latencyMs ?? null,
  });
}

/** Best-effort mirror of cumulative spend onto the agents row. Cost is in µ¢. */
export async function mirrorSpend(
  agentId: string,
  addTokens: number,
  addMicrocents: number
): Promise<void> {
  const db = serviceClient();
  await db.rpc("increment_agent_spend", {
    p_agent_id: agentId,
    p_tokens: addTokens,
    p_microcents: Math.round(addMicrocents),
  });
}
