// Subscription mode's eyes (Phase 1): Claude Code's own
// OpenTelemetry log export, received on the sidecar's loopback listener.
//
// A Pro/Max session talks to Anthropic directly, so no call passes the sidecar. Claude
// Code reports each one itself when `CLAUDE_CODE_ENABLE_TELEMETRY=1` and its log
// exporter points here (OTLP http/json): `claude_code.api_request` with the model,
// tokens, API-equivalent cost and duration, and `claude_code.api_error` with the
// status. Prompts and tool inputs are redacted by Claude Code by default.
//
// Every record also carries the user's email, account id and organisation id. This
// parser copies an ALLOWLIST of fields and nothing else, so those never reach the
// board, a log line or a later upload. Each copied value is held to a pattern.
//
// What a reported call is NOT: a call PassControl saw. It is what the client says it
// did. The board shows it as SEEN, never BOARDED, and its cost as API-equivalent:
// a subscription pays a flat fee, and nothing here is ever charged to a budget.

export const OTLP_LOGS_PATH = "/_passcontrol/otlp/v1/logs";

const SERVICE = "claude-code";
const KINDS = { "claude_code.api_request": "api_request", "claude_code.api_error": "api_error" };
// The same patterns the watch feed holds its fields to (cli/watch-feed.mjs).
const DECLARED = /^[A-Za-z0-9._:-]{1,128}$/;
const MODEL = /^[A-Za-z0-9._:/@-]{1,100}$/;

const held = (pattern, value) => (typeof value === "string" && pattern.test(value) ? value : null);

/** An OTLP AnyValue as a JS value: string, number, or null. int64 may arrive as a string. */
function scalar(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (value.intValue !== undefined) {
    const n = typeof value.intValue === "string" ? Number(value.intValue) : value.intValue;
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue)) return value.doubleValue;
  return null;
}

function attributeMap(attributes) {
  const map = new Map();
  if (!Array.isArray(attributes)) return map;
  for (const a of attributes) {
    if (a && typeof a.key === "string") map.set(a.key, scalar(a.value));
  }
  return map;
}

const count = (v) => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 2 ** 53 ? v : null);
const status = (v) => (typeof v === "number" && Number.isInteger(v) && v >= 100 && v < 600 ? v : null);

function timeMs(record) {
  const raw = record?.timeUnixNano ?? record?.observedTimeUnixNano;
  const n = typeof raw === "string" ? Number(raw.slice(0, -6) || "0") : typeof raw === "number" ? Math.floor(raw / 1e6) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The model calls in one OTLP ExportLogsServiceRequest (JSON). Never throws.
 * @returns {Array<{ kind: "api_request" | "api_error", session: string | null, at: number | null, model: string | null,
 *   costMicros: number | null, inputTokens: number | null, outputTokens: number | null, cacheReadTokens: number | null,
 *   cacheCreationTokens: number | null, durationMs: number | null, status: number | null, agent: string | null }>}
 */
export function readClaudeCodeEvents(body) {
  const events = [];
  try {
    if (!body || typeof body !== "object" || !Array.isArray(body.resourceLogs)) return events;
    for (const resourceLog of body.resourceLogs) {
      if (attributeMap(resourceLog?.resource?.attributes).get("service.name") !== SERVICE) continue;
      for (const scopeLog of Array.isArray(resourceLog.scopeLogs) ? resourceLog.scopeLogs : []) {
        for (const record of Array.isArray(scopeLog?.logRecords) ? scopeLog.logRecords : []) {
          const kind = KINDS[scalar(record?.body)];
          if (!kind) continue;
          const a = attributeMap(record.attributes);
          events.push({
            kind,
            session: held(DECLARED, a.get("session.id")),
            at: timeMs(record),
            model: held(MODEL, a.get("model")),
            costMicros: kind === "api_request" ? count(a.get("cost_usd_micros")) : null,
            inputTokens: count(a.get("input_tokens")),
            outputTokens: count(a.get("output_tokens")),
            cacheReadTokens: count(a.get("cache_read_tokens")),
            cacheCreationTokens: count(a.get("cache_creation_tokens")),
            durationMs: count(a.get("duration_ms")),
            status: kind === "api_error" ? status(a.get("status_code")) : null,
            agent: held(DECLARED, a.get("agent.name")),
          });
        }
      }
    }
  } catch {
    // A malformed export shows nothing rather than breaking the sidecar.
  }
  return events;
}
