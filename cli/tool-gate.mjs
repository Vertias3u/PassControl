// Subscription mode's tool rules at Claude Code's PreToolUse hook
// (Phase 2 design).
//
// The stop gate (cli/subscription-gate.mjs) answers first: a stopped agent or session
// ends the turn whatever the rules say. When it lets the tool through, this decides
// from the agent's tool rules (cli/tool-rules.mjs), which arrive with the stop gate's
// own /self reads:
//
//   deny       → permissionDecision "deny": the tool does not run, Claude is told why
//                and the turn goes on.
//   ask        → permissionDecision "ask": Claude Code's own terminal prompt.
//   ask_owner  → held while the gateway asks the owner. A yes answers nothing, so
//                Claude Code's normal permission flow still decides; a no, no answer
//                in time, or no way to ask, denies. The human the owner put in the
//                way is never removed by a fault.
//
// Claude Code lets a tool RUN when its http hook times out, so a hold must end before
// the hook does: the hook's URL says how long it waits (`?t=600`, written by
// configure), the wait ends 30 s before that, and a hook that does not say (a Phase 1
// install, 5 s) refuses an `ask_owner` tool at once instead of timing out into a yes.
//
// Rules never read (the sidecar just started, the gateway is down) fail open with a
// warning, as stops do. Rules this build cannot read deny every tool: the owner wrote
// them, and a guess at what they meant would be worse.
//
// Each outcome that is not a plain pass is handed to `onDecision` for the agent's
// page: tool name, decision, rule number and wait. Never the command, path or URL.
import { evaluateToolRules, parseToolRules } from "./tool-rules.mjs";

/** The wait ends this long before Claude Code would give up on the hook. */
export const HOOK_MARGIN_S = 30;
const MIN_WAIT_S = 10;
const WARN_EVERY_MS = 60_000;
const SUBJECT_MAX = 120;
const DECLARED = /^[A-Za-z0-9._:-]{1,128}$/;

const declared = (v) => (typeof v === "string" && DECLARED.test(v) ? v : null);
const short = (text) => (text.length > SUBJECT_MAX ? `${text.slice(0, SUBJECT_MAX - 1)}…` : text);

function verdict(permissionDecision, reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason } };
}

/**
 * @param {{
 *   askOwner: (input: object, ask: { ruleIndex: number, subject: string, session: string | null, waitMs: number }) =>
 *     Promise<{ state: "approved" | "denied" | "timeout" | "unavailable" | "full" | "refused" | "too_large" }>,
 *   onDecision?: (record: { session: string | null, agent: string | null, tool: string, decision: string, ruleIndex: number | null, waitMs: number }) => void,
 *   now?: () => number,
 *   dashboardUrl?: string,
 * }} options
 */
export function createToolGate({ askOwner, onDecision = () => {}, now = () => Date.now(), dashboardUrl = "" }) {
  let warnedAt = null;
  const where = dashboardUrl ? ` on ${dashboardUrl}` : " on the agent's dashboard page";

  function record(input, decision, ruleIndex, waitMs) {
    try {
      onDecision({
        session: declared(input.session_id),
        agent: declared(input.agent_id),
        tool: String(input.tool_name ?? "").slice(0, 128),
        decision,
        ruleIndex,
        waitMs,
      });
    } catch {
      // A record is a record; it never changes the answer.
    }
  }

  /**
   * @param {object} input       Claude Code's PreToolUse hook input.
   * @param {{ read: { state: string, document?: unknown }, at: number } | null} rulesEntry
   *                             The rules from the latest trusted /self read, or null.
   * @param {number | null} hookTimeoutS  What the hook's URL says it waits; null when it does not say.
   */
  async function decide(input, rulesEntry, hookTimeoutS) {
    if (input?.hook_event_name !== "PreToolUse") return {};
    const read = rulesEntry?.read;
    if (read?.state === "none") return {};
    if (read?.state === "invalid") {
      record(input, "rules_invalid", null, 0);
      return verdict("deny", `PassControl: this agent's tool rules cannot be read here, so no tool runs until they are fixed${where}.`);
    }
    const parsed = read?.state === "ok" ? parseToolRules(read.document) : null;
    if (!parsed) {
      if (warnedAt !== null && now() - warnedAt < WARN_EVERY_MS) return {};
      warnedAt = now();
      return { systemMessage: "PassControl could not read this agent's tool rules yet, so this goes ahead. Is `passcontrol sidecar` running?" };
    }
    if (!parsed.ok) {
      record(input, "rules_invalid", null, 0);
      return verdict("deny", `PassControl: this agent's tool rules cannot be read here, so no tool runs until they are fixed${where}.`);
    }

    const hit = evaluateToolRules(parsed, input);
    if (hit.effect === null) return {};
    const rule = `rule ${hit.ruleIndex + 1}`;
    if (hit.effect === "deny") {
      record(input, "deny", hit.ruleIndex, 0);
      return verdict("deny", `PassControl: the agent's tool rules refuse this (${rule}: ${short(hit.subject)}).`);
    }
    if (hit.effect === "ask") {
      record(input, "ask", hit.ruleIndex, 0);
      return verdict("ask", `PassControl: the agent's tool rules ask you to confirm this (${rule}: ${short(hit.subject)}).`);
    }

    // ask_owner
    const waitS = hookTimeoutS === null ? 0 : Math.min(parsed.approvalWaitS, hookTimeoutS - HOOK_MARGIN_S);
    if (waitS < MIN_WAIT_S) {
      record(input, "owner_unavailable", hit.ruleIndex, 0);
      return verdict(
        "deny",
        `PassControl: this needs the agent's owner to say yes (${rule}), and Claude Code's hook would give up before the answer. Run \`passcontrol configure claude-code --subscription --write\`, then try again.`
      );
    }
    const started = now();
    let answer;
    try {
      answer = await askOwner(input, { ruleIndex: hit.ruleIndex, subject: hit.subject, session: declared(input.session_id), waitMs: waitS * 1000 });
    } catch {
      answer = { state: "unavailable" };
    }
    const waited = Math.max(0, now() - started);
    switch (answer?.state) {
      case "approved":
        record(input, "owner_approved", hit.ruleIndex, waited);
        return {};
      case "denied":
        record(input, "owner_denied", hit.ruleIndex, waited);
        return verdict("deny", `PassControl: the agent's owner said no to this (${rule}).`);
      case "timeout":
        record(input, "owner_timeout", hit.ruleIndex, waited);
        return verdict("deny", `PassControl: the agent's owner did not answer within ${waitS} s, so this was not run (${rule}).`);
      case "full":
        record(input, "owner_unavailable", hit.ruleIndex, waited);
        return verdict("deny", `PassControl: too many questions are already waiting for the agent's owner, so this was not run (${rule}).`);
      case "too_large":
        record(input, "owner_unavailable", hit.ruleIndex, waited);
        return verdict("deny", `PassControl: this needs the agent's owner to say yes (${rule}), and it is too large to show them in full, so it was not run.`);
      case "refused":
        record(input, "owner_unavailable", hit.ruleIndex, waited);
        return verdict("deny", `PassControl: the gateway did not agree this needs the owner (the rules may have just changed), so it was not run. Try again.`);
      default:
        record(input, "owner_unavailable", hit.ruleIndex, waited);
        return verdict("deny", `PassControl: this needs the agent's owner to say yes (${rule}), and they could not be reached, so it was not run.`);
    }
  }

  return { decide };
}
