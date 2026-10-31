// Subscription mode, Phase 1b: the model calls Claude Code REPORTS to the sidecar
// (cli/otlp-logs.mjs) are uploaded to the gateway's POST /api/v1/client-events, so
// they reach the agent's dashboard page and not only this machine's `watch`.
//
// The OTLP answer never waits for this: `add` only queues, and a timer flushes in
// batches. Each event gets its key once, when it is queued, and every retry sends the
// same key, so the gateway (0084, unique per agent and key) stores it once however
// often it is sent. The queue is bounded and drops the oldest.
//
// What each answer means:
//   200         sent; the gateway counted what it took
//   403         the agent is stopped: what it reports is not recorded, so drop
//   400, 413    the batch will never be accepted as it is, so drop it
//   503         `client_events_unavailable`: the gateway's database predates 0084
//   404, 405    the gateway predates the endpoint (npm, the Cloud deploy and
//               `passcontrol update` ship at different times)
//               → for both: drop everything and stop for a while
//   429         wait as long as the gateway asks
//   anything else, or no answer: keep the events, back off, retry, and give a batch
//               up after `maxAttempts`, so one that always fails cannot pin the queue
//
// Phase 2 queues the tool rules' decisions here too (cli/tool-gate.mjs): the tool's
// name and the decision, never the command, path or URL it was about.
//
// Only the fields the gateway stores are sent. The reported cost is what the call
// would have cost on the API, never money spent: the gateway keeps it apart from
// every budget.

import { randomBytes } from "node:crypto";

export const CLIENT_EVENTS_PATH = "/api/v1/client-events";
export const CLIENT_EVENTS_SOURCE = "claude_code_otel";

const UNAVAILABLE_PAUSE_MS = 10 * 60_000;
const BACKOFF_FIRST_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;

const newKey = () => `evt_${randomBytes(16).toString("base64url")}`;

/** One event from readClaudeCodeEvents, as the gateway takes it. Absent fields are left out. */
function toWire(event, key) {
  if (event.kind === "tool_decision") return toolDecisionWire(event, key);
  if (event.kind === "injection_finding") return injectionFindingWire(event, key);
  const wire = {
    key,
    kind: event.kind === "api_error" ? "model_error" : "model_call",
    session: event.session,
    agent: event.agent,
    at: event.at,
    model: event.model,
    cost_usd_micros: event.kind === "api_error" ? null : event.costMicros,
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    cache_read_tokens: event.cacheReadTokens,
    cache_creation_tokens: event.cacheCreationTokens,
    duration_ms: event.durationMs,
    status: event.kind === "api_error" ? event.status : null,
  };
  for (const name of Object.keys(wire)) if (wire[name] === null || wire[name] === undefined) delete wire[name];
  return wire;
}

function toolDecisionWire(event, key) {
  const wire = {
    key,
    kind: "tool_decision",
    session: event.session,
    agent: event.agent,
    at: event.at,
    tool: event.tool,
    decision: event.decision,
    rule_index: event.ruleIndex,
    duration_ms: event.waitMs,
  };
  for (const name of Object.keys(wire)) if (wire[name] === null || wire[name] === undefined) delete wire[name];
  return wire;
}

// What the sidecar's scan of a tool's output found (cli/injection-sidecar.mjs): the
// gateway's fixed fields only (plans/injection-guard.md §2b), so nothing a caller adds,
// least of all text, is ever sent.
function injectionFindingWire(event, key) {
  const wire = {
    key,
    kind: "injection_finding",
    at: event.at,
    source: event.source,
    path: event.path,
    tool: event.tool,
    families: event.families,
    severity: event.severity,
    detector: event.detector,
    normalization_version: event.normalization_version,
    block_sha256: event.block_sha256,
  };
  for (const name of Object.keys(wire)) if (wire[name] === null || wire[name] === undefined) delete wire[name];
  return wire;
}

/**
 * @param {{
 *   send: (events: object[]) => Promise<{ status: number, error?: string, retryAfterS?: number }>,
 *   now?: () => number,
 *   setTimer?: (fn: () => unknown, ms: number) => unknown,
 *   clearTimer?: (timer: unknown) => void,
 *   maxQueue?: number,
 *   batchSize?: number,
 *   flushMs?: number,
 *   maxAttempts?: number,
 * }} options
 */
export function createCallUploader({
  send,
  now = () => Date.now(),
  setTimer = (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return timer;
  },
  clearTimer = (timer) => clearTimeout(timer),
  maxQueue = 1_000,
  batchSize = 50,
  // Every 10 s: the gateway allows 30 uploads a minute per agent, and two sidecars on
  // one agent should still fit.
  flushMs = 10_000,
  maxAttempts = 8,
}) {
  let queue = [];
  let sent = 0;
  let dropped = 0;
  let timer = null;
  let inflight = null;
  let waitUntil = 0;
  let unavailableUntil = 0;
  let backoffMs = 0;
  let closed = false;
  // Failed sends per queued event (transient failures only).
  const attempts = new WeakMap();

  function schedule(delayMs) {
    if (closed || queue.length === 0) return;
    if (timer) clearTimer(timer);
    const ms = Math.max(delayMs, waitUntil - now(), 0);
    timer = setTimer(() => {
      timer = null;
      return flush();
    }, ms);
  }

  function add(event) {
    if (closed) return;
    if (unavailableUntil > now()) {
      dropped += 1;
      return;
    }
    queue.push(toWire(event, newKey()));
    if (queue.length > maxQueue) {
      queue.shift();
      dropped += 1;
    }
    if (inflight) return;
    if (queue.length >= batchSize) schedule(0);
    else if (!timer) schedule(flushMs);
  }

  async function flushOnce() {
    const batch = queue.slice(0, batchSize);
    if (batch.length === 0) return;
    let answer;
    try {
      answer = await send(batch);
    } catch {
      answer = { status: 0 };
    }
    const taken = new Set(batch);
    const status = answer?.status ?? 0;
    if (status === 200) {
      queue = queue.filter((e) => !taken.has(e));
      sent += batch.length;
      backoffMs = 0;
      return;
    }
    if ((status === 503 && answer.error === "client_events_unavailable") || status === 404 || status === 405) {
      dropped += queue.length;
      queue = [];
      unavailableUntil = now() + UNAVAILABLE_PAUSE_MS;
      return;
    }
    if (status === 403 || status === 400 || status === 413) {
      queue = queue.filter((e) => !taken.has(e));
      dropped += batch.length;
      return;
    }
    if (status === 429) {
      const seconds = Number(answer.retryAfterS);
      waitUntil = now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : BACKOFF_MAX_MS);
      return;
    }
    for (const e of batch) attempts.set(e, (attempts.get(e) ?? 0) + 1);
    const spent = batch.filter((e) => attempts.get(e) >= maxAttempts);
    if (spent.length > 0) {
      const gone = new Set(spent);
      queue = queue.filter((e) => !gone.has(e));
      dropped += spent.length;
    }
    backoffMs = backoffMs ? Math.min(backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_FIRST_MS;
    waitUntil = now() + backoffMs;
  }

  /** Sends one batch now (one at a time), then schedules whatever is left. */
  function flush() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        await flushOnce();
      } finally {
        inflight = null;
        if (queue.length >= batchSize && waitUntil <= now()) schedule(0);
        else schedule(flushMs);
      }
    })();
    return inflight;
  }

  function close() {
    closed = true;
    if (timer) clearTimer(timer);
    timer = null;
  }

  const stats = () => ({ queued: queue.length, sent, dropped });

  return { add, flush, close, stats };
}
