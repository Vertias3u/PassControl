// Subscription mode's Stop (Phase 1).
//
// A Claude Pro/Max session signs in to Claude Code with the user's own account and
// talks to Anthropic directly: Anthropic's terms forbid anything that intermediates
// that login, so PassControl is not in the network path and the gateway cannot
// refuse the calls. The stops still reach the session, through Claude Code's hooks.
// `passcontrol configure claude-code --subscription` points three of them at the
// sidecar's loopback listener:
//
//   UserPromptSubmit  before a prompt is sent    → { decision: "block" }
//   PreToolUse        before a tool runs         → permissionDecision "deny"
//   PostToolBatch     before the next model call → { decision: "block" }
//
// and each of those also returns `continue: false`, which ends the turn: a stop means
// the agent stops, not that it keeps thinking with its tools taken away.
//
// The state comes from the gateway's GET /api/v1/self, which evaluates the kill
// switch, suspend and the declared session's stop exactly as for a model call. A hook
// fires on every tool call, and /self allows 60 a minute per AGENT, shared by every
// session and by the status line, `watch` and `/passcontrol`. So the agent-wide answer
// (kill switch, suspend) is asked once for all sessions, every `freshMs`; a session's
// own stop is asked per session, every `sessionFreshMs`; and concurrent hooks share one
// request. That is at most 12 + 4 per session a minute at the defaults.
//
// When the state cannot be read, the action goes ahead (fail-open, the owner's choice
// on 2026-10-11 and the kill switch's own default), with a warning shown at most once
// a minute per session. A stop seen within `maxStaleMs` is held through a gateway blip:
// failing open is for "never knew", not for "knew it was stopped a moment ago".
//
// Each /self answer also carries the agent's tool rules (Phase 2, `?include=tool_rules`),
// kept here for the tool gate (cli/tool-gate.mjs), so the rules never cost a call of
// their own. Every read asks for them, so an "open" answer without them comes from a
// gateway that has none to give (one from before Phase 2): no rules, not unknown ones.
// A refusal carries no rules, so a PreToolUse refreshes them with the agent-wide ask
// once they are `freshMs` old.
//
// The agent's own note (1.6.0, cli/agent-note.mjs) rides on the prompt hook when its
// URL opts in: `?note=1` in this mode, `?note=only` when Claude Code goes through the
// sidecar with an API key, where the gateway already enforces and the hook only ever
// adds the note. It is built from the latest answer and sent per session only when
// its signature changes; a stop always wins over it.
//
// Honest limit: hooks run inside Claude Code, so this is a guard rail for the user's
// own sessions, not a boundary against a client that skips them.

import { agentNote } from "./agent-note.mjs";

export const HOOK_PATH = "/_passcontrol/hook";

const GATED = new Set(["UserPromptSubmit", "PreToolUse", "PostToolBatch"]);
// What the gateway accepts as a declared session (lib/client-lineage.ts).
const DECLARED_SESSION = /^[A-Za-z0-9._:-]{1,128}$/;

// Claude Code's timeout on the prompt and next-model-call hooks (cli/claude-code.mjs).
// Past it the action goes ahead with no warning at all, so the sidecar's read of
// /api/v1/self ends a second earlier and says why. 2 s was too short: a Cloud answer
// on a cold start took longer, and a stop was missed with "did not answer in time".
export const GATE_HOOK_TIMEOUT_S = 5;
export const SELF_READ_TIMEOUT_MS = (GATE_HOOK_TIMEOUT_S - 1) * 1000;

export const GATE_FRESH_MS = 5_000;
export const GATE_SESSION_FRESH_MS = 15_000;
export const GATE_MAX_STALE_MS = 60_000;
const MAX_SESSIONS = 512;
const WARN_EVERY_MS = 60_000;

function stopText(state, dashboardUrl) {
  const where = dashboardUrl ? ` Lift it from ${dashboardUrl}` : "";
  if (state === "session_stopped") {
    return `PassControl: the agent's owner stopped this session, so nothing more runs in it.${where ? `${where} (the agent's Sessions view).` : ""}`;
  }
  return `PassControl: this agent is stopped — its owner suspended it, or the kill switch is on.${where ? `${where}.` : ""}`;
}

function blockFor(event, reason) {
  const end = { continue: false, stopReason: reason };
  if (event === "PreToolUse") {
    return {
      ...end,
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    };
  }
  return { ...end, decision: "block", reason };
}

/**
 * @param {{
 *   readSelf: (session: string | null) => Promise<{ state: "open" | "stopped" | "session_stopped" | "unknown", reason?: string }>,
 *   dashboardUrl?: string,
 *   now?: () => number,
 *   freshMs?: number,
 *   sessionFreshMs?: number,
 *   maxStaleMs?: number,
 *   maxSessions?: number,
 * }} options
 */
export function createStopGate({
  readSelf,
  dashboardUrl = "",
  now = () => Date.now(),
  freshMs = GATE_FRESH_MS,
  sessionFreshMs = GATE_SESSION_FRESH_MS,
  maxStaleMs = GATE_MAX_STALE_MS,
  maxSessions = MAX_SESSIONS,
}) {
  // The last KNOWN answers (never "unknown"). The agent's: "open" | "stopped".
  // A session's: "open" | "session_stopped", or "behind" when it was last asked while
  // the whole agent was stopped, which hides whether the session is stopped on its own.
  let agent = null;
  // The agent's tool rules as the last answer that carried them gave them.
  let rules = null;
  // The limits from the latest open answer, for the note; and each session's last note.
  let latest = null;
  const noted = new Map();
  const sessions = new Map();
  const inflight = new Map();
  const warnedAt = new Map();

  function remember(map, key, value) {
    map.delete(key);
    map.set(key, value);
    while (map.size > maxSessions) map.delete(map.keys().next().value);
  }

  // One answer can settle both: a session's "open" says the agent is running too, a
  // "session_stopped" is only ever given to a running agent, and "stopped" is agent-wide.
  function record(session, state) {
    const at = now();
    if (state === "open" || state === "session_stopped") agent = { state: "open", at };
    if (state === "stopped") agent = { state: "stopped", at };
    if (session !== null) remember(sessions, session, { state: state === "stopped" ? "behind" : state, at });
  }

  async function ask(session) {
    const key = session ?? "";
    if (inflight.has(key)) return inflight.get(key);
    const pending = (async () => {
      let answer;
      try {
        answer = await readSelf(session);
      } catch (error) {
        answer = { state: "unknown", reason: error?.message ?? "error" };
      }
      answer ??= { state: "unknown", reason: "no answer" };
      if (answer.state === "open" && answer.self) latest = { self: answer.self, at: now() };
      if (answer.state === "open") {
        rules = { read: answer.toolRules && typeof answer.toolRules === "object" ? answer.toolRules : { state: "none" }, at: now() };
      }
      if (["open", "stopped"].includes(answer.state) || (session !== null && answer.state === "session_stopped")) {
        record(session, answer.state);
      }
      return answer;
    })();
    inflight.set(key, pending);
    try {
      return await pending;
    } finally {
      inflight.delete(key);
    }
  }

  function warnOnce(key, reason) {
    const last = warnedAt.get(key);
    if (last !== undefined && now() - last < WARN_EVERY_MS) return {};
    remember(warnedAt, key, now());
    return {
      systemMessage: `PassControl could not check this agent's stops (${String(reason ?? "no answer").slice(0, 80)}), so this goes ahead. Is \`passcontrol sidecar\` running?`,
    };
  }

  const age = (entry) => (entry ? now() - entry.at : Infinity);

  /** The note for this session's prompt, when it opted in and something changed since the last. */
  function noteFor(sessionKey, mode) {
    if (!latest || age(latest) > maxStaleMs) return null;
    const freshRules = rules && age(rules) <= maxStaleMs ? rules.read : null;
    const n = agentNote({ self: latest.self, rules: freshRules, mode, nowMs: now() });
    if (!n || noted.get(sessionKey) === n.signature) return null;
    remember(noted, sessionKey, n.signature);
    return { hookEventName: "UserPromptSubmit", additionalContext: n.text };
  }

  /**
   * @param {object} input Claude Code's hook input.
   * @param {{ note?: "api" | "subscription" | null }} [options] the prompt hook's opt-in.
   */
  async function decide(input, { note = null } = {}) {
    const event = input?.hook_event_name;
    if (note === "api") {
      // Only the note, never a stop or a warning: the gateway refuses these calls itself.
      if (event !== "UserPromptSubmit") return {};
      if (age(latest) >= freshMs) await ask(null);
      const session = typeof input.session_id === "string" && DECLARED_SESSION.test(input.session_id) ? input.session_id : "";
      const out = noteFor(session, "api");
      return out ? { hookSpecificOutput: out } : {};
    }
    const out = await gateDecision(input, event);
    if (note === "subscription" && event === "UserPromptSubmit" && out.continue !== false) {
      const session = typeof input.session_id === "string" && DECLARED_SESSION.test(input.session_id) ? input.session_id : "";
      const extra = noteFor(session, "subscription");
      if (extra) return { ...out, hookSpecificOutput: extra };
    }
    return out;
  }

  async function gateDecision(input, event) {
    if (!GATED.has(event)) return {};
    const session = typeof input.session_id === "string" && DECLARED_SESSION.test(input.session_id) ? input.session_id : null;

    // A session asked behind an agent-wide stop is due again as soon as the agent
    // is known to be running: its own stop may still stand.
    const sessionDue = () => {
      if (session === null) return false;
      const own = sessions.get(session);
      return age(own) >= sessionFreshMs || (own?.state === "behind" && agent?.state === "open");
    };
    let reason = null;
    let askedAgent = false;
    if (sessionDue()) reason = (await ask(session)).reason ?? null;
    else if (age(agent) >= freshMs) {
      askedAgent = true;
      reason = (await ask(null)).reason ?? null;
      if (sessionDue()) reason = (await ask(session)).reason ?? reason;
    }
    if (event === "PreToolUse" && !askedAgent && age(rules) >= freshMs) await ask(null);

    // Act on what is known and still trusted; fail open, visibly, on anything else.
    const trusted = (entry) => entry && age(entry) <= maxStaleMs;
    const a = trusted(agent) ? agent : null;
    const s = session === null ? null : sessions.get(session);
    const sTrusted = trusted(s) ? s : null;
    if (a?.state === "stopped") return blockFor(event, stopText("stopped", dashboardUrl));
    if (sTrusted?.state === "session_stopped") return blockFor(event, stopText("session_stopped", dashboardUrl));
    if (a?.state === "open" && (session === null || sTrusted?.state === "open")) return {};
    return warnOnce(session ?? "", reason ?? "no answer");
  }

  /** The tool rules from the latest answer, or null once they are older than `maxStaleMs`. */
  function toolRules() {
    return rules && age(rules) <= maxStaleMs ? rules : null;
  }

  return { decide, toolRules };
}

/**
 * Maps the gateway's answer to GET /api/v1/self onto a gate state. The gateway's
 * 403 is deliberately opaque between suspend and kill switch; a stopped session is
 * the one it names.
 */
export async function selfAnswerState(response) {
  if (response.ok) {
    const body = await response.json().catch(() => null);
    const toolRules = body && typeof body === "object" ? body.tool_rules : undefined;
    const answer = toolRules && typeof toolRules === "object" ? { state: "open", toolRules } : { state: "open" };
    // The limits and the soft pause, for the agent's note; nothing else from the answer is kept.
    if (body && typeof body === "object" && body.budget && typeof body.budget === "object") {
      const kept = (v) => (v && typeof v === "object" ? v : null);
      answer.self = { budget: body.budget, pace: kept(body.pace), pause: kept(body.pause) };
    }
    return answer;
  }
  if (response.status === 403) {
    const body = await response.json().catch(() => ({}));
    const message = typeof body?.message === "string" ? body.message : "";
    return { state: message.includes("stopped this session") ? "session_stopped" : "stopped" };
  }
  await response.body?.cancel().catch(() => {});
  return { state: "unknown", reason: `gateway answered HTTP ${response.status}` };
}
