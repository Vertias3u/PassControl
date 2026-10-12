// Tool rules for subscription mode (Phase 2).
//
// An agent's `tool_rules` (agents.tool_rules, migration 0085) add friction to what
// Claude Code's tools may do, from the PreToolUse hook:
//
//   { "rules": [ { "tool": "Bash", "command": "git push*", "effect": "ask_owner" },
//                { "tool": "Write", "path": "/etc/*", "effect": "deny" },
//                { "tool": "WebFetch", "domain": "*.example.com", "effect": "ask" },
//                { "tool": "mcp__github__*", "effect": "ask_owner" } ],
//     "approval_wait_s": 120 }
//
// `deny` refuses the tool, `ask` hands it to Claude Code's own terminal prompt, and
// `ask_owner` waits for the owner's yes through the gateway's approval flow. There is
// no `allow`: rules only add friction, and allowing stays Claude Code's own permission
// system. Every matching rule counts and the strictest wins, so order never matters.
//
// One file for both sides: the sidecar decides with it, and the gateway imports it to
// re-check that a tool it is asked to put to the owner really is under an `ask_owner`
// rule. The two can never disagree.
//
// Patterns are globs where `*` is any run of characters and everything else is
// literal. No regex is built from what a tenant writes, and matching is a handful of
// native substring searches, never backtracking.
//
// Honest limit: these are guard rails for the owner's own sessions. `sh -c`, an alias,
// a script file or a different tool gets round a command rule.

export const TOOL_RULE_EFFECTS = ["deny", "ask_owner", "ask"];
const STRICTNESS = { deny: 3, ask_owner: 2, ask: 1 };

export const DEFAULT_APPROVAL_WAIT_S = 120;
export const TOOL_RULE_LIMITS = {
  rules: 100,
  patternLen: 300,
  toolLen: 128,
  /** Claude Code's http hook default is 600 s; the sidecar must answer before it. */
  minWaitS: 10,
  maxWaitS: 540,
};

/** The tools whose input names a file or directory, and where. */
const PATH_FIELDS = {
  Read: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  Write: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Glob: ["path"],
  Grep: ["path"],
};
const SEARCH_TOOLS = new Set(["Glob", "Grep"]);

const RULE_KEYS = new Set(["tool", "command", "path", "domain", "effect"]);
const DOC_KEYS = new Set(["rules", "approval_wait_s"]);
const TOOL_NAME = /^[A-Za-z0-9_.-]+\*?$/;
const DOMAIN = /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/;

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isPattern = (v) => typeof v === "string" && v.length > 0 && v.length <= TOOL_RULE_LIMITS.patternLen;

/** `*` matches any run of characters (including none); everything else matches itself. */
export function globMatch(pattern, text) {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === text;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!text.startsWith(first)) return false;
  if (text.length - first.length < last.length || !text.endsWith(last)) return false;
  // Leftmost-first is exact for a star-only glob: an earlier match never leaves
  // less room for what follows than a later one would.
  let at = first.length;
  const end = text.length - last.length;
  for (let i = 1; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (part === "") continue;
    const found = text.indexOf(part, at);
    if (found === -1 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

function parseRule(value) {
  if (!isRecord(value) || Object.keys(value).some((k) => !RULE_KEYS.has(k))) return null;
  const { tool, effect } = value;
  if (typeof tool !== "string" || tool.length > TOOL_RULE_LIMITS.toolLen || !TOOL_NAME.test(tool)) return null;
  if (!TOOL_RULE_EFFECTS.includes(effect)) return null;
  const conditions = ["command", "path", "domain"].filter((k) => k in value);
  if (conditions.length > 1) return null;
  const rule = { tool, effect };
  if (conditions.length === 0) return rule;
  // A condition belongs to one named tool: a wildcard tool has no single input shape.
  if (tool.endsWith("*")) return null;
  const kind = conditions[0];
  const pattern = value[kind];
  if (!isPattern(pattern)) return null;
  if (kind === "command" && tool !== "Bash") return null;
  if (kind === "path") {
    if (!(tool in PATH_FIELDS)) return null;
    const normal = pattern.replace(/\\/g, "/");
    if (!normal.startsWith("/") && !/^[A-Za-z]:\//.test(normal) && !normal.startsWith("*")) return null;
    return { ...rule, path: normal };
  }
  if (kind === "domain" && (tool !== "WebFetch" || !DOMAIN.test(pattern.toLowerCase()))) return null;
  return { ...rule, [kind]: kind === "domain" ? pattern.toLowerCase() : pattern };
}

/**
 * The stored document, validated whole. `null` (never set) is no rules. Anything this
 * build does not understand is `{ ok: false }`: the caller refuses the agent's tools
 * rather than guess which rule was meant.
 */
export function parseToolRules(value) {
  if (value === null || value === undefined) return { ok: true, rules: [], approvalWaitS: DEFAULT_APPROVAL_WAIT_S };
  if (!isRecord(value) || Object.keys(value).some((k) => !DOC_KEYS.has(k))) return { ok: false };
  if (!Array.isArray(value.rules) || value.rules.length > TOOL_RULE_LIMITS.rules) return { ok: false };
  let approvalWaitS = DEFAULT_APPROVAL_WAIT_S;
  if ("approval_wait_s" in value) {
    const s = value.approval_wait_s;
    if (!Number.isInteger(s) || s < TOOL_RULE_LIMITS.minWaitS || s > TOOL_RULE_LIMITS.maxWaitS) return { ok: false };
    approvalWaitS = s;
  }
  const rules = [];
  for (const candidate of value.rules) {
    const rule = parseRule(candidate);
    if (!rule) return { ok: false };
    rules.push(rule);
  }
  return { ok: true, rules, approvalWaitS };
}

/** `/a/b/../c` → `/a/c`, backslashes to `/`. Not the filesystem: no symlinks. */
function normalisePath(raw) {
  const unified = raw.replace(/\\/g, "/");
  const drive = /^[A-Za-z]:/.exec(unified)?.[0] ?? "";
  const rest = unified.slice(drive.length);
  const out = [];
  for (const segment of rest.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return `${drive}/${out.join("/")}`;
}

function commandPieces(command) {
  return command
    .split(/&&|\|\||[;|\n]/)
    .map((piece) => piece.trim())
    .filter(Boolean);
}

function toolMatches(pattern, name) {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

/**
 * What the rules say about one PreToolUse input: `{ effect: null }` when nothing
 * matches, otherwise the strictest matching rule, its index, and what it matched (the
 * command piece, the normalised path, the host, or the tool's name).
 *
 * Input a rule needs but cannot read (no command, a URL that does not parse) counts as
 * matching that rule: a rule the owner wrote is not skipped because the input was odd.
 */
export function evaluateToolRules(parsed, input) {
  const name = typeof input?.tool_name === "string" ? input.tool_name : "";
  const toolInput = isRecord(input?.tool_input) ? input.tool_input : {};
  let best = null;
  parsed.rules.forEach((rule, ruleIndex) => {
    if (!toolMatches(rule.tool, name)) return;
    const subject = subjectFor(rule, name, toolInput, input);
    if (subject === undefined) return;
    if (!best || STRICTNESS[rule.effect] > STRICTNESS[best.effect]) best = { effect: rule.effect, ruleIndex, subject };
  });
  return best ?? { effect: null };
}

// The matched text, `undefined` when the rule does not apply to this input.
function subjectFor(rule, name, toolInput, input) {
  if (rule.command !== undefined) {
    if (typeof toolInput.command !== "string") return "";
    return commandPieces(toolInput.command).find((piece) => globMatch(rule.command, piece));
  }
  if (rule.path !== undefined) {
    let raw;
    for (const field of PATH_FIELDS[name] ?? []) if (typeof toolInput[field] === "string") raw = toolInput[field];
    if (raw === undefined && SEARCH_TOOLS.has(name) && typeof input?.cwd === "string") raw = input.cwd;
    if (raw === undefined) return "";
    const path = normalisePath(raw);
    return globMatch(rule.path, path) ? path : undefined;
  }
  if (rule.domain !== undefined) {
    let host;
    try {
      host = new URL(String(toolInput.url)).hostname.toLowerCase();
    } catch {
      return "";
    }
    if (rule.domain.startsWith("*.")) {
      const base = rule.domain.slice(2);
      return host === base || host.endsWith(`.${base}`) ? host : undefined;
    }
    return host === rule.domain ? host : undefined;
  }
  return name;
}
