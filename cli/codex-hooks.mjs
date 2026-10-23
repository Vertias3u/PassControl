// Subscription mode for Codex (1.6.0, L5).
//
// A Codex session signed in with a ChatGPT plan talks to OpenAI directly, so the
// gateway cannot refuse its calls, as with a Claude Pro/Max login
// (cli/subscription-gate.mjs). The stops and tool rules still reach it through
// Codex's hooks: `passcontrol configure codex --subscription` adds two to
// `$CODEX_HOME/hooks.json`, each running `passcontrol codex-hook`, which hands
// Codex's input to the sidecar's hook endpoint (the one Claude Code calls) and
// answers in Codex's terms:
//
//   UserPromptSubmit  a stopped agent's prompt is blocked and the turn ends
//   PreToolUse        a stopped agent's tools, and the tool rules' denials, are refused
//
// Codex has command hooks only (no http hook), hence the relay. Three differences
// from Claude Code are handled here, not in the sidecar:
//   * hooks.json is SHARED (Peras writes into it), unlike the profile file
//     cli/codex.mjs writes. Only entries whose command is PassControl's are added,
//     replaced or removed (Peras's `ours()` rule), and the file is backed up the first
//     time PassControl writes into one it did not create;
//   * on PreToolUse, Codex takes `continue`, `stopReason`, `suppressOutput` and
//     `permissionDecision: "ask"` as a FAILED hook and runs the tool. The sidecar's
//     answers carry `continue: false` with every stop, so Codex's answer is rebuilt
//     from an allow-list, and an "ask" rule becomes a refusal that says why;
//   * Codex runs a hook only once the user has trusted it in `/hooks`, by its hash.
//     The command is the same string on every run of configure, so a trusted hook
//     stays trusted;
//   * the command names node and the CLI by absolute path, like Peras's. A bare
//     `passcontrol` failed both ways on the owner's Mac: "command not found" under a
//     GUI app's minimal PATH, and "Unknown command" from an older CLI on PATH. Either
//     is a failed hook, so configure runs the exact command once under a bare PATH
//     before saying it is set up.
//
// Honest limits, said in the CLI too: Codex has no strict hook mode, so a hook that
// fails or is not trusted lets the action go ahead; the tool rules' path rules (Read,
// Write, Edit) and domain rules (WebFetch) name Claude Code's tools, which Codex does
// not have, so only command rules (Bash) and MCP tool rules can match; and a session
// cannot be stopped on its own, since its calls never pass the gateway.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { GATE_HOOK_TIMEOUT_S, HOOK_PATH } from "./subscription-gate.mjs";

/** Codex's timeout for the tool hook: an "ask the owner" rule holds it while the owner answers. */
export const CODEX_TOOL_HOOK_TIMEOUT_S = 600;
const PROMPT_RELAY_MS = GATE_HOOK_TIMEOUT_S * 1000 - 500;
const TOOL_RELAY_MS = (CODEX_TOOL_HOOK_TIMEOUT_S - 10) * 1000;
const EVENTS = ["UserPromptSubmit", "PreToolUse"];
const BACKUP_SUFFIX = ".passcontrol-backup";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => (typeof v === "string" && v.length > 0 ? v : null);

export function codexHooksPath({ env = process.env } = {}) {
  return path.join(env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex"), "hooks.json");
}

/** PassControl's own entry: `passcontrol codex-hook …`, or `node ".../passcontrol.mjs" codex-hook …`. */
export function isPassControlCodexHook(hook) {
  return isObject(hook) && hook.type === "command" && typeof hook.command === "string" && /(^|[\s"/])passcontrol(\.mjs)?"?\s+codex-hook(\s|$)/u.test(hook.command);
}

/**
 * The command both hooks run: node and the CLI by absolute path, so PATH never
 * decides whether it runs. Refuses a path a shell would read differently.
 */
export function codexHookCommand({ port, node = process.execPath, entry }) {
  for (const p of [node, entry]) {
    if (typeof p !== "string" || !p || /["$`]/u.test(p)) {
      throw new Error(`The path ${JSON.stringify(String(p))} cannot be quoted safely for Codex's hook command.`);
    }
  }
  return `"${node}" "${entry}" codex-hook --port ${port}`;
}

/**
 * Runs the exact command as Codex would, under a bare PATH, with an input it answers
 * with nothing. Not on Windows, where Codex runs hooks through its own shell.
 */
export function probeCodexHookCommand(command) {
  if (process.platform === "win32") return { ok: true };
  const run = spawnSync("/bin/sh", ["-c", command], {
    input: JSON.stringify({ hook_event_name: "SessionStart" }),
    env: { PATH: "/usr/bin:/bin", HOME: os.homedir(), PASSCONTROL_NO_UPDATE_CHECK: "1" },
    encoding: "utf8",
    timeout: 15_000,
  });
  if (run.status !== 0) return { ok: false, why: `it ended with exit ${run.status ?? "none"}${run.stderr ? `: ${run.stderr.trim().slice(0, 200)}` : ""}` };
  if (run.stdout.trim()) return { ok: false, why: `it printed output it should not: ${run.stdout.trim().slice(0, 200)}` };
  return { ok: true };
}

/** The two entries PassControl adds, as a hooks file of their own. */
export function codexHookEntries(command) {
  return {
    hooks: {
      UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: GATE_HOOK_TIMEOUT_S }] }],
      PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command, timeout: CODEX_TOOL_HOOK_TIMEOUT_S }] }],
    },
  };
}

function readHooksFile(target) {
  if (!fs.existsSync(target)) return { value: {}, exists: false };
  let value;
  try {
    value = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    value = null;
  }
  if (!isObject(value) || (value.hooks !== undefined && !isObject(value.hooks))) {
    throw new Error(`${target} is not a hooks object; nothing was written.`);
  }
  return { value, exists: true };
}

/** Each event's groups with PassControl's hooks taken out; a group left empty goes. */
function withoutOurs(hooks) {
  const next = { ...hooks };
  for (const event of Object.keys(next)) {
    if (!Array.isArray(next[event])) continue;
    next[event] = next[event].flatMap((group) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
      const rest = group.hooks.filter((h) => !isPassControlCodexHook(h));
      if (rest.length === group.hooks.length) return [group];
      return rest.length ? [{ ...group, hooks: rest }] : [];
    });
    if (next[event].length === 0) delete next[event];
  }
  return next;
}

const hasOurs = (hooks) =>
  Object.values(hooks ?? {}).some((groups) => Array.isArray(groups) && groups.some((g) => isObject(g) && Array.isArray(g.hooks) && g.hooks.some(isPassControlCodexHook)));

function save(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

/** Add PassControl's two hooks, replacing any earlier ones of its own and nobody else's. */
export function writeCodexHooks({ target, command }) {
  const { value, exists } = readHooksFile(target);
  const hooks = withoutOurs(value.hooks ?? {});
  for (const [event, groups] of Object.entries(codexHookEntries(command).hooks)) {
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), ...groups];
  }
  const next = { ...value, hooks };
  if (JSON.stringify(next) === JSON.stringify(value)) return { changed: false, backupPath: null };
  let backupPath = null;
  if (exists && !hasOurs(value.hooks)) {
    backupPath = `${target}${BACKUP_SUFFIX}`;
    fs.copyFileSync(target, backupPath);
    fs.chmodSync(backupPath, 0o600);
  }
  save(target, next);
  return { changed: true, backupPath };
}

/** Take PassControl's hooks back out; everything else stays as it was. */
export function removeCodexHooks({ target }) {
  if (!fs.existsSync(target)) return { changed: false };
  const { value } = readHooksFile(target);
  if (!hasOurs(value.hooks)) return { changed: false };
  const hooks = withoutOurs(value.hooks);
  const { hooks: _old, ...rest } = value;
  save(target, Object.keys(hooks).length ? { ...rest, hooks } : rest);
  return { changed: true };
}

const ASK_IN_CODEX =
  " Codex cannot ask here, so PassControl refuses it: the user can run it themselves, or the agent's owner can change the rule on the agent's page.";

/**
 * The sidecar's answer (Claude Code's hook output) as Codex must get it, built from
 * an allow-list: on PreToolUse, a field Codex does not support there fails the hook,
 * and a failed hook lets the tool run.
 */
export function codexHookAnswer(event, out) {
  const o = isObject(out) ? out : {};
  const systemMessage = text(o.systemMessage);
  const warning = systemMessage ? { systemMessage } : {};
  if (event === "PreToolUse") {
    const hso = isObject(o.hookSpecificOutput) ? o.hookSpecificOutput : {};
    const stopped = o.continue === false || o.decision === "block";
    const said = text(hso.permissionDecisionReason) ?? text(o.stopReason) ?? text(o.reason);
    let reason = null;
    if (hso.permissionDecision === "deny" || stopped) reason = said ?? "PassControl refused this tool call.";
    else if (hso.permissionDecision === "ask") reason = `${said ?? "PassControl: the agent's tool rules ask the user to confirm this."}${ASK_IN_CODEX}`;
    if (reason === null) return warning;
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason }, ...warning };
  }
  if (event === "UserPromptSubmit") {
    const answer = {};
    if (o.continue === false) answer.continue = false;
    if (text(o.stopReason)) answer.stopReason = o.stopReason;
    if (o.decision === "block") answer.decision = "block";
    if (text(o.reason)) answer.reason = o.reason;
    const context = isObject(o.hookSpecificOutput) ? text(o.hookSpecificOutput.additionalContext) : null;
    if (context) answer.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: context };
    return { ...answer, ...warning };
  }
  return {};
}

/**
 * What `passcontrol codex-hook` prints for one hook run: Codex's input in, the
 * sidecar's answer out, or nothing. Never throws, and never blocks on its own
 * failure: a sidecar that is down or slow lets the action go ahead, with a warning.
 */
export async function runCodexHook({ input, port, fetchImpl = fetch, promptTimeoutMs = PROMPT_RELAY_MS, toolTimeoutMs = TOOL_RELAY_MS }) {
  let parsed;
  try {
    parsed = JSON.parse(input);
  } catch {
    return "";
  }
  const event = isObject(parsed) ? parsed.hook_event_name : null;
  if (!EVENTS.includes(event)) return "";
  const tool = event === "PreToolUse";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), tool ? toolTimeoutMs : promptTimeoutMs);
  const warn = (why) => JSON.stringify({ systemMessage: `PassControl: ${why}, so this goes ahead unchecked.` });
  try {
    const url = `http://127.0.0.1:${port}${HOOK_PATH}${tool ? `?t=${CODEX_TOOL_HOOK_TIMEOUT_S}` : ""}`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: input,
      signal: controller.signal,
    });
    if (!response.ok) return warn(`the sidecar on port ${port} refused the hook (HTTP ${response.status})`);
    const out = await response.json().catch(() => null);
    if (!isObject(out)) return warn(`the sidecar on port ${port} gave an answer that cannot be read`);
    const answer = codexHookAnswer(event, out);
    return Object.keys(answer).length ? JSON.stringify(answer) : "";
  } catch {
    if (controller.signal.aborted) return warn(`the sidecar on port ${port} did not answer in time`);
    return warn(`no sidecar answered on port ${port} (start it: passcontrol sidecar --port ${port})`);
  } finally {
    clearTimeout(timer);
  }
}
