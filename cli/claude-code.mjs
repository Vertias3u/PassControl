// Route Claude Code's own model calls through the PassControl sidecar.
//
// Claude Code reads an `env` block from its settings files wherever it is
// started (verified 2026-10-07, Claude Code 2.1.292): ANTHROPIC_BASE_URL sends
// its calls to the sidecar, and ANTHROPIC_AUTH_TOKEN, a placeholder, rides as a
// Bearer token with no "use this API key?" prompt. The sidecar strips it and the
// gateway injects the real key, so Claude Code never holds one.
//
// The settings file belongs to the user. Only these two keys, and with
// --statusline a `statusLine` running `passcontrol statusline`, are written or
// removed, in one save; the previous file is backed up, a file that is not a JSON
// object is refused rather than overwritten, a different gateway already
// configured is not replaced without --force, and a status line the user already
// has is never replaced at all.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Not a secret: the sidecar discards whatever arrives in this header. */
export const CLAUDE_CODE_AUTH_PLACEHOLDER = "passcontrol-sidecar";

export function claudeCodeEnv(baseUrl) {
  return { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_AUTH_TOKEN: CLAUDE_CODE_AUTH_PLACEHOLDER };
}

/**
 * `project`: this directory's `.claude/settings.local.json`, the file Claude Code
 * keeps out of git. `user`: every Claude Code session, under CLAUDE_CONFIG_DIR
 * when set, as Claude Code itself resolves it.
 */
export function claudeCodeSettingsPath({ scope, cwd = process.cwd(), env = process.env }) {
  if (scope === "user") {
    const dir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
    return path.join(dir, "settings.json");
  }
  return path.join(cwd, ".claude", "settings.local.json");
}

function readSettings(target) {
  if (!fs.existsSync(target)) return { exists: false, value: {} };
  const text = fs.readFileSync(target, "utf8");
  if (!text.trim()) return { exists: true, value: {} };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${target} is not valid JSON; fix or move it, then run this again. Nothing was written.`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${target} is not a JSON object; nothing was written.`);
  }
  return { exists: true, value };
}

function save(target, value, exists) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  let backupPath = null;
  if (exists) {
    backupPath = `${target}.bak`;
    fs.copyFileSync(target, backupPath);
    fs.chmodSync(backupPath, 0o600);
  }
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return backupPath;
}

/**
 * The env keys, and with `statusLineCommand` the status line too, in ONE save:
 * two saves would back up the first save's output and lose the user's original.
 */
export function writeClaudeCodeSettings({ target, baseUrl, force = false, statusLineCommand = null }) {
  const { exists, value } = readSettings(target);
  const env = typeof value.env === "object" && value.env !== null && !Array.isArray(value.env) ? value.env : {};
  const rawKeyFound = typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0;
  const current = env.ANTHROPIC_BASE_URL;
  const envDone = current === baseUrl && env.ANTHROPIC_AUTH_TOKEN === CLAUDE_CODE_AUTH_PLACEHOLDER;
  if (!envDone && typeof current === "string" && current && current !== baseUrl && !force) {
    throw new Error(
      `${target} already points Claude Code at ${current}. Re-run with --force to replace that address with PassControl's.`
    );
  }
  let next = envDone ? value : { ...value, env: { ...env, ...claudeCodeEnv(baseUrl) } };
  let statusLine;
  if (statusLineCommand) {
    const line = withStatusLine(next, statusLineCommand);
    next = line.value;
    statusLine = line.existing !== undefined ? { changed: false, existing: line.existing } : { changed: line.changed };
  }
  const changed = !envDone || Boolean(statusLine?.changed);
  const backupPath = changed ? save(target, next, exists) : null;
  return { changed, backupPath, rawKeyFound, ...(statusLine ? { statusLine } : {}) };
}

/** PassControl's two env keys and its status line, in one save. */
export function removeClaudeCodeSettings({ target }) {
  if (!fs.existsSync(target)) return { changed: false };
  const { value } = readSettings(target);
  let next = value;
  const env = typeof value.env === "object" && value.env !== null && !Array.isArray(value.env) ? value.env : null;
  // Only an address this command could have written: a gateway someone else set
  // up is not ours to remove.
  if (env && env.ANTHROPIC_AUTH_TOKEN === CLAUDE_CODE_AUTH_PLACEHOLDER) {
    const { ANTHROPIC_BASE_URL: _url, ANTHROPIC_AUTH_TOKEN: _token, ...rest } = env;
    next = { ...value };
    if (Object.keys(rest).length) next.env = rest;
    else delete next.env;
  }
  if (isOurStatusLine(next.statusLine)) {
    const { statusLine: _ours, ...rest } = next;
    next = rest;
  }
  if (next === value) return { changed: false };
  save(target, next, true);
  return { changed: true };
}

/**
 * Whether a status line is one `configure claude-code --statusline` wrote: the
 * installed `passcontrol` binary, or this repo's own bin run through node.
 */
function isOurStatusLine(statusLine) {
  const command = typeof statusLine?.command === "string" ? statusLine.command : "";
  return /^(passcontrol|node "[^"]*passcontrol\.mjs") statusline\b/.test(command);
}

/**
 * `value` with PassControl's status line set, unless the user already has one of
 * their own: then `existing` names it and `value` is unchanged.
 */
function withStatusLine(value, command) {
  const current = value.statusLine;
  if (current && !isOurStatusLine(current)) {
    return { value, changed: false, existing: typeof current.command === "string" ? current.command : "(not a command)" };
  }
  if (current && current.type === "command" && current.command === command) return { value, changed: false };
  return { value: { ...value, statusLine: { type: "command", command } }, changed: true };
}

/**
 * The agent's budget in Claude Code's status line, on its own. A status line the
 * user already has is never replaced: the answer names it and nothing is written.
 */
export function writeClaudeCodeStatusLine({ target, command }) {
  const { exists, value } = readSettings(target);
  const line = withStatusLine(value, command);
  if (line.existing !== undefined) return { changed: false, existing: line.existing };
  if (!line.changed) return { changed: false };
  save(target, line.value, exists);
  return { changed: true };
}

export function removeClaudeCodeStatusLine({ target }) {
  if (!fs.existsSync(target)) return { changed: false };
  const { value } = readSettings(target);
  if (!isOurStatusLine(value.statusLine)) return { changed: false };
  const { statusLine: _ours, ...rest } = value;
  save(target, rest, true);
  return { changed: true };
}

// ── Subscription mode ─────────────────────────────────────────────────────────
//
// A Pro/Max login talks to Anthropic directly, and Anthropic's terms forbid
// intermediating it, so nothing here touches ANTHROPIC_BASE_URL. Instead Claude
// Code is told to report to the sidecar and to ask it before acting:
//   * its OpenTelemetry LOG export (http/json) goes to the sidecar's receiver
//     (cli/otlp-logs.mjs). Only the logs-specific variables are written, so a
//     metrics or traces export the user runs is left alone;
//   * three http hooks go to the sidecar's stop gate (cli/subscription-gate.mjs),
//     each with a 5 s timeout: a hook that cannot connect or times out lets the
//     action go ahead, which is the fail-open the owner chose;
//   * the status line carries the usage window (cli/usage-window.mjs);
//   * PASSCONTROL_SIDECAR_URL tells `/passcontrol` which sidecar to ask.
// Only the user settings: Claude Code ignores telemetry settings in a project's file.

const LOOPBACK_BASE = "http://127.0.0.1:";
const OUR_LOGS_ENDPOINT = /^http:\/\/127\.0\.0\.1:\d{1,5}\/_passcontrol\/otlp\/v1\/logs$/;
const OUR_HOOK_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/_passcontrol\/hook(\?t=\d{1,4})?$/;
const OUR_SIDECAR_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const GATED_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolBatch"];
// The log-export settings this mode owns, with the value it writes.
const LOGS_ENV = {
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
  // The 5 s default would make the board's rows lag the session.
  OTEL_LOGS_EXPORT_INTERVAL: "1000",
};

export function subscriptionEnv(port) {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    ...LOGS_ENV,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${LOOPBACK_BASE}${port}/_passcontrol/otlp/v1/logs`,
    PASSCONTROL_SIDECAR_URL: `${LOOPBACK_BASE}${port}`,
  };
}

function gateHook(port) {
  return { type: "http", url: `${LOOPBACK_BASE}${port}/_passcontrol/hook`, timeout: 5 };
}

// PreToolUse may hold a tool while the owner is asked (Phase 2), and Claude Code lets
// a tool RUN when its http hook times out. So this one gets Claude Code's own 600 s
// default, and says so in its URL: the sidecar always answers inside the time it is
// told, and a Phase 1 hook (no `t`, 5 s) refuses a tool that would need the owner
// instead of letting it through on the timeout.
export const TOOL_HOOK_TIMEOUT_S = 600;
function toolHook(port) {
  return { type: "http", url: `${LOOPBACK_BASE}${port}/_passcontrol/hook?t=${TOOL_HOOK_TIMEOUT_S}`, timeout: TOOL_HOOK_TIMEOUT_S };
}

export function subscriptionHooks(port) {
  const hook = gateHook(port);
  return {
    UserPromptSubmit: [{ hooks: [hook] }],
    PreToolUse: [{ matcher: "*", hooks: [toolHook(port)] }],
    PostToolBatch: [{ hooks: [hook] }],
  };
}

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isOurHook = (h) => isObject(h) && h.type === "http" && typeof h.url === "string" && OUR_HOOK_URL.test(h.url);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** `hooks` with every hook this mode wrote taken out, and groups left empty dropped. */
function withoutOurHooks(hooks) {
  if (!isObject(hooks)) return hooks;
  const next = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      next[event] = groups;
      continue;
    }
    const kept = [];
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(isOurHook)) {
        kept.push(group);
        continue;
      }
      const rest = group.hooks.filter((h) => !isOurHook(h));
      if (rest.length) kept.push({ ...group, hooks: rest });
    }
    if (kept.length) next[event] = kept;
  }
  return next;
}

/** `hooks` with exactly this port's gate hooks, leaving them where they are when already right. */
function withOurHooks(hooks, port) {
  const ours = subscriptionHooks(port);
  const base = isObject(hooks) ? hooks : {};
  const next = withoutOurHooks(base);
  for (const event of GATED_EVENTS) {
    const current = Array.isArray(base[event]) ? base[event] : [];
    const already = current.filter((g) => isObject(g) && Array.isArray(g.hooks) && g.hooks.some(isOurHook));
    if (already.length === 1 && same(already[0], ours[event][0])) next[event] = current;
    else next[event] = [...(next[event] ?? []), ...ours[event]];
  }
  return next;
}

// `allowedHttpHookUrls`, when set at any level, runs only the http hooks it matches.
function urlAllowed(patterns, url) {
  return patterns.some((p) => {
    if (typeof p !== "string") return false;
    const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
    return re.test(url);
  });
}

/**
 * Subscription mode's settings, in one save. Throws, writing nothing, when the
 * user already exports Claude Code's logs somewhere else and `force` is not set.
 */
export function writeClaudeCodeSubscription({ target, port, statusLineCommand, force = false }) {
  const { exists, value } = readSettings(target);
  const env = isObject(value.env) ? value.env : {};
  const endpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  const ourEndpoint = typeof endpoint === "string" && OUR_LOGS_ENDPOINT.test(endpoint);
  const theirs = [];
  if (endpoint !== undefined && !ourEndpoint) theirs.push("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT");
  if (env.OTEL_LOGS_EXPORTER !== undefined && !ourEndpoint) theirs.push("OTEL_LOGS_EXPORTER");
  if (theirs.length && !force) {
    throw new Error(
      `${target} already exports Claude Code's logs (${theirs.join(", ")}). Subscription mode would send them to the sidecar instead. Re-run with --force to do that; nothing was written.`
    );
  }
  let next = { ...value, env: { ...env, ...subscriptionEnv(port) }, hooks: withOurHooks(value.hooks, port) };
  let statusLine;
  if (statusLineCommand) {
    const line = withStatusLine(next, statusLineCommand);
    next = line.value;
    statusLine = line.existing !== undefined ? { changed: false, existing: line.existing } : { changed: line.changed };
  }
  const changed = !same(next, value);
  const backupPath = changed ? save(target, next, exists) : null;
  const allowlist = Array.isArray(value.allowedHttpHookUrls) ? value.allowedHttpHookUrls : null;
  return {
    changed,
    backupPath,
    ...(statusLine ? { statusLine } : {}),
    hookUrlsBlocked: Boolean(allowlist && [gateHook(port), toolHook(port)].some((h) => !urlAllowed(allowlist, h.url))),
    routed: env.ANTHROPIC_AUTH_TOKEN === CLAUDE_CODE_AUTH_PLACEHOLDER && typeof env.ANTHROPIC_BASE_URL === "string",
  };
}

/**
 * Takes out what `writeClaudeCodeSubscription` wrote: its hooks, its status line, its
 * sidecar address, and the logs export only when it points at a sidecar. The
 * telemetry switch stays while any other OTEL_ setting still needs it.
 */
export function removeClaudeCodeSubscription({ target }) {
  if (!fs.existsSync(target)) return { changed: false };
  const { value } = readSettings(target);
  let next = { ...value };
  if (isObject(value.env)) {
    const env = { ...value.env };
    if (typeof env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT === "string" && OUR_LOGS_ENDPOINT.test(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT)) {
      delete env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
      for (const [key, ours] of Object.entries(LOGS_ENV)) if (env[key] === ours) delete env[key];
      if (env.CLAUDE_CODE_ENABLE_TELEMETRY === "1" && !Object.keys(env).some((k) => k.startsWith("OTEL_"))) {
        delete env.CLAUDE_CODE_ENABLE_TELEMETRY;
      }
    }
    if (typeof env.PASSCONTROL_SIDECAR_URL === "string" && OUR_SIDECAR_URL.test(env.PASSCONTROL_SIDECAR_URL)) delete env.PASSCONTROL_SIDECAR_URL;
    if (Object.keys(env).length) next.env = env;
    else delete next.env;
  }
  if (isObject(value.hooks)) {
    const hooks = withoutOurHooks(value.hooks);
    if (Object.keys(hooks).length) next.hooks = hooks;
    else delete next.hooks;
  }
  if (isOurStatusLine(next.statusLine)) delete next.statusLine;
  if (same(next, value)) return { changed: false };
  save(target, next, true);
  return { changed: true };
}
