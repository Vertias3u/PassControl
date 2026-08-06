// Audit-log writes (service role). agent_logs is the append-only source of truth;
// agents.spent_* is a best-effort mirror for the dashboard.
import { serviceClient } from "./supabase";
import { captureError } from "./observability";

export interface LogEntry {
  // Supplied by the proxy so the receipt id can go in a response header before
  // this row exists. Omitted elsewhere, where the DB default is fine.
  id?: string;
  // Detached EdDSA JWS over this call, verifiable by a third party against
  // /.well-known/jwks.json. Null when the deployment configures no signing key.
  // Written in the SAME insert as the row: migration 0006 rejects UPDATE on
  // agent_logs at depth 1 even for service_role, so it cannot be filled in later.
  receipt?: string | null;
  agentId: string;
  userId: string | null;
  passportId: string;
  jti: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costMicrocents?: number;
  // blocked_killed vs blocked_suspended distinguishes the kill switch (platform,
  // tenant, or denylist) from a per-agent suspend. Both answer 403
  // "blocked_suspended" on the wire — the split exists only here, for the audit
  // trail. agent_logs.status is plain text, so no migration gates a new value.
  status:
    | "ok"
    | "blocked_budget"
    | "blocked_endpoint"
    | "blocked_killed"
    | "blocked_suspended"
    | "blocked_scope"
    | "blocked_policy"
    | "upstream_error";
  latencyMs?: number;
}

export async function writeLog(entry: LogEntry): Promise<void> {
  const db = serviceClient();
  const row = {
    ...(entry.id ? { id: entry.id } : {}),
    // Omitted entirely when there is no receipt, rather than sent as null.
    //
    // This is what decouples the code from migration 0016. PostgREST rejects the
    // WHOLE insert if a named column does not exist, so sending `receipt: null`
    // unconditionally would mean a deployment running this code against a
    // pre-0016 schema writes NO audit rows at all — silently, on every call,
    // since agent_logs writes are best-effort. Omitting the key keeps a
    // deployment that has not enabled receipts byte-identical to before.
    // A deployment that DOES set INSTANCE_SIGNING_KEY must run 0016 first.
    ...(entry.receipt ? { receipt: entry.receipt } : {}),
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
  const isDuplicate = (e: unknown) => (e as { code?: string } | null)?.code === "23505";

  let { error } = await db.from("agent_logs").insert(row);
  // A duplicate on the FIRST attempt is not a lost response: something else
  // already wrote this id, which means reconcile ran twice. Don't retry it, and
  // don't swallow it — that is precisely the bug worth surfacing.
  if (error && !isDuplicate(error)) {
    ({ error } = await db.from("agent_logs").insert(row));
    // A duplicate on the RETRY means our own first insert actually landed and
    // only its response was lost. The row is there, so this is a success.
    // Reachable only since the caller started supplying `id`.
    if (isDuplicate(error)) return;
  }
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
