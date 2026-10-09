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
