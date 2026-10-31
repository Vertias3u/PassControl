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
import { underTaint } from "./injection-hold.mjs";
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
 *   onHold?: (record: { tool: string, outcome: string }) => void,
 *   refresh?: () => Promise<object | null>,
 *   now?: () => number,
 *   dashboardUrl?: string,
 * }} options
 */
export function createToolGate({ askOwner, onDecision = () => {}, now = () => Date.now(), dashboardUrl = "", onHold = () => {}, refresh = async () => null }) {
  let warnedAt = null;
  let injectionWarnedAt = null;
  let needsRefresh = false;
  let refreshing = null;
  const where = dashboardUrl ? ` on ${dashboardUrl}` : " on the agent's dashboard page";
  // Said with every rule's refusal: told only "the tool rules refuse this", Claude
  // Code went looking for the rule in the local PassControl config, which has none.
  const rulesLive = dashboardUrl
    ? `Tool rules are set on the agent's page at ${dashboardUrl}, not on this machine.`
    : "Tool rules are set on the agent's dashboard page, not on this machine.";

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
   * @param {"off" | "clear" | "tainted" | "unknown"} injection
   */
  async function decide(input, rulesEntry, hookTimeoutS, injection = "off") {
    if (input?.hook_event_name !== "PreToolUse") return {};
    if (needsRefresh || refreshing) {
      if (!refreshing) {
        needsRefresh = false;
        refreshing = Promise.resolve().then(refresh).finally(() => { refreshing = null; });
      }
      const fresh = await refreshing;
      if (fresh) ({ rulesEntry, injection } = fresh);
    }
    const read = rulesEntry?.read;
    if (read?.state === "invalid") {
      record(input, "rules_invalid", null, 0);
      return verdict("deny", `PassControl: this agent's tool rules cannot be read here, so no tool runs until they are fixed${where}.`);
    }
    const parsed = read?.state === "none" ? parseToolRules({ rules: [] }) : read?.state === "ok" ? parseToolRules(read.document) : null;
    if (!parsed) {
      if (warnedAt !== null && now() - warnedAt < WARN_EVERY_MS) return {};
      warnedAt = now();
      return { systemMessage: "PassControl could not read this agent's tool rules yet, so this goes ahead. Is `passcontrol sidecar` running?" };
    }
    if (!parsed.ok) {
      record(input, "rules_invalid", null, 0);
      return verdict("deny", `PassControl: this agent's tool rules cannot be read here, so no tool runs until they are fixed${where}.`);
    }

    const original = evaluateToolRules(parsed, input);
    const hit = injection === "tainted" ? underTaint(original, input.tool_name) : original;
    const escalated = hit.reason === "injection_taint";
    const guardText = "This tool was held by the injection guard because the agent recently read something that looked like a prompt injection.";
    let warning = {};
    if (injection === "unknown" && (injectionWarnedAt === null || now() - injectionWarnedAt >= WARN_EVERY_MS)) {
      injectionWarnedAt = now();
      warning = { systemMessage: "PassControl could not check this agent's injection guard, so this goes ahead." };
    }
    const withWarning = (out) => ({ ...out, ...warning });
    function holdRecord(outcome) {
      if (escalated) {
        try { onHold({ tool: String(input.tool_name ?? "").slice(0, 128), outcome }); } catch {}
      }
    }
    const ruleIndex = escalated ? null : hit.ruleIndex;
    if (hit.effect === null) return withWarning({});
    const rule = escalated ? "injection guard" : `rule ${hit.ruleIndex + 1}`;
    if (hit.effect === "deny") {
      record(input, "deny", hit.ruleIndex, 0);
      return withWarning(verdict("deny", `PassControl: the agent's tool rules refuse this (${rule}: ${short(hit.subject)}). ${rulesLive}`));
    }
    if (hit.effect === "ask") {
      record(input, "ask", hit.ruleIndex, 0);
      return withWarning(verdict("ask", `PassControl: the agent's tool rules ask you to confirm this (${rule}: ${short(hit.subject)}). ${rulesLive}`));
    }

    // ask_owner
    const waitS = hookTimeoutS === null ? 0 : Math.min(parsed.approvalWaitS, hookTimeoutS - HOOK_MARGIN_S);
    if (waitS < MIN_WAIT_S && escalated) {
      record(input, "owner_unavailable", null, 0);
      holdRecord("unavailable");
      return verdict("deny", `PassControl: ${guardText} The hook cannot wait for the owner. Run \`passcontrol configure claude-code --subscription --write\`, then try again.`);
    }
    if (waitS < MIN_WAIT_S) {
      record(input, "owner_unavailable", hit.ruleIndex, 0);
      return withWarning(verdict(
        "deny",
        `PassControl: this needs the agent's owner to say yes (${rule}), and Claude Code's hook would give up before the answer. Run \`passcontrol configure claude-code --subscription --write\`, then try again.`
      ));
    }
    const started = now();
    let answer;
    try {
      answer = await askOwner(input, { ruleIndex, subject: escalated ? "injection guard" : hit.subject, session: declared(input.session_id), waitMs: waitS * 1000 });
    } catch {
      answer = { state: "unavailable" };
    }
    const waited = Math.max(0, now() - started);
    if (escalated) {
      const state = answer?.state;
      if (state === "refused") {
        // Not an owner outcome: the tool goes ahead on its own rules, so the agent's page
        // gets the record those rules give (only an "ask"), never "owner unavailable".
        needsRefresh = true;
        holdRecord("through");
        if (original.effect === "ask") {
          record(input, "ask", original.ruleIndex, 0);
          return verdict("ask", `PassControl: ${guardText} The gateway now sees no taint. The tool rules still ask you to confirm this (rule ${original.ruleIndex + 1}: ${short(original.subject)}). ${rulesLive}`);
        }
        return { systemMessage: `PassControl: ${guardText} The gateway now sees no taint, so this goes ahead.` };
      }
      const outcome = ["approved", "denied", "timeout"].includes(state) ? state : "unavailable";
      holdRecord(outcome);
      record(input, `owner_${outcome}`, null, waited);
      if (outcome === "approved") return { systemMessage: `PassControl: ${guardText} The agent's owner approved it.` };
      const ending = outcome === "denied" ? "The agent's owner said no." : outcome === "timeout" ? `The agent's owner did not answer within ${waitS} s, so this was not run.` : "The owner could not be asked, so this was not run.";
      return verdict("deny", `PassControl: ${guardText} ${ending}`);
    }
    function ruleAnswer() {
      switch (answer?.state) {
      case "approved":
        record(input, "owner_approved", hit.ruleIndex, waited);
        return {};
      case "denied":
        record(input, "owner_denied", hit.ruleIndex, waited);
        return verdict("deny", `PassControl: the agent's owner said no to this (${rule}). ${rulesLive}`);
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
    return withWarning(ruleAnswer());
  }

  return { decide };
}
