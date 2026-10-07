// Route Claude Code's own model calls through the PassControl sidecar.
//
// Claude Code reads an `env` block from its settings files wherever it is
// started (verified 2026-10-07, Claude Code 2.1.292): ANTHROPIC_BASE_URL sends
// its calls to the sidecar, and ANTHROPIC_AUTH_TOKEN, a placeholder, rides as a
// Bearer token with no "use this API key?" prompt. The sidecar strips it and the
// gateway injects the real key, so Claude Code never holds one.
//
// The settings file belongs to the user. Only these two keys are written or
// removed, the previous file is backed up, a file that is not a JSON object is
// refused rather than overwritten, and a different gateway already configured is
// not replaced without --force.
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

export function writeClaudeCodeSettings({ target, baseUrl, force = false }) {
  const { exists, value } = readSettings(target);
  const env = typeof value.env === "object" && value.env !== null && !Array.isArray(value.env) ? value.env : {};
  const rawKeyFound = typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.length > 0;
  const current = env.ANTHROPIC_BASE_URL;
  if (current === baseUrl && env.ANTHROPIC_AUTH_TOKEN === CLAUDE_CODE_AUTH_PLACEHOLDER) {
    return { changed: false, backupPath: null, rawKeyFound };
  }
  if (typeof current === "string" && current && current !== baseUrl && !force) {
    throw new Error(
      `${target} already points Claude Code at ${current}. Re-run with --force to replace that address with PassControl's.`
    );
  }
  const backupPath = save(target, { ...value, env: { ...env, ...claudeCodeEnv(baseUrl) } }, exists);
  return { changed: true, backupPath, rawKeyFound };
}

export function removeClaudeCodeSettings({ target }) {
  if (!fs.existsSync(target)) return { changed: false };
  const { value } = readSettings(target);
  const env = typeof value.env === "object" && value.env !== null && !Array.isArray(value.env) ? value.env : null;
  // Only an address this command could have written: a gateway someone else set
  // up is not ours to remove.
  if (!env || env.ANTHROPIC_AUTH_TOKEN !== CLAUDE_CODE_AUTH_PLACEHOLDER) return { changed: false };
  const { ANTHROPIC_BASE_URL: _url, ANTHROPIC_AUTH_TOKEN: _token, ...rest } = env;
  const next = { ...value };
  if (Object.keys(rest).length) next.env = rest;
  else delete next.env;
  save(target, next, true);
  return { changed: true };
}
