// Audit-log writes (service role). agent_logs is the append-only source of truth;
// agents.spent_* is a best-effort mirror for the dashboard.
import { serviceClient } from "./supabase";
import { captureError } from "./observability";

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
  const row = {
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
  };
  // One immediate retry covers transient PostgREST failures. If both attempts
  // fail, capture a generic error with identifiers only; never include request
  // bodies, credentials, or provider-key material in observability payloads.
  let { error } = await db.from("agent_logs").insert(row);
  if (error) ({ error } = await db.from("agent_logs").insert(row));
  if (error) {
    await captureError(new Error("agent log insert failed after retry"), {
      route: "lib.log.writeLog",
      method: "INSERT",
      status: 500,
      agentId: entry.agentId,
      jti: entry.jti,
      provider: entry.provider,
      code: "agent_log_insert_failed",
    });
  }
}

/** Best-effort mirror of cumulative spend onto the agents row. Cost is in µ¢. */
export async function mirrorSpend(
  agentId: string,
  addTokens: number,
  addMicrocents: number
): Promise<void> {
  const db = serviceClient();
  const params = {
    p_agent_id: agentId,
    p_tokens: addTokens,
    p_microcents: Math.round(addMicrocents),
  };
  let { error } = await db.rpc("increment_agent_spend", params);
  if (error) ({ error } = await db.rpc("increment_agent_spend", params));
  if (error) {
    await captureError(new Error("agent spend mirror failed after retry"), {
      route: "lib.log.mirrorSpend",
      method: "RPC",
      status: 500,
      agentId,
      code: "spend_mirror_failed",
    });
  }
}
