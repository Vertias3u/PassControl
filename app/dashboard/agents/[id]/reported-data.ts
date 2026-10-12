import { CLIENT_EVENTS_TABLE } from "@/lib/client-reported";
import type { ReportedCallRow, ReportedCallsRead, ToolDecisionRow, ToolDecisionsRead } from "@/components/ReportedCallsPanel";

const SHOWN = 50;
const COLUMNS =
  "event_key, kind, auth_method, client_session, client_agent, model, occurred_at, received_at, input_tokens, output_tokens, reported_cost_usd_micros, duration_ms, status_code";
const DECISION_COLUMNS =
  "event_key, auth_method, client_session, client_agent, occurred_at, received_at, tool_name, decision, rule_index, duration_ms";

// The query chain this reads, typed only as far as it is used. The parameter is
// `{ from(): unknown }`: matching the Supabase client against a full structural type
// sends the type checker into infinite instantiation.
type Query = {
  select: (columns: string) => Query;
  eq: (column: string, value: string) => Query;
  in: (column: string, values: string[]) => Query;
  order: (column: string, options: { ascending: boolean }) => Query;
  limit: (n: number) => PromiseLike<{ data: unknown; error: unknown }>;
};

/**
 * This agent's newest calls that Claude Code REPORTED (migration 0084), read with the
 * signed-in user's client, so RLS keeps it to their own rows.
 *
 * Any failed read, typically a database before 0084, is "unavailable" and the panel
 * shows nothing: the records are an addition to the agent page, never a reason for it
 * not to render.
 */
export async function readReportedCalls(db: { from: (table: string) => unknown }, agentId: string): Promise<ReportedCallsRead> {
  try {
    const { data, error } = await (db.from(CLIENT_EVENTS_TABLE) as Query)
      .select(COLUMNS)
      .eq("agent_id", agentId)
      .in("kind", ["model_call", "model_error"])
      .order("received_at", { ascending: false })
      .limit(SHOWN);
    if (error || !Array.isArray(data)) return { state: "unavailable" };
    return { state: "ok", rows: data as ReportedCallRow[] };
  } catch {
    return { state: "unavailable" };
  }
}

/**
 * This agent's newest tool decisions (subscription mode, Phase 2): what its tool
 * rules decided at Claude Code's PreToolUse hook, from the same table, the same way.
 */
export async function readToolDecisions(db: { from: (table: string) => unknown }, agentId: string): Promise<ToolDecisionsRead> {
  try {
    const { data, error } = await (db.from(CLIENT_EVENTS_TABLE) as Query)
      .select(DECISION_COLUMNS)
      .eq("agent_id", agentId)
      .in("kind", ["tool_decision"])
      .order("received_at", { ascending: false })
      .limit(SHOWN);
    if (error || !Array.isArray(data)) return { state: "unavailable" };
    return { state: "ok", rows: data as ToolDecisionRow[] };
  } catch {
    return { state: "unavailable" };
  }
}
