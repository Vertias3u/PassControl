// The runaway-agent package (1.9.0): guards against an agent that keeps going when it
// should have stopped. Pure: no I/O; the counters live in lib/state/runaway.ts.
//
// ── Part 1, the loop breaker ────────────────────────────────────────────────
//
// An agent stuck in a loop sends the same request again and again. Each call is
// small, so no budget line trips until the money is gone. With `loop_breaker:
// { repeats }` in its policy, the gateway fingerprints each model call and pauses the
// agent's model calls for LOOP_PAUSE_S once one fingerprint repeats `repeats` times
// inside LOOP_WINDOW_S.
//
// "The same request" is the provider, method, path, model and the LAST turn of the
// conversation, with id fields removed. Not the whole body: a stuck agent's history
// grows by one exchange per lap, so whole bodies never repeat, while the turn it is
// stuck on (the same tool output, the same error) does. Ids are removed because a
// client stamps a fresh tool-call id on every lap.
//
// What it does NOT do: judge whether repeated work is useful. An eval that samples one
// prompt many times trips it too, which is why it is off unless the owner sets it.
// It is an accident guard, not a limit: it fails open when Redis cannot answer, and
// the agent's own budget stays the hard line.

/** Repeats are counted inside this window, from the first one. */
export const LOOP_WINDOW_S = 600;
/** How long a tripped agent's model calls stay paused. Lifts by itself. */
export const LOOP_PAUSE_S = 900;
/** Deeper than any real request; past it there is no fingerprint rather than recursion. */
const MAX_DEPTH = 64;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The ids a client stamps fresh on every lap, so never compared: a message's or tool
 * call's own id. Only these: an id that NAMES content (`file_id`, `image_id`, a cache or
 * document reference) is content, and two different images under the same instruction
 * are two different requests (review 2026-11-21).
 */
const LAP_ID_KEYS = new Set(["id", "tool_use_id", "tool_call_id", "call_id", "toolCallId", "toolUseId", "callId"]);
function isIdKey(key: string): boolean {
  return LAP_ID_KEYS.has(key);
}

/** Ids removed and keys sorted, so equal content serialises equally. null when too deep. */
function canonical(value: unknown, depth: number): Json | undefined {
  if (depth > MAX_DEPTH) return undefined;
  if (Array.isArray(value)) {
    const out: Json[] = [];
    for (const item of value) {
      const c = canonical(item, depth + 1);
      if (c === undefined) return undefined;
      out.push(c);
    }
    return out;
  }
  if (isRecord(value)) {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      if (isIdKey(key)) continue;
      const c = canonical(value[key], depth + 1);
      if (c === undefined) return undefined;
      out[key] = c;
    }
    return out;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  return null;
}

/**
 * The turn a stuck agent repeats: the last message, input item or content, else the body.
 * A list is a conversation only when its items are objects (messages, Responses items,
 * Gemini contents). An embeddings `input` of strings or token ids is one batch of
 * documents, and all of it is the request (review 2026-11-21).
 */
function lastTurn(body: Record<string, unknown>): unknown {
  for (const field of ["messages", "input", "contents"]) {
    const list = body[field];
    if (Array.isArray(list) && list.length > 0) return list.every(isRecord) ? list[list.length - 1] : list;
    if (typeof list === "string") return list;
  }
  if (typeof body.prompt === "string") return body.prompt;
  return body;
}

/**
 * The fingerprint of one model call, a 64-character hex SHA-256, or null when the body
 * is not a JSON object (or is nested past any real request). null is never counted.
 * Only the digest leaves this function: no request text reaches a Redis key.
 */
export async function loopFingerprint(input: { provider: string; method: string; path: string; body: unknown }): Promise<string | null> {
  if (!isRecord(input.body)) return null;
  const turn = canonical(lastTurn(input.body), 0);
  if (turn === undefined) return null;
  const model = typeof input.body.model === "string" ? input.body.model : null;
  const text = JSON.stringify([input.provider, input.method.toUpperCase(), input.path, model, turn]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The refusal a paused agent gets. Says what happened, for how long, and what was not stopped. */
export function loopPausedMessage(repeats: number, retryAfterS: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterS / 60));
  return (
    `PassControl refused this call: this agent sent the same request ${repeats} times within ${LOOP_WINDOW_S / 60} minutes, ` +
    `which looks like a loop, so PassControl paused its model calls for ${minutes} minutes. The pause lifts by itself. ` +
    "Its service calls and other agents are not affected. The owner sets the repeat count in the agent's policy (loop_breaker)."
  );
}

// ── Part 2, per-session caps ────────────────────────────────────────────────
//
// Budgets are per agent, per day or month. `session_caps: { cents?, calls?, minutes? }`
// in an agent's policy caps ONE session: what it may spend, how many model calls it may
// make, how long it may run from its first call. A session is what the client declares
// (lib/client-lineage.ts): Claude Code's and Codex's session id, or the sidecar's run.
//
// What it does NOT do: bind a call that declares no session (there is nothing to count it
// against), or hold against a lying process. The ids are declared, so a new session is one
// header away; the number of NEW sessions an agent may open per hour is bounded for that
// reason, and the agent's own limits stay the hard ones. Like the loop breaker it guards
// against accidents, and fails open when Redis cannot answer.
//
// The money cap is enforced by the hold script itself: the session's ledger rides as one
// more ledger link (lib/state/holds.ts), checked and moved all-or-nothing with the agent's
// own hold, so concurrent calls cannot pass it together.

/** A session's counters idle out after this long without a call; it then starts afresh. */
export const SESSION_STATE_TTL_S = 24 * 3600;
/** New sessions one agent may open per hour while it has session caps. */
export const SESSION_NEW_PER_HOUR = 200;

/**
 * The ledger id for a declared session's money cap: `ses_` and 40 hex characters of its
 * SHA-256. A declared id may carry `.` and `:`, which a ledger id may not, and a digest
 * gives every session the same fixed shape.
 */
export async function sessionLedgerJti(session: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`session:${session}`));
  return "ses_" + [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}

/** The 503 for a session whose money record was lost or is busy (lib/state/runaway.ts). */
export const SESSION_STATE_MESSAGE =
  "PassControl cannot read this session's spending record right now, so it cannot tell how much the session has spent and will not guess. Start a new session (a new session id) to go on; the agent's other sessions are not affected.";

export type SessionCapReason = "cents" | "calls" | "minutes" | "sessions";

/** The refusal a session past one of its caps gets. The id was held to DECLARED, so it is safe to echo. */
export function sessionCapMessage(
  reason: SessionCapReason,
  session: string,
  caps: { cents: number | null; calls: number | null; minutes: number | null }
): string {
  const others = "The agent's other sessions are not affected; a new session starts with fresh caps.";
  switch (reason) {
    case "cents":
      return (
        `PassControl refused this call: this session (${session}) has a $${((caps.cents ?? 0) / 100).toFixed(2)} spending cap, ` +
        `and the most this call could cost, added to what the session has already spent, would pass it. ${others}`
      );
    case "calls":
      return `PassControl refused this call: this session (${session}) has made ${caps.calls} calls, the most the agent's policy allows one session. ${others}`;
    case "minutes":
      return `PassControl refused this call: this session (${session}) started more than ${caps.minutes} minutes ago, the longest the agent's policy allows one session to run. ${others}`;
    case "sessions":
      return (
        `PassControl refused this call: this agent started more than ${SESSION_NEW_PER_HOUR} new sessions this hour, more than its session caps can track. ` +
        "Wait for the hour to turn, or go on in a session already running. Sessions already running are not affected."
      );
  }
}
