#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import {
  CONFIG_FILE,
  OPENAI_SHAPE_PROVIDERS,
  PROVIDERS,
  config,
  configPathLabel,
  defaultModelForProvider,
  fail,
  formatChallengeError,
  formatProxyError,
  globalConfigPath,
  ok,
  redact,
  requireControlApiKey,
  requirePassport,
  step,
  writeConfigFile,
} from "../cli/config.mjs";
import { startSidecar } from "../cli/sidecar.mjs";

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DASHBOARD_STATE_FILE = "local-dashboard.json";
const APP_STATE_FILE = "app.json";
const PUBLIC_REPO_URL = "https://github.com/Vertias3u/PassControl.git";
const LOCAL_DASHBOARD_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOCAL_STACK_PORTS = [54321, 54322, 54324, 54327, 8079];
// The local stack (Supabase + Redis + dashboard) lives in a PassControl repo
// checkout — NOT in the installed CLI package (which ships only bin/ + cli/).
// `appRoot` is that checkout: the surrounding repo when run via `npm run cli --`,
// or a cloned/configured checkout when the CLI is installed globally. Resolved
// lazily by ensureAppRoot() before any stack command runs.
let appRoot = null;

function parseArgv(argv) {
  const opts = {};
  const rest = [];
  const optKey = (key) => key.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--") || arg === "--") {
      rest.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    if (eq !== -1) {
      opts[optKey(arg.slice(2, eq))] = arg.slice(eq + 1);
      continue;
    }

    const key = optKey(arg.slice(2));
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      opts[key] = next;
      i++;
    } else {
      opts[key] = true;
    }
  }
  return { opts, rest };
}

function cliPrefix() {
  return process.env.npm_lifecycle_event === "cli" ? "npm run cli --" : "passcontrol";
}

function cliCommand(args = "") {
  return args ? `${cliPrefix()} ${args}` : cliPrefix();
}

function usage() {
  const cmd = cliPrefix();
  return `PassControl

Usage:
  ${cmd}                         show cockpit status
  ${cmd} init [--global]          create a config profile
  ${cmd} status [--no-network]    show active config
  ${cmd} start                    start the configured local dashboard
  ${cmd} stop                     stop the CLI-managed local dashboard
  ${cmd} restart                  restart the CLI-managed local dashboard
  ${cmd} local-logs [--follow]    show local dashboard logs
  ${cmd} doctor [--deep] [--fix]  check local setup and repair a stopped dashboard
  ${cmd} reset --local --confirm RESET
                                 destroy and recreate the local stack
  ${cmd} setup [--no-open] [--port-offset N] [--app-dir DIR]
                                 clone the app (if needed), start local services, open the dashboard
  ${cmd} call "hi"                mint a visa and call a model
  ${cmd} sidecar [--port 8788]    start the local agent bridge
  ${cmd} env [openhands]          print sidecar settings for agents
  ${cmd} configure <integration> [--write]
                                 preview or create a supported integration config
  ${cmd} agent list               list agents
  ${cmd} agent create <name>      create an agent passport
  ${cmd} agent suspend <id>       suspend an agent
  ${cmd} agent resume <id>        resume an agent
  ${cmd} agent revoke <id>        revoke an agent
  ${cmd} spend                    show fleet + per-agent spend
  ${cmd} audit [--limit 20]        show admin audit trail
  ${cmd} logs [--limit 20]         show gateway call logs
  ${cmd} kill on|off              toggle tenant kill switch
  ${cmd} open                     start (if needed) and open the dashboard

Config:
  Env vars win, then nearest .passcontrol, then ~/.config/passcontrol/config.
  Installed globally, the local-stack commands (setup/start/reset) use a cloned
  app checkout; override its location with PASSCONTROL_APP_ROOT.
`;
}

function assertProvider(provider) {
  if (!PROVIDERS.includes(provider)) {
    throw new Error(`Unknown provider "${provider}". Use one of: ${PROVIDERS.join(", ")}.`);
  }
}

function activeModel(provider, opts = {}) {
  if (opts.model) return opts.model;
  if (process.env.MODEL) return process.env.MODEL;
  if (provider === config.provider) return config.model;
  return defaultModelForProvider(provider);
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function gatewayStatus(noNetwork = false) {
  if (noNetwork) return { label: "not checked", ok: null };
  try {
    const res = await fetchWithTimeout(config.gateway, { method: "GET" });
    return { label: res.ok ? `online (${res.status})` : `unhealthy (${res.status})`, ok: res.ok };
  } catch {
    return { label: "offline or unreachable", ok: false };
  }
}

async function printCockpit({ noNetwork = false } = {}) {
  const gateway = await gatewayStatus(noNetwork);
  const passportConfigured = Boolean(config.passportId && config.passportSecret);
  const adminConfigured = Boolean(config.apiKey);

  console.log("PassControl\n");
  console.log(`Gateway:  ${gateway.label}  ${config.gateway}`);
  console.log(`Dashboard: ${dashboardStatusLabel(gateway, noNetwork)}`);
  console.log(`App:      ${appRootLabel()}`);
  console.log(`Config:   ${configPathLabel(config.sources)}`);
  console.log(`Provider: ${config.provider}`);
  console.log(`Model:    ${config.model}`);
  console.log(`Passport: ${passportConfigured ? redact(config.passportId) : "missing"}`);
  console.log(`Admin key: ${adminConfigured ? redact(config.apiKey, 6) : "missing"}`);
  console.log(`Sidecar:  foreground command (\`${cliCommand("sidecar")}\`)\n`);
  console.log("Next commands:");
  console.log(`  ${cliCommand("start")}             start the local dashboard`);
  console.log(`  ${cliCommand("stop")}              stop the local dashboard`);
  console.log(`  ${cliCommand("restart")}           restart the local dashboard`);
  console.log(`  ${cliCommand("local-logs --follow")}  follow local dashboard logs`);
  console.log(`  ${cliCommand("init")}              configure this project`);
  console.log(`  ${cliCommand('call "hi"')}         test a governed model call`);
  console.log(`  ${cliCommand("sidecar")}           start the local agent bridge`);
  console.log(`  ${cliCommand("agent list")}        list agents`);
  console.log(`  ${cliCommand("spend")}             show fleet spend`);
  console.log(`  ${cliCommand("env openhands")}     print agent settings`);
  console.log(`  ${cliCommand("doctor")}            check setup`);
  console.log(`  ${cliCommand("open")}              open dashboard`);
}

function appConfigDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "passcontrol");
}

function dashboardStatePath(env = process.env) {
  return path.join(appConfigDir(env), DASHBOARD_STATE_FILE);
}

function dashboardLogPath(env = process.env) {
  return path.join(appConfigDir(env), "local-dashboard.log");
}

function appRootStatePath(env = process.env) {
  return path.join(appConfigDir(env), APP_STATE_FILE);
}

// A directory is a usable stack checkout if it has the bootstrap script, the
// Redis compose file, and a package.json (with the dev:stack/dev:docker scripts).
function isRepoCheckout(dir) {
  return Boolean(
    dir &&
      fs.existsSync(path.join(dir, "scripts", "dev-stack.sh")) &&
      fs.existsSync(path.join(dir, "docker", "compose.yml")) &&
      fs.existsSync(path.join(dir, "package.json"))
  );
}

function readSavedAppRoot() {
  try {
    const saved = JSON.parse(fs.readFileSync(appRootStatePath(), "utf8")).path;
    return typeof saved === "string" ? saved : null;
  } catch {
    return null;
  }
}

function saveAppRoot(dir) {
  const statePath = appRootStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(statePath, `${JSON.stringify({ path: dir, savedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
}

// Precedence: explicit env override → the surrounding checkout (npm run cli --) →
// a previously cloned/saved checkout. Returns null when the CLI is installed
// globally and no stack has been set up yet.
function resolveAppRoot() {
  const envRoot = process.env.PASSCONTROL_APP_ROOT?.trim();
  if (envRoot) {
    const abs = path.resolve(envRoot);
    if (!isRepoCheckout(abs)) {
      throw new Error(`PASSCONTROL_APP_ROOT=${envRoot} is not a PassControl checkout (missing scripts/dev-stack.sh).`);
    }
    return abs;
  }
  if (process.env.PASSCONTROL_FORCE_INSTALLED !== "1" && isRepoCheckout(PACKAGE_ROOT)) return PACKAGE_ROOT;
  const saved = readSavedAppRoot();
  if (saved && isRepoCheckout(saved)) return path.resolve(saved);
  return null;
}

function defaultAppDir() {
  return path.join(os.homedir(), "passcontrol");
}

function appRootLabel() {
  try {
    return resolveAppRoot() ?? `not set up (run \`${cliCommand("setup")}\`)`;
  } catch (error) {
    return error.message;
  }
}

function commandExists(command) {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function promptLine(question, fallback) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

async function confirmYes(question) {
  const answer = (await promptLine(question, "")).toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

// Resolve the stack checkout, cloning the public repo on demand when the CLI is
// installed globally. `clone: false` never clones — it errors with a pointer to
// `passcontrol setup` (used by reset/doctor, where there's nothing yet to act on).
async function ensureAppRoot({ clone = false, appDir, yes = false } = {}) {
  if (appRoot) return appRoot;
  const resolved = resolveAppRoot();
  if (resolved) {
    appRoot = resolved;
    return appRoot;
  }
  if (!clone) {
    throw new Error(
      `No PassControl app checkout found. Run \`${cliCommand("setup")}\` to clone and start it, or set PASSCONTROL_APP_ROOT to an existing checkout.`
    );
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive && !yes) {
    throw new Error(
      `No PassControl app checkout found. Re-run \`${cliCommand("setup")}\` in an interactive terminal, or pass --yes (with optional --app-dir <path>) to clone ${PUBLIC_REPO_URL} non-interactively.`
    );
  }

  const target = path.resolve(appDir || (interactive ? await promptLine(`Where should the PassControl app be cloned? [${defaultAppDir()}] `, defaultAppDir()) : defaultAppDir()));
  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    if (isRepoCheckout(target)) {
      saveAppRoot(target);
      appRoot = target;
      ok(`Using existing PassControl checkout at ${target}`);
      return appRoot;
    }
    throw new Error(`${target} already exists and is not empty. Choose an empty path with --app-dir.`);
  }

  if (!commandExists("git")) {
    throw new Error("git is required to fetch the PassControl app. Install it from https://git-scm.com/downloads, then retry.");
  }
  if (interactive && !yes) {
    const proceed = await confirmYes(`Clone ${PUBLIC_REPO_URL} into ${target} and install dependencies? [Y/n] `);
    if (!proceed) throw new Error("Aborted — nothing was cloned.");
  }

  step(`Cloning ${PUBLIC_REPO_URL} → ${target}…`);
  await runCommand("git", ["clone", "--depth", "1", PUBLIC_REPO_URL, target], { cwd: process.cwd() });
  step("Installing dependencies (npm install)…");
  await runCommand(process.platform === "win32" ? "npm.cmd" : "npm", ["install"], { cwd: target });
  saveAppRoot(target);
  appRoot = target;
  ok(`PassControl app ready at ${target}`);
  return appRoot;
}

function localComposeProjectName() {
  const configPath = path.join(appRoot, "supabase", "config.toml");
  const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  const projectId = configText.match(/^project_id\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? path.basename(appRoot);
  return `passcontrol_${projectId.replace(/[^A-Za-z0-9]/g, "_").toLowerCase()}`;
}

function localDashboard() {
  let url;
  try {
    url = new URL(config.gateway);
  } catch {
    throw new Error(`Invalid PASSCONTROL_GATEWAY URL: ${config.gateway}`);
  }

  if (url.protocol !== "http:" || !LOCAL_DASHBOARD_HOSTS.has(url.hostname)) {
    throw new Error(
      `passcontrol only manages local gateways (http://localhost or 127.0.0.1); configured gateway is ${config.gateway}.`
    );
  }

  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid local dashboard port in PASSCONTROL_GATEWAY: ${config.gateway}`);
  }
  return { url: url.toString().replace(/\/$/, ""), port };
}

function readDashboardState() {
  const statePath = dashboardStatePath();
  try {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (!Number.isInteger(state.pid) || state.pid < 1) throw new Error("bad pid");
    return state;
  } catch {
    return null;
  }
}

function removeDashboardState() {
  fs.rmSync(dashboardStatePath(), { force: true });
}

function runningManagedDashboard() {
  const state = readDashboardState();
  if (!state) return null;
  try {
    process.kill(state.pid, 0);
    return state;
  } catch (error) {
    if (error.code === "ESRCH") removeDashboardState();
    return null;
  }
}

function dashboardStatusLabel(gateway, noNetwork) {
  try {
    localDashboard();
  } catch {
    return "remote gateway (not managed locally)";
  }
  if (noNetwork) return "local server not checked";
  const managed = runningManagedDashboard();
  if (managed) return gateway.ok ? `CLI-managed (PID ${managed.pid})` : `CLI-managed, unhealthy (PID ${managed.pid})`;
  return gateway.ok ? "online (not managed by CLI)" : "stopped";
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function portIsListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (listening) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(listening);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

async function waitForPortRelease(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await portIsListening(port)) return true;
    await pause(100);
  }
  return !await portIsListening(port);
}

async function waitForGateway(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const gateway = await gatewayStatus(false);
    if (gateway.ok) return true;
    await pause(250);
  }
  return false;
}

function ownSupabaseDatabaseIsRunning(offset = 0) {
  const project = `${path.basename(appRoot)}${offset ? `-${offset}` : ""}`;
  try {
    return Boolean(
      execFileSync("docker", ["ps", "-q", "--filter", `name=^/supabase_db_${project}$`], { encoding: "utf8" }).trim()
    );
  } catch {
    return false;
  }
}

async function assertLocalStackPortsAvailable(offset = 0) {
  if (ownSupabaseDatabaseIsRunning(offset)) return;
  const busy = [];
  for (const port of LOCAL_STACK_PORTS.map((port) => port + offset)) {
    if (await portIsListening(port)) busy.push(port);
  }
  if (busy.length) {
    throw new Error(
      `Local stack ports ${busy.join(", ")} are in use by another project. Stop that project first (for example, \`supabase stop --project-id <project>\`), then rerun \`passcontrol setup\`.`
    );
  }
}

async function startDashboard(opts = {}) {
  await ensureAppRoot({ clone: true, appDir: opts.appDir, yes: opts.yes });
  const dashboard = localDashboard();
  if ((await gatewayStatus(false)).ok) {
    ok(`dashboard already online at ${dashboard.url}`);
    return dashboard;
  }

  const running = runningManagedDashboard();
  if (running) {
    step(`dashboard is still starting (PID ${running.pid}); waiting for ${dashboard.url}…`);
    if (await waitForGateway()) {
      ok(`dashboard online at ${dashboard.url}`);
      return dashboard;
    }
    throw new Error(`CLI-managed dashboard (PID ${running.pid}) did not become ready. See ${running.logPath}.`);
  }

  const envFile = path.join(appRoot, ".env.docker");
  if (!fs.existsSync(envFile)) {
    throw new Error(`Local stack is not configured. Run \`${cliCommand("setup")}\` in ${appRoot} first.`);
  }

  const statePath = dashboardStatePath();
  const logPath = dashboardLogPath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(logPath, "a", 0o600);
  const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev:docker"], {
    cwd: appRoot,
    detached: process.platform !== "win32",
    env: { ...process.env, PORT: String(dashboard.port) },
    stdio: ["ignore", logFd, logFd],
  });
  fs.closeSync(logFd);
  child.unref();
  fs.writeFileSync(
    statePath,
    `${JSON.stringify({ pid: child.pid, gateway: dashboard.url, port: dashboard.port, logPath, startedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 }
  );

  step(`starting local dashboard at ${dashboard.url}…`);
  if (!await waitForGateway()) {
    throw new Error(`Dashboard did not become ready. See ${logPath}.`);
  }
  ok(`dashboard online at ${dashboard.url}`);
  return dashboard;
}

async function stopDashboard() {
  const state = runningManagedDashboard();
  if (!state) {
    ok("No CLI-managed local dashboard is running.");
    return;
  }

  try {
    if (process.platform === "win32") process.kill(state.pid, "SIGTERM");
    else process.kill(-state.pid, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") {
      removeDashboardState();
      ok("No CLI-managed local dashboard is running.");
      return;
    }
    throw error;
  }

  if (!await waitForPortRelease(state.port)) {
    if (process.platform === "win32") process.kill(state.pid, "SIGKILL");
    else process.kill(-state.pid, "SIGKILL");
    if (!await waitForPortRelease(state.port)) {
      throw new Error(`Dashboard process group ${state.pid} did not release port ${state.port}.`);
    }
  }
  removeDashboardState();
  ok(`stopped CLI-managed dashboard (PID ${state.pid})`);
}

async function restartDashboard(opts = {}) {
  localDashboard();
  const managed = runningManagedDashboard();
  if (!managed) {
    if ((await gatewayStatus(false)).ok) {
      throw new Error("Dashboard is online but was not started by passcontrol; stop it manually before restarting.");
    }
    return startDashboard(opts);
  }
  await stopDashboard();
  return startDashboard(opts);
}

async function localLogsCommand(opts = {}) {
  const logPath = dashboardLogPath();
  if (!fs.existsSync(logPath)) {
    throw new Error(`No local dashboard log found at ${logPath}. Run \`passcontrol start\` first.`);
  }
  if (!opts.follow) {
    process.stdout.write(fs.readFileSync(logPath, "utf8"));
    return;
  }
  if (process.platform === "win32") {
    throw new Error(`Live log following is not available on Windows. Open ${logPath} directly.`);
  }
  await new Promise((resolve, reject) => {
    const child = spawn("tail", ["-n", "100", "-f", logPath], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`tail exited with code ${code}.`)));
  });
}

async function runCommand(command, args, { cwd = appRoot, env = process.env } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}.`)));
  });
}

async function runLocalCommand(command, args, env = process.env) {
  await runCommand(command, args, { cwd: appRoot, env });
}

async function resetLocalStack(opts = {}) {
  if (opts.local !== true) {
    throw new Error("Usage: passcontrol reset --local --confirm RESET");
  }
  localDashboard();
  if (opts.confirm !== "RESET") {
    throw new Error("reset refuses to delete local data without `--confirm RESET`.");
  }
  await ensureAppRoot({ clone: false });

  step("Resetting local PassControl data, Supabase, and Redis…");
  await stopDashboard();
  await runLocalCommand("supabase", ["stop", "--no-backup"]);
  await runLocalCommand("docker", ["compose", "-f", "docker/compose.yml", "down", "-v"], {
    ...process.env,
    COMPOSE_PROJECT_NAME: localComposeProjectName(),
  });
  fs.rmSync(path.join(appRoot, ".env.docker"), { force: true });
  await runLocalCommand(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev:stack"]);
  ok("Local stack recreated. Run `passcontrol start` to launch the dashboard.");
}

async function setupLocal(opts = {}) {
  const dashboard = localDashboard();
  const offset = opts.portOffset === undefined ? 0 : Number(opts.portOffset);
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000) {
    throw new Error("--port-offset must be an integer from 0 to 10000.");
  }
  await ensureAppRoot({ clone: true, appDir: opts.appDir, yes: opts.yes });
  await assertLocalStackPortsAvailable(offset);
  step("Preparing the local Supabase, Redis, migrations, and dev user…");
  await runLocalCommand(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev:stack"], {
    ...process.env,
    PASSCONTROL_PORT_OFFSET: String(offset),
  });
  await startDashboard(opts);
  if (!opts.noOpen) await openDashboard(opts);
  console.log(`\nLocal dashboard: ${dashboard.url}`);
  console.log("Local-only login: dev@passcontrol.local / passcontrol-dev");
  step("Add a non-critical provider key, issue a passport, then run `passcontrol doctor --deep`.");
}

async function initCommand(opts) {
  if (!process.stdin.isTTY) {
    throw new Error("`passcontrol init` needs an interactive terminal. Or copy .passcontrol.example to .passcontrol and edit it.");
  }

  const target = opts.global ? globalConfigPath() : path.join(process.cwd(), CONFIG_FILE);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (fs.existsSync(target)) {
      const overwrite = await rl.question(`${target} already exists. Overwrite? [y/N]: `);
      if (!/^y(es)?$/i.test(overwrite.trim())) {
        ok("left existing config unchanged");
        return;
      }
    }

    console.log("PassControl init");
    if (opts.global) {
      console.log("Saving a global profile. Only do this on a machine you trust.\n");
    } else {
      console.log("Saving a project-local .passcontrol file.\n");
    }

    const ask = async (label, fallback = "") => {
      const suffix = fallback ? ` [${fallback}]` : "";
      const answer = await rl.question(`${label}${suffix}: `);
      return answer.trim() || fallback;
    };

    const provider = await ask("Provider", config.provider || "anthropic");
    assertProvider(provider);
    const modelFallback = provider === config.provider ? config.model : defaultModelForProvider(provider);
    const values = {
      PASSCONTROL_GATEWAY: await ask("Gateway URL", config.gateway),
      PASSPORT_ID: await ask("Passport ID", config.passportId),
      PASSPORT_SECRET: await ask("Passport Secret (input is visible)", config.passportSecret),
      PASSCONTROL_API_KEY: await ask("Control API key (optional, input is visible)", config.apiKey),
      PROVIDER: provider,
      MODEL: await ask("Model", modelFallback),
    };

    writeConfigFile(target, values);
    ok(`saved ${target}`);
  } finally {
    rl.close();
  }
}

async function mintVisa(current = config) {
  const { passportId, passportSecret } = requirePassport(current);
  const payloadObj = { passport_id: passportId, ts: Date.now(), nonce: crypto.randomUUID() };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(payloadObj)));
  const signature = b64url(ed25519.sign(fromB64url(payload), fromB64url(passportSecret)));
  const res = await fetch(`${current.gateway}/api/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, signature }),
  });
  if (!res.ok) throw new Error(formatChallengeError(res.status, await res.text()));
  const data = await res.json();
  if (!data.visa) throw new Error("Challenge returned no visa.");
  return data;
}

function requestFor(provider, model, prompt) {
  if (provider === "anthropic") {
    return {
      path: "v1/messages",
      body: { model, max_tokens: 128, stream: true, messages: [{ role: "user", content: prompt }] },
    };
  }
  if (OPENAI_SHAPE_PROVIDERS.has(provider)) {
    return {
      path: "chat/completions",
      body: { model, stream: true, messages: [{ role: "user", content: prompt }] },
    };
  }
  throw new Error(`Provider ${provider} is not supported by the CLI call command yet.`);
}

function extractDelta(json) {
  return json?.delta?.text ?? json?.choices?.[0]?.delta?.content ?? "";
}

async function streamResponse(res) {
  if (!res.body) {
    console.log(await res.text());
    return;
  }

  process.stdout.write("\nresponse: ");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const m = line.match(/^data:\s*(.*)$/);
      if (!m || m[1] === "[DONE]") continue;
      try {
        process.stdout.write(extractDelta(JSON.parse(m[1])));
      } catch {
        // Keep-alives and provider-specific comments can safely be ignored.
      }
    }
  }
  console.log("");
}

async function callCommand(rest, opts) {
  const provider = String(opts.provider || config.provider);
  assertProvider(provider);
  const model = activeModel(provider, opts);
  const prompt = rest.join(" ") || process.env.PROMPT || "Say hello in exactly 3 words.";
  requirePassport(config);
  step(`${provider}/${model} via ${config.gateway}`);
  step(`prompt: ${prompt}\n`);

  const { visa, expires_in } = await mintVisa(config);
  ok(`minted visa (expires in ${expires_in ?? 300}s)`);

  const { path: proxyPath, body } = requestFor(provider, model, prompt);
  const res = await fetch(`${config.gateway}/api/v1/${provider}/${proxyPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${visa}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(formatProxyError(res.status, await res.text()));
  await streamResponse(res);
  ok("done - check the dashboard audit log + spend for this call.");
}

async function api(method, pathPart, body) {
  const apiKey = requireControlApiKey(config);
  const res = await fetch(`${config.gateway}/api/control/v1${pathPart}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(method !== "GET" ? { "idempotency-key": crypto.randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: { message: text || "non-JSON response" } };
  }
  if (!res.ok) {
    const e = json.error ?? {};
    throw new Error(`${res.status} ${e.code ?? ""} ${e.message ?? ""} (req ${e.request_id ?? "?"})`);
  }
  return json.data;
}

function controlPath(pathPart, params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") qs.set(key, String(value));
  }
  const suffix = qs.toString();
  return suffix ? `${pathPart}?${suffix}` : pathPart;
}

function usd(microcents) {
  return `$${(Number(microcents ?? 0) / 100_000_000).toFixed(6)}`;
}

function safeLimit(raw, fallback = 20) {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

async function agentCommand(rest, opts) {
  const [sub, ...args] = rest;
  switch (sub) {
    case "list": {
      const agents = await api("GET", "/agents");
      console.table(
        agents.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          tokens: a.spent_tokens,
          usd: a.spent_microcents === undefined ? undefined : usd(a.spent_microcents),
        }))
      );
      break;
    }
    case "create": {
      const name = args[0];
      if (!name) throw new Error("Usage: passcontrol agent create <name>");
      const provider = String(opts.provider || config.provider);
      assertProvider(provider);
      const scopeModel = String(opts.scope || (provider === "anthropic" ? "claude-*" : activeModel(provider, opts)));
      const priv = ed25519.utils.randomPrivateKey();
      const pub = ed25519.getPublicKey(priv);
      const passportId = b64url(pub);
      const created = await api("POST", "/agents", {
        name,
        passportPubkey: passportId,
        scopes: [{ provider, models: [scopeModel] }],
      });
      ok(`created agent ${created.id} (${created.name})`);
      step("Store these - the secret is shown once and is the agent's passport:");
      console.log(`  PASSPORT_ID=${passportId}`);
      console.log(`  PASSPORT_SECRET=${b64url(priv)}`);
      step("Paste them into .passcontrol, then run `passcontrol call \"hi\"`.");
      break;
    }
    case "suspend":
      if (!args[0]) throw new Error("Usage: passcontrol agent suspend <id>");
      console.log(await api("POST", `/agents/${encodeURIComponent(args[0])}/suspend`));
      break;
    case "resume":
      if (!args[0]) throw new Error("Usage: passcontrol agent resume <id>");
      console.log(await api("POST", `/agents/${encodeURIComponent(args[0])}/resume`));
      break;
    case "revoke":
      if (!args[0]) throw new Error("Usage: passcontrol agent revoke <id>");
      console.log(await api("DELETE", `/agents/${encodeURIComponent(args[0])}`));
      break;
    default:
      throw new Error("Usage: passcontrol agent list|create <name>|suspend <id>|resume <id>|revoke <id>");
  }
}

async function spendCommand() {
  const data = await api("GET", "/spend");
  console.log(`fleet: ${data.fleet.spent_tokens} tokens · ${usd(data.fleet.spent_microcents)}`);
  console.table(
    data.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      tokens: agent.spent_tokens,
      usd: usd(agent.spent_microcents),
    }))
  );
}

async function auditCommand(opts) {
  const events = await api("GET", controlPath("/audit", { limit: safeLimit(opts.limit) }));
  console.table(
    events.map((event) => ({
      at: event.created_at,
      action: event.action,
      target: event.target_id,
      request: event.request_id,
    }))
  );
}

async function logsCommand(opts) {
  const rows = await api(
    "GET",
    controlPath("/logs", {
      limit: safeLimit(opts.limit),
      agent_id: opts.agentId,
      status: opts.status,
    })
  );
  console.table(
    rows.map((row) => ({
      at: row.created_at,
      agent: row.agent_id,
      provider: row.provider,
      model: row.model,
      status: row.status,
      in: row.input_tokens,
      out: row.output_tokens,
      total: row.total_tokens,
      usd: usd(row.cost_microcents),
    }))
  );
}

async function killCommand(rest) {
  const mode = rest[0];
  if (mode !== "on" && mode !== "off") throw new Error("Usage: passcontrol kill on|off");
  const data = await api("PUT", "/kill-switch", { armed: mode === "on" });
  ok(`kill switch ${data.armed ? "armed" : "disarmed"} (${data.affected ?? 0} affected)`);
}

async function sidecarCommand(rest, opts) {
  if (rest[0] === "status") {
    step("The sidecar runs as a foreground process.");
    step("If it is running, your agent should point at http://127.0.0.1:8788/api/v1/anthropic or /api/v1/openai.");
    return;
  }

  const { passportId, passportSecret } = requirePassport(config);
  startSidecar({
    gateway: config.gateway,
    passportId,
    passportSecret,
    port: Number(opts.port ?? process.env.SIDECAR_PORT ?? 8788),
    host: String(opts.host ?? process.env.SIDECAR_HOST ?? "127.0.0.1"),
    refreshSkewSeconds: Number(opts.refreshSkewSeconds ?? process.env.REFRESH_SKEW_SECONDS ?? 30),
  });

  if (opts.for) {
    console.log("");
    printAgentPreset(String(opts.for), opts);
  }
}

function sidecarBaseUrl(opts = {}) {
  const provider = String(opts.provider || config.provider);
  assertProvider(provider);
  const host = String(opts.host ?? process.env.SIDECAR_HOST ?? "127.0.0.1");
  const port = Number(opts.port ?? process.env.SIDECAR_PORT ?? 8788);
  return {
    provider,
    model: activeModel(provider, opts),
    apiKey: "passcontrol",
    baseUrl: `http://${host}:${port}/api/v1/${provider}`,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function printExports(values) {
  for (const [key, value] of values) {
    console.log(`export ${key}=${shellQuote(value)}`);
  }
}

function printAgentPreset(name = "generic", opts = {}) {
  const preset = name.toLowerCase();
  const { provider, model, apiKey, baseUrl } = sidecarBaseUrl(opts);
  const modelWithProvider = `${provider}/${model}`;
  const sidecarStart = opts.port ? cliCommand(`sidecar --port ${opts.port}`) : cliCommand("sidecar");

  console.log(`# Start the bridge first: ${sidecarStart}`);
  switch (preset) {
    case "openhands":
      console.log("# OpenHands / LiteLLM-compatible starting point:");
      printExports([
        ["LLM_BASE_URL", baseUrl],
        ["LLM_API_KEY", apiKey],
        ["LLM_MODEL", modelWithProvider],
      ]);
      break;
    case "litellm":
      console.log("# LiteLLM-compatible starting point:");
      printExports([
        ["LITELLM_BASE_URL", baseUrl],
        ["LITELLM_API_KEY", apiKey],
        ["LITELLM_MODEL", modelWithProvider],
      ]);
      break;
    case "aider":
      console.log("# Aider OpenAI-compatible starting point:");
      printExports([
        ["OPENAI_API_BASE", baseUrl],
        ["OPENAI_API_KEY", apiKey],
        ["AIDER_MODEL", modelWithProvider],
      ]);
      break;
    case "cline":
    case "continue":
      console.log(`# ${preset} UI settings:`);
      console.log(`Base URL: ${baseUrl}`);
      console.log(`API key:  ${apiKey}`);
      console.log(`Model:    ${modelWithProvider}`);
      break;
    case "generic":
      console.log("# Generic sidecar settings:");
      printExports([
        ["PASSCONTROL_SIDECAR_BASE_URL", baseUrl],
        ["PASSCONTROL_SIDECAR_API_KEY", apiKey],
        ["PASSCONTROL_MODEL", modelWithProvider],
      ]);
      break;
    default:
      throw new Error("Usage: passcontrol env [generic|openhands|litellm|aider|cline|continue]");
  }
}

function aiderConfig(opts = {}) {
  const { provider, model, baseUrl } = sidecarBaseUrl(opts);
  return [
    "# Generated by PassControl. This file contains no provider API key.",
    "# Start `passcontrol sidecar` before running Aider.",
    `model: ${provider}/${model}`,
    `openai-api-base: ${baseUrl}`,
    "openai-api-key: passcontrol",
    "",
  ].join("\n");
}

async function configureCommand(rest, opts = {}) {
  const integration = String(rest[0] ?? "").toLowerCase();
  if (!integration) throw new Error("Usage: passcontrol configure <aider|cline|continue|openhands> [--write]");
  if (integration !== "aider") {
    if (opts.write) throw new Error(`${integration} configuration is UI- or project-schema-specific; no file was written. Use the preview below.`);
    printAgentPreset(integration, opts);
    step("This integration is configured manually from the settings shown above. Aider is the current file-writing integration.");
    return;
  }

  const target = path.join(process.cwd(), ".aider.conf.yml");
  const content = aiderConfig(opts);
  console.log(`Preview: .aider.conf.yml\n\n${content}`);
  if (!opts.write) {
    step("Dry run only. Re-run with `--write` to create this file.");
    return;
  }
  if (fs.existsSync(target)) throw new Error(`${target} already exists; refusing to overwrite it.`);
  fs.writeFileSync(target, content, { mode: 0o600 });
  ok(`wrote ${target}`);
}

async function doctorCommand(opts = {}) {
  const gateway = await gatewayStatus(false);
  console.log("PassControl doctor\n");
  (gateway.ok ? ok : fail)(`Gateway ${gateway.label}: ${config.gateway}`);
  (config.passportId && config.passportSecret ? ok : fail)(
    `Passport ${config.passportId && config.passportSecret ? "configured" : "missing"}`
  );
  (config.apiKey ? ok : step)(`Control API key ${config.apiKey ? "configured" : "missing (needed only for agent/kill commands)"}`);
  step(`Config source: ${configPathLabel(config.sources)}`);

  if (opts.fix) {
    console.log("");
    let dashboard;
    try {
      dashboard = localDashboard();
    } catch {
      step("--fix manages only a local dashboard; remote gateways are not changed.");
    }
    if (dashboard) {
      const root = resolveAppRoot();
      if (gateway.ok) {
        ok("Local dashboard is already healthy; no repair needed.");
      } else if (!root) {
        fail(`No PassControl app checkout found. Run \`${cliCommand("setup")}\` to clone and start the local stack.`);
      } else if (!fs.existsSync(path.join(root, ".env.docker"))) {
        fail(`Local stack is not configured. Run \`${cliCommand("setup")}\` in ${root}.`);
      } else {
        appRoot = root;
        await startDashboard();
      }
    }
  }

  if (!opts.deep) return;

  console.log("");
  step("Deep checks");
  if (config.passportId && config.passportSecret) {
    try {
      const visa = await mintVisa(config);
      ok(`Visa mint works (expires in ${visa.expires_in ?? 300}s)`);
    } catch (error) {
      fail(`Visa mint failed: ${error.message}`);
    }
  } else {
    step("Skipping visa mint check: no passport configured.");
  }

  if (config.apiKey) {
    try {
      const kill = await api("GET", "/kill-switch");
      ok(`Control API works (kill switch ${kill.armed ? "armed" : "off"})`);
    } catch (error) {
      fail(`Control API check failed: ${error.message}`);
    }
  } else {
    step("Skipping control API check: no PASSCONTROL_API_KEY configured.");
  }
}

async function openDashboard(opts = {}) {
  let parsed;
  try {
    parsed = new URL(config.gateway);
  } catch {
    throw new Error(`Invalid PASSCONTROL_GATEWAY URL: ${config.gateway}`);
  }
  const url = parsed.protocol === "http:" && LOCAL_DASHBOARD_HOSTS.has(parsed.hostname)
    ? (await startDashboard(opts)).url
    : config.gateway;
  const platform = process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", () => step(`Open this URL: ${url}`));
  child.unref();
  ok(`opening ${url}`);
}

async function main() {
  const { opts, rest } = parseArgv(process.argv.slice(2));
  const [command, ...commandRest] = rest;

  if (opts.help || command === "help") {
    console.log(usage());
    return;
  }
  if (opts.version || command === "version") {
    console.log("passcontrol 0.1.0");
    return;
  }

  switch (command) {
    case undefined:
    case "status":
      await printCockpit({ noNetwork: Boolean(opts.noNetwork) });
      break;
    case "init":
      await initCommand(opts);
      break;
    case "doctor":
      await doctorCommand(opts);
      break;
    case "start":
      await startDashboard(opts);
      break;
    case "stop":
      await stopDashboard();
      break;
    case "restart":
      await restartDashboard(opts);
      break;
    case "local-logs":
      await localLogsCommand(opts);
      break;
    case "reset":
      await resetLocalStack(opts);
      break;
    case "setup":
      await setupLocal(opts);
      break;
    case "call":
      await callCommand(commandRest, opts);
      break;
    case "sidecar":
      await sidecarCommand(commandRest, opts);
      break;
    case "env":
      printAgentPreset(commandRest[0] || "generic", opts);
      break;
    case "configure":
      await configureCommand(commandRest, opts);
      break;
    case "agent":
    case "fleet":
      await agentCommand(commandRest, opts);
      break;
    case "spend":
      await spendCommand();
      break;
    case "audit":
      await auditCommand(opts);
      break;
    case "logs":
      await logsCommand(opts);
      break;
    case "kill":
      await killCommand(commandRest);
      break;
    case "open":
      await openDashboard(opts);
      break;
    default:
      throw new Error(`Unknown command "${command}". Run \`passcontrol help\`.`);
  }
}

main().catch((error) => {
  fail(error.message);
  process.exit(1);
});
