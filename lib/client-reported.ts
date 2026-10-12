// Model calls a client REPORTED (subscription mode, Phase 1b; migration 0084).
//
// A Claude Pro/Max session talks to Anthropic directly, so the gateway never sees its
// calls. Claude Code's telemetry reports them to the sidecar, which uploads them to
// POST /api/v1/client-events. This holds each uploaded event to the shape 0084's
// constraints hold the row to, so a bad event is dropped and counted here, one at a
// time, instead of failing the whole batch at the database.
//
// Since Phase 2 the same upload also carries what an agent's tool rules decided at
// Claude Code's PreToolUse hook (`tool_decision`): the tool's name, the decision, the
// rule and the wait. Never the command, path or URL, and nothing of a model call.
//
// What a row is NOT: proof. Nobody but the client says the call happened, there is no
// receipt, and the cost is what the call would have cost on the API. The plan is a
// flat fee, so it is never money spent and never reaches a budget.

export const CLIENT_EVENTS_SOURCE = "claude_code_otel";
export const CLIENT_EVENTS_TABLE = "client_reported_calls";
export const CLIENT_EVENTS_MAX_BATCH = 100;
export const CLIENT_EVENTS_MAX_BYTES = 64 * 1024;

// The patterns 0084 checks, which are the sidecar's and the gateway's own
// (cli/otlp-logs.mjs, lib/client-lineage.ts).
const EVENT_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const DECLARED = /^[A-Za-z0-9._:-]{1,128}$/;
const MODEL = /^[A-Za-z0-9._:/@-]{1,100}$/;
const MAX_TOKENS = 1_000_000_000;
const MAX_COST_MICROS = 10_000_000_000;
const MAX_DURATION_MS = 86_400_000;
// A report's own clock is kept only when it is plausible: a little ahead of ours, or
// within the week the sidecar could have held it.
const AHEAD_MS = 5 * 60 * 1000;
const BEHIND_MS = 7 * 24 * 60 * 60 * 1000;

const KINDS = new Set(["model_call", "model_error", "tool_decision"]);
// cli/tool-gate.mjs's decisions, which 0084 checks.
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const DECISIONS = new Set(["deny", "ask", "owner_approved", "owner_denied", "owner_timeout", "owner_unavailable", "rules_invalid"]);
const MAX_RULE_INDEX = 99;

export type ClientReportedRow = {
  user_id: string;
  agent_id: string;
  event_key: string;
  source: typeof CLIENT_EVENTS_SOURCE;
  kind: "model_call" | "model_error" | "tool_decision";
  auth_method: "passport" | "direct_key";
  client_session: string | null;
  client_agent: string | null;
  model: string | null;
  occurred_at: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  reported_cost_usd_micros: number | null;
  duration_ms: number | null;
  status_code: number | null;
  tool_name: string | null;
  decision: string | null;
  rule_index: number | null;
};

type Bad = typeof BAD;
const BAD = Symbol("bad");

/** Absent is null; present and not a bounded whole number is BAD. */
function count(value: unknown, max: number): number | null | Bad {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max ? value : BAD;
}

function pattern(value: unknown, re: RegExp): string | null | Bad {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && re.test(value) ? value : BAD;
}

function occurredAt(value: unknown, nowMs: number): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value > nowMs + AHEAD_MS || value < nowMs - BEHIND_MS) return null;
  return new Date(value).toISOString();
}

/**
 * One uploaded event as a row for `principal`'s agent, or null when it does not fit.
 * Only the listed fields are read: anything else in the event (an agent id, a tenant,
 * a credential class) is ignored, because those come from the credential.
 */
export function clientReportedRow(
  event: unknown,
  principal: { userId: string; agentId: string; auth: "passport" | "direct_key" },
  nowMs: number
): ClientReportedRow | null {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const e = event as Record<string, unknown>;
  if (typeof e.key !== "string" || !EVENT_KEY.test(e.key)) return null;
  if (typeof e.kind !== "string" || !KINDS.has(e.kind)) return null;
  const kind = e.kind as ClientReportedRow["kind"];
  if (kind === "tool_decision") return toolDecisionRow(e, principal, nowMs);

  const session = pattern(e.session, DECLARED);
  const agent = pattern(e.agent, DECLARED);
  const model = pattern(e.model, MODEL);
  const input = count(e.input_tokens, MAX_TOKENS);
  const output = count(e.output_tokens, MAX_TOKENS);
  const cacheRead = count(e.cache_read_tokens, MAX_TOKENS);
  const cacheCreation = count(e.cache_creation_tokens, MAX_TOKENS);
  const duration = count(e.duration_ms, MAX_DURATION_MS);
  // A cost belongs to a call and a status to an error: the other is not read at all.
  const cost = kind === "model_call" ? count(e.cost_usd_micros, MAX_COST_MICROS) : null;
  let status: number | null | Bad = null;
  if (kind === "model_error" && e.status !== undefined && e.status !== null) {
    status = typeof e.status === "number" && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599 ? e.status : BAD;
  }

  const fields = [session, agent, model, input, output, cacheRead, cacheCreation, duration, cost, status];
  if (fields.some((f) => f === BAD)) return null;

  return {
    user_id: principal.userId,
    agent_id: principal.agentId,
    event_key: e.key,
    source: CLIENT_EVENTS_SOURCE,
    kind,
    auth_method: principal.auth,
    client_session: session as string | null,
    client_agent: agent as string | null,
    model: model as string | null,
    occurred_at: occurredAt(e.at, nowMs),
    input_tokens: input as number | null,
    output_tokens: output as number | null,
    cache_read_tokens: cacheRead as number | null,
    cache_creation_tokens: cacheCreation as number | null,
    reported_cost_usd_micros: cost as number | null,
    duration_ms: duration as number | null,
    status_code: status as number | null,
    tool_name: null,
    decision: null,
    rule_index: null,
  };
}

/** A tool decision: only its own fields are read, so nothing of a model call lands. */
function toolDecisionRow(
  e: Record<string, unknown>,
  principal: { userId: string; agentId: string; auth: "passport" | "direct_key" },
  nowMs: number
): ClientReportedRow | null {
  if (typeof e.tool !== "string" || !TOOL_NAME.test(e.tool)) return null;
  if (typeof e.decision !== "string" || !DECISIONS.has(e.decision)) return null;
  const session = pattern(e.session, DECLARED);
  const agent = pattern(e.agent, DECLARED);
  const ruleIndex = count(e.rule_index, MAX_RULE_INDEX);
  const wait = count(e.duration_ms, MAX_DURATION_MS);
  if ([session, agent, ruleIndex, wait].some((f) => f === BAD)) return null;
  return {
    user_id: principal.userId,
    agent_id: principal.agentId,
    event_key: e.key as string,
    source: CLIENT_EVENTS_SOURCE,
    kind: "tool_decision",
    auth_method: principal.auth,
    client_session: session as string | null,
    client_agent: agent as string | null,
    model: null,
    occurred_at: occurredAt(e.at, nowMs),
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
    reported_cost_usd_micros: null,
    duration_ms: wait as number | null,
    status_code: null,
    tool_name: e.tool,
    decision: e.decision,
    rule_index: ruleIndex as number | null,
  };
}

/** True for the error a database before 0084 gives: the table is not there. */
export function isMissingTable(error: { code?: unknown; message?: unknown } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return typeof error.message === "string" && error.message.includes(CLIENT_EVENTS_TABLE) && /does not exist|schema cache/.test(error.message);
}
