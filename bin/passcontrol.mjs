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
  WORKSPACE_IMPORT_MAX_VERSION,
  assertConfigLoaded,
  config,
  configPathLabel,
  defaultModelForProvider,
  fail,
  formatLabel,
  formatChallengeError,
  formatProxyError,
  globalConfigPath,
  heading,
  ok,
  redact,
  requireControlApiKey,
  requireControlGateway,
  operatorEnv,
  probeGatewayOrigin,
  requirePassportGateway,
  requirePassport,
  step,
  warn,
  writeConfigFile,
} from "../cli/config.mjs";
import {
  CLAUDE_CODE_ADD_COMMAND,
  isMcpIntegration,
  mcpClientConfigPath,
  mcpServerEntry,
  mcpServersDocument,
  writeMcpClientConfig,
} from "../cli/mcp/integration.mjs";
import {
  GUI_PRESET_LABELS,
  integrationChoices,
  isGuiPreset,
  isIntegration,
  supportsWrite,
} from "../cli/presets.mjs";
import { importCompletionMessage, noAgentCreateMessage } from "../cli/workspace-import-report.mjs";
import { checkForUpdate } from "../cli/update-check.mjs";
import { startSidecar } from "../cli/sidecar.mjs";
import {
  checkIssuerPublishesKey,
  generateInstanceKey,
  instanceKidFromSeed,
} from "../cli/instance-key.mjs";
import { FAILURE_REASONS, verifyAgentToken, verifyReceipt } from "../cli/verify.mjs";
import { compareProtocolSets } from "../cli/protocols.mjs";

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
const CLI_ENTRY = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(CLI_ENTRY), "..");
const CLI_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// Fixed demo credentials for `passcontrol try` — LOCAL demo stack ONLY. The demo
// passport can only ever reach the keyless `demo` provider (no real key, no cost,
// no real upstream); the demo provider + these seeds exist only when the stack is
// brought up with PASSCONTROL_DEMO=1. Hardcoding them is safe, like the seeded dev
// password — they grant nothing in a real deployment.
// App-side source of truth: lib/demo/identity.ts (duplicated here to keep the shipped plain-ESM CLI transpilation-free).
const DEMO_PASSPORT_ID = "kZCFp7d2x4VDruiulJ21gogYbczBDAGZa-OuwR3qgh8";
const DEMO_PASSPORT_SECRET = "XqsVuXtmWiu6bKEmmqov2Q2TwkOVdzlZMWR-NWubSKo";
const DEMO_API_KEY = "pc_demolocaltrydemolocaltrydemolocaltry0000";
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
  return `${heading(`PassControl ${CLI_VERSION}`)}
Governed identity and credentials for AI agents.

${heading("Usage:")}
  ${cmd}                         show cockpit status
  ${cmd} <command> [options]

${heading("Quick start")}
  ${cmd} init [--global]          configure this project
  ${cmd} start [--dashboard-only] start the whole local stack (dashboard + Supabase + Redis)
  ${cmd} open                     start if needed and open the Control Tower
  ${cmd} try                      run the 60-second keyless guided demo

${heading("Operate")}
  ${cmd} status [--no-network] [--json]
                                 show active config and instance state
  ${cmd} version [--json]         CLI, gateway and database schema versions
  ${cmd} doctor [--deep] [--fix]  diagnose setup and repair a stopped dashboard
  ${cmd} call "hi"                mint a visa and make a governed model call
  ${cmd} sidecar [--port 8788] [--allow-connect host[,host]]
                                 start the local agent bridge

${heading("Manage")}
  ${cmd} agent list [--json]      list agents
  ${cmd} agent create <name>      create an agent passport
  ${cmd} agent rotate <id> [--grace <seconds>]
                                 rotate locally and reveal the new secret once
  ${cmd} agent suspend <id>       suspend an agent
  ${cmd} agent resume <id>        resume an agent
  ${cmd} agent revoke <id>        permanently revoke an agent
  ${cmd} spend [--json]           show fleet and per-agent spend
  ${cmd} audit [--limit 20] [--json]
                                 show operator audit history
  ${cmd} logs [--limit 20] [--json]
                                 show governed call logs
  ${cmd} kill on|off              toggle the tenant kill switch
  ${cmd} export [--out FILE]      save a workspace configuration snapshot
  ${cmd} import <file> [--confirm IMPORT]
                                 restore agents from a snapshot (never overwrites)

${heading("Integrate")}
  ${cmd} env [integration]        print settings without writing anything
  ${cmd} configure <integration> [--write] [--force]
                                 preview or write integration config
  ${cmd} mcp                      start the stdio MCP server
  integrations: ${integrationChoices()}

${heading("Trust")}
  ${cmd} keygen instance          create the receipt-signing key
  ${cmd} verify receipt <jws> --issuer <origin>
                                 verify a signed call receipt
  ${cmd} verify token <jwt> --audience <aud> --issuer <origin>
                                 verify an agent-to-agent token

${heading("Local stack")}
  ${cmd} setup [--no-open] [--port-offset N] [--app-dir DIR]
                                 clone if needed, start services, open dashboard
  ${cmd} stop [--dashboard-only]  stop the whole local stack (dashboard + Supabase + Redis)
  ${cmd} restart                  restart the CLI-managed local dashboard
  ${cmd} local-logs [--follow]    show local dashboard logs
  ${cmd} reset --local --confirm RESET
                                 destroy and recreate the local stack
  ${cmd} unlink                   forget the remembered app checkout

${heading("Config:")}
  Env vars win, then nearest .passcontrol, then ~/.config/passcontrol/config.
  Installed globally, the local-stack commands (setup/start/reset) use a cloned
  app checkout, resolved in this order:
    --app-dir DIR → PASSCONTROL_APP_ROOT → surrounding checkout → remembered
    checkout in ~/.config/passcontrol/app.json (survives npm uninstall; clear
    it with \`${cmd} unlink\`).
`;
}

function agentUsage() {
  const cmd = cliPrefix();
  return `${heading("Manage agent passports")}

${heading("Usage:")}
  ${cmd} agent list
  ${cmd} agent create <name> [--provider <provider>] [--scope <model-pattern>]
  ${cmd} agent rotate <id> [--grace <seconds>]
  ${cmd} agent suspend <id>
  ${cmd} agent resume <id>
  ${cmd} agent revoke <id>

${heading("Examples")}
  ${cmd} agent create prod-summarizer --provider anthropic --scope 'claude-*'
  ${cmd} agent rotate <id> --grace 3600
  ${cmd} agent suspend <id>

Create and rotate generate the Ed25519 private key on this machine. Only the
public key crosses the control API. The private key is shown once; store it
before leaving the command. During rotation grace, both old and new keys work.
Revocation is permanent; suspension is reversible.
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

async function printCockpit({ noNetwork = false, json = false } = {}) {
  const gateway = await gatewayStatus(noNetwork);
  const passportConfigured = Boolean(config.passportId && config.passportSecret);
  const adminConfigured = Boolean(config.apiKey);
  const dashboard = dashboardStatusLabel(gateway, noNetwork);
  const app = appRootLabel();
  const configFile = configPathLabel(config.sources);
  // This is deliberately credential-gated. Status remains useful to an agent
  // install with no Control key, but it must never probe a tenant endpoint
  // anonymously or make that normal setup state look like a failure.
  const systemHealth = noNetwork ? { state: "not-checked" } : await fetchSystemHealth();

  if (json) {
    console.log(JSON.stringify({
      version: CLI_VERSION,
      gateway: { url: config.gateway, state: gateway.label, healthy: gateway.ok },
      dashboard: { state: dashboard },
      app: { state: app },
      config: {
        source: configFile,
        provider: config.provider,
        model: config.model,
        passport_configured: passportConfigured,
        control_api_key_configured: adminConfigured,
      },
      system_health: systemHealthForJson(systemHealth),
    }, null, 2));
    return;
  }

  console.log(`${heading("PassControl")}\n`);
  console.log(formatLabel("Gateway", `${gateway.label}  ${config.gateway}`));
  console.log(formatLabel("Dashboard", dashboard));
  console.log(formatLabel("App", app));
  console.log(formatLabel("Config", configFile));
  console.log(formatLabel("Provider", config.provider));
  console.log(formatLabel("Model", config.model));
  console.log(formatLabel("Passport", passportConfigured ? redact(config.passportId) : "missing"));
  console.log(formatLabel("Admin key", adminConfigured ? redact(config.apiKey, 6) : "missing"));
  console.log(formatLabel("System health", systemHealthLabel(systemHealth)));
  console.log(`${formatLabel("Sidecar", `foreground command (\`${cliCommand("sidecar")}\`)`)}\n`);
  const next = [];
  if (config.sources.length === 0) {
    next.push(["init", "configure this project"]);
  }
  if (gateway.ok === false) {
    next.push(["start", "start the local control plane"]);
    next.push(["doctor", "diagnose why the gateway is unavailable"]);
  } else if (!passportConfigured) {
    next.push(["agent create <name>", "issue a governed agent passport"]);
    next.push(["open", "finish setup in the Control Tower"]);
  } else {
    next.push(['call "hi"', "test a governed model call"]);
    next.push(["agent list", "inspect the configured fleet"]);
    next.push(["open", "open the Control Tower"]);
  }

  console.log(heading("Next:"));
  for (const [command, description] of next.slice(0, 3)) {
    console.log(`  ${cliCommand(command).padEnd(34)} ${description}`);
  }
}

function safeHealthText(value, fallback = "unavailable") {
  if (typeof value !== "string") return fallback;
  // Keep a compromised/misconfigured server from writing terminal control
  // sequences or an unbounded line into an operator's terminal.
  const clean = value.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 240);
  return clean || fallback;
}

async function fetchSystemHealth() {
  if (!config.apiKey) return { state: "skipped" };
  try {
    const health = await api("GET", "/system");
    if (!health || typeof health !== "object") return { state: "unavailable", reason: "invalid response" };
    return { state: "available", health };
  } catch (error) {
    const message = error instanceof Error ? error.message : "request failed";
    return { state: message.startsWith("403 ") ? "restricted" : "unavailable", reason: message };
  }
}

function healthCompatibility(health) {
  return compareProtocolSets(health && typeof health === "object" ? health.protocols : undefined);
}

function shortBuildCommit(value) {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)
    ? value.slice(0, 12).toLowerCase()
    : "unknown";
}

function systemBuildSummary(health) {
  const build = health?.build && typeof health.build === "object" ? health.build : {};
  const migrations = health?.migrations && typeof health.migrations === "object" ? health.migrations : {};
  return {
    version: safeHealthText(build.version, "unknown"),
    channel: safeHealthText(build.channel, "unknown"),
    commit: shortBuildCommit(build.commit),
    migrationState: safeHealthText(migrations.state, "unknown"),
    migrationHead: safeHealthText(migrations.expected_head, "unknown"),
    appliedMigrationHead: migrations.applied_head == null
      ? "not recorded"
      : safeHealthText(migrations.applied_head, "unknown"),
  };
}

function systemHealthLabel(result) {
  if (result.state === "skipped") return "skipped (operator read key required)";
  if (result.state === "not-checked") return "not checked (--no-network)";
  if (result.state === "restricted") return "restricted (control key cannot read system health)";
  if (result.state !== "available") return `unavailable (${safeHealthText(result.reason)})`;
  const build = systemBuildSummary(result.health);
  const observed = safeHealthText(result.health.generated_at, "unknown");
  return `${safeHealthText(result.health.overall, "reported")} · observed ${observed} · v${build.version} ${build.channel} ${build.commit} · migrations ${build.migrationState} (${build.appliedMigrationHead} → ${build.migrationHead}) · protocols ${healthCompatibility(result.health).state}`;
}

function systemHealthForJson(result) {
  if (result.state !== "available") return { state: result.state };
  return {
    state: "available",
    overall: safeHealthText(result.health.overall, "reported"),
    observed_at: safeHealthText(result.health.generated_at, "unknown"),
    protocol_compatibility: healthCompatibility(result.health).state,
    build: systemBuildSummary(result.health),
  };
}

function printSystemHealthDiagnostic(result) {
  if (result.state === "skipped") {
    step("System health skipped: an operator read key is required.");
    return;
  }
  if (result.state === "restricted") {
    fail("System health diagnostic restricted (403): this key's owner is not an allowlisted MFA-enrolled system operator.");
    return;
  }
  if (result.state !== "available") {
    fail(`System health diagnostic failed: ${safeHealthText(result.reason)}`);
    return;
  }
  const compatibility = healthCompatibility(result.health);
  const build = systemBuildSummary(result.health);
  const observed = safeHealthText(result.health.generated_at, "unknown");
  ok(`System health ${safeHealthText(result.health.overall, "reported")} · observed ${observed} · v${build.version} ${build.channel} ${build.commit} · migrations ${build.migrationState} (${build.appliedMigrationHead} → ${build.migrationHead}) · protocol compatibility ${compatibility.state}`);
  for (const check of Array.isArray(result.health.checks) ? result.health.checks : []) {
    if (!check || typeof check !== "object") continue;
    const label = safeHealthText(check.label, "System check");
    const state = safeHealthText(check.state, "unknown");
    const summary = safeHealthText(check.summary, "No summary provided.");
    console.log(`  ${label}: ${state} — ${summary}`);
    if (typeof check.action === "string" && check.action.trim()) step(`Remediation: ${safeHealthText(check.action)}`);
  }
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

function forgetAppRoot() {
  const saved = readSavedAppRoot();
  fs.rmSync(appRootStatePath(), { force: true });
  return saved;
}

// Precedence: explicit env override → the surrounding checkout (npm run cli --) →
// a previously cloned/saved checkout. (An explicit --app-dir outranks all three;
// ensureAppRoot applies it before consulting this.) Returns null when the CLI is
// installed globally and no stack has been set up yet. `source` exists so status
// can say where the path came from — a saved root that outlives the checkout it
// points at is invisible otherwise, which reads as the CLI ignoring the user.
function resolveAppRootSource() {
  const envRoot = process.env.PASSCONTROL_APP_ROOT?.trim();
  if (envRoot) {
    const abs = path.resolve(envRoot);
    if (!isRepoCheckout(abs)) {
      throw new Error(`PASSCONTROL_APP_ROOT=${envRoot} is not a PassControl checkout (missing scripts/dev-stack.sh).`);
    }
    return { path: abs, source: "PASSCONTROL_APP_ROOT" };
  }
  if (process.env.PASSCONTROL_FORCE_INSTALLED !== "1" && isRepoCheckout(PACKAGE_ROOT)) {
    return { path: PACKAGE_ROOT, source: "surrounding checkout" };
  }
  const saved = readSavedAppRoot();
  if (saved && isRepoCheckout(saved)) {
    return { path: path.resolve(saved), source: `saved — \`${cliCommand("unlink")}\` to clear` };
  }
  return null;
}

function resolveAppRoot() {
  return resolveAppRootSource()?.path ?? null;
}

function defaultAppDir() {
  return path.join(os.homedir(), "passcontrol");
}

function appRootLabel() {
  try {
    const resolved = resolveAppRootSource();
    if (!resolved) return `not set up (run \`${cliCommand("setup")}\`)`;
    return `${resolved.path}  (${resolved.source})`;
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

function checkDockerInstalled() {
  return commandExists("docker")
    ? { ok: true, message: "Docker CLI: installed." }
    : {
        ok: false,
        message: "Docker CLI: not installed. Fix: install Docker Desktop from https://docs.docker.com/desktop/.",
      };
}

function checkDockerDaemon() {
  if (!commandExists("docker")) {
    return {
      ok: false,
      message: "Docker daemon: unavailable. Fix: install Docker Desktop, start it, and wait for the engine to become ready.",
    };
  }
  try {
    // Docker Desktop can leave its CLI socket present while the engine is
    // wedged. A diagnostic command must report that state, not hang every
    // onboarding/release check indefinitely — hence a bound.
    //
    // The bound is generous because the failure it must not cause is worse than
    // the one it prevents. At 2s this reported "not running" about a daemon that
    // was merely COLD: it failed the public repo's local-smoke CI job on a runner
    // where Docker was available throughout, and it would tell a first-time user
    // on a slow laptop to go start something already running. A wedged engine
    // still gets caught; it just takes fifteen seconds to say so.
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
    return { ok: true, message: "Docker daemon: running." };
  } catch (error) {
    // A timeout and a stopped daemon need different things from the reader, so
    // they must not share a sentence. `execFileSync` surfaces the timeout kill as
    // ETIMEDOUT, or as the signal it used when the platform reports no code.
    const timedOut = error?.code === "ETIMEDOUT" || error?.signal === "SIGTERM";
    return {
      ok: false,
      message: timedOut
        ? "Docker daemon: did not respond within 15s. The engine may still be starting — wait and re-run. If it persists, Docker is wedged: restart Docker Desktop."
        : "Docker daemon: not running. Fix: start Docker Desktop and wait for the engine to become ready.",
    };
  }
}

function checkSupabaseInstalled() {
  return commandExists("supabase")
    ? { ok: true, message: "Supabase CLI: installed." }
    : {
        ok: false,
        message: "Supabase CLI: not installed. Fix: install it from https://supabase.com/docs/guides/local-development/cli/getting-started.",
      };
}

function checkNodeVersion() {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  return major >= 18
    ? { ok: true, message: `Node.js: v${version} (supported).` }
    : {
        ok: false,
        message: `Node.js: v${version} is unsupported. Fix: install Node.js 18 or newer from https://nodejs.org/.`,
      };
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
  // An explicit --app-dir is the strongest signal there is and must outrank a
  // saved checkout. It used to lose: resolveAppRoot() ran first, so a stale
  // ~/.config/passcontrol/app.json (which survives `npm uninstall -g`) meant
  // `setup --app-dir NEW` silently kept using the old directory, with no error
  // and no way to repoint short of deleting an undocumented state file.
  // parseArgv yields `true` for a valueless --app-dir; path.resolve(true) would
  // throw a raw TypeError that reads as a crash rather than a usage mistake.
  if (appDir !== undefined && typeof appDir !== "string") {
    throw new Error(`--app-dir needs a directory path, e.g. \`${cliCommand("setup --app-dir ~/passcontrol")}\`.`);
  }
  const explicit = appDir ? path.resolve(appDir) : null;
  if (explicit && isRepoCheckout(explicit)) {
    saveAppRoot(explicit);
    appRoot = explicit;
    return appRoot;
  }
  if (appRoot) return appRoot;
  if (!explicit) {
    const resolved = resolveAppRoot();
    if (resolved) {
      appRoot = resolved;
      return appRoot;
    }
  }
  if (!clone) {
    throw new Error(
      explicit
        ? `--app-dir ${appDir} is not a PassControl checkout (missing scripts/dev-stack.sh).`
        : `No PassControl app checkout found. Run \`${cliCommand("setup")}\` to clone and start it, or set PASSCONTROL_APP_ROOT to an existing checkout.`
    );
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive && !yes) {
    throw new Error(
      `No PassControl app checkout found. Re-run \`${cliCommand("setup")}\` in an interactive terminal, or pass --yes (with optional --app-dir <path>) to clone ${PUBLIC_REPO_URL} non-interactively.`
    );
  }

  const target =
    explicit ??
    path.resolve(interactive ? await promptLine(`Where should the PassControl app be cloned? [${defaultAppDir()}] `, defaultAppDir()) : defaultAppDir());
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

// The Supabase project id setup baked into supabase/config.toml. Read it back
// rather than re-deriving it from the directory name and a --port-offset: the
// offset is a setup-time flag nobody passes again on `start`, and config.toml is
// what the Supabase CLI itself will use.
function localSupabaseProjectId() {
  const configPath = path.join(appRoot, "supabase", "config.toml");
  const configText = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";
  return configText.match(/^project_id\s*=\s*"([^"]+)"\s*$/m)?.[1] ?? path.basename(appRoot);
}

function localComposeProjectName() {
  return `passcontrol_${localSupabaseProjectId().replace(/[^A-Za-z0-9]/g, "_").toLowerCase()}`;
}

// Same container filter scripts/dev-stack.sh uses to find the DB to migrate.
function localSupabaseIsRunning() {
  try {
    return Boolean(
      execFileSync(
        "docker",
        ["ps", "-q", "--filter", `label=com.supabase.cli.project=${localSupabaseProjectId()}`, "--filter", "name=supabase_db"],
        { encoding: "utf8" }
      ).trim()
    );
  } catch {
    return false;
  }
}

// The port the dashboard will actually reach Redis on, read from the env file
// rather than assumed. `setup --port-offset N` moves SRH, and bringing compose
// up on the compose default while the app reads the offset port gives you a
// Redis that is up and unreachable — every nonce, budget reservation and
// kill-switch read failing against a container that looks healthy in `docker ps`.
function localRedisPort() {
  const compose = fs.readFileSync(path.join(appRoot, "docker", "compose.yml"), "utf8");
  const fallback = Number(compose.match(/PASSCONTROL_SRH_PORT:-(\d+)/)?.[1] ?? 8079);
  try {
    const envText = fs.readFileSync(path.join(appRoot, ".env.docker"), "utf8");
    const port = Number(new URL(envText.match(/^UPSTASH_REDIS_REST_URL=(.*)$/m)?.[1]?.trim()).port);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {
    // An unreadable or malformed env file is reported by the caller's own
    // configuration check; fall back rather than failing here.
  }
  return fallback;
}

// The other half of `passcontrol start`. `stop` takes the dashboard, Supabase and
// Redis down together; a start that raised only the dashboard left that pair
// asymmetric, and the result is worse than a plain failure — the Control Tower
// comes back up and every page on it errors, because the Postgres it reads and
// the Redis holding the kill switch are both still stopped. Nothing on screen
// names the cause.
//
// Deliberately NOT `npm run dev:stack`. That script also rewrites .env.docker,
// applies every migration and seeds a dev user: first-run work that belongs to
// `setup`, and that would turn a routine restart into a schema event. `start`
// raises exactly what `stop` lowered, and nothing else.
async function startLocalServices() {
  for (const check of [checkDockerInstalled(), checkDockerDaemon(), checkSupabaseInstalled()]) {
    if (!check.ok) throw new Error(check.message);
  }

  if (localSupabaseIsRunning()) {
    ok("Supabase already running");
  } else {
    step("Starting Supabase (Postgres, Vault, Auth)…");
    // -x studio mirrors scripts/dev-stack.sh: Studio's image is flaky enough
    // here to fail its health check and roll the whole stack back, and nothing
    // depends on it — PassControl ships its own dashboard.
    await runLocalCommand("supabase", ["start", "-x", "studio"]);
    ok("Supabase running");
  }

  const redisPort = localRedisPort();
  if (await portIsListening(redisPort)) {
    ok(`Redis already running on port ${redisPort}`);
  } else {
    step("Starting Redis…");
    await runLocalCommand("docker", ["compose", "-f", "docker/compose.yml", "up", "-d"], {
      ...process.env,
      COMPOSE_PROJECT_NAME: localComposeProjectName(),
      PASSCONTROL_SRH_PORT: String(redisPort),
    });
    ok(`Redis running on port ${redisPort}`);
  }
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
  try {
    const root = appRoot ?? resolveAppRoot();
    if (!root) return false;
    const project = `${path.basename(root)}${offset ? `-${offset}` : ""}`;
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

async function checkLocalStackPorts(offset = 0) {
  try {
    await assertLocalStackPortsAvailable(offset);
    return { ok: true, message: "Local stack ports: available." };
  } catch (error) {
    return {
      ok: false,
      message: `Local stack ports: unavailable. Fix: stop the conflicting project or rerun setup with --port-offset N. Details: ${error.message}`,
    };
  }
}

async function runLocalPrerequisiteChecks({ offset = 0, report = false, enforce = false } = {}) {
  const results = [
    checkDockerInstalled(),
    checkDockerDaemon(),
    checkSupabaseInstalled(),
    checkNodeVersion(),
    await checkLocalStackPorts(offset),
  ];

  if (report) {
    step("Local prerequisites");
    for (const result of results) (result.ok ? ok : fail)(result.message);
  }

  if (enforce) {
    const failure = results.find((result) => !result.ok);
    if (failure) throw new Error(failure.message);
  }
  return results;
}

// `passcontrol start` — one command for "start PassControl", the mirror of what
// `stop` already does. The configuration check and the services come BEFORE the
// gateway health check on purpose: "the dashboard is answering" is not the same
// claim as "PassControl is up", and returning early on it is how you end up with
// a Control Tower talking to a stopped database.
async function startDashboard(opts = {}) {
  await ensureAppRoot({ clone: true, appDir: opts.appDir, yes: opts.yes });
  const dashboard = localDashboard();

  const envFile = path.join(appRoot, ".env.docker");
  if (!fs.existsSync(envFile)) {
    throw new Error(`Local stack is not configured. Run \`${cliCommand("setup")}\` in ${appRoot} first.`);
  }

  if (opts.dashboardOnly) step("Leaving Supabase and Redis alone (--dashboard-only).");
  else await startLocalServices();

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

// `passcontrol stop` — one command for "stop PassControl". Previously this halted
// only the CLI-managed dashboard, so a developer still had to remember
// `supabase stop` and a `docker compose` invocation in the right directory to
// actually free the ports and the RAM.
//
// Deliberately NON-DESTRUCTIVE: it stops containers but never removes volumes, so
// the Vault, passports, and audit log survive. Wiping local data stays with
// `passcontrol reset --local --confirm RESET`, which asks before it deletes.
async function stopCommand(opts = {}) {
  await stopDashboard();

  if (opts.dashboardOnly) {
    step("Left Supabase and Redis running (--dashboard-only).");
    return;
  }

  let root;
  try {
    root = resolveAppRoot();
  } catch (error) {
    // A bad PASSCONTROL_APP_ROOT shouldn't turn "stop" into a failure — the
    // dashboard is already down, which is most of what was asked for.
    step(error.message);
    return;
  }
  if (!root) {
    step(`No local stack checkout found — nothing else to stop (\`${cliCommand("setup")}\` creates one).`);
    return;
  }
  // Helpers below (localComposeProjectName) read the module-level appRoot, which
  // is only populated by ensureAppRoot() on the setup path. Stop never clones, so
  // publish the resolved checkout here.
  appRoot = root;

  // Each service is stopped independently and tolerantly: a stack that is already
  // down, or half down, must still end with everything down and exit 0.
  await stopLocalService("Supabase", "supabase", ["stop"], root);
  await stopLocalService(
    "Redis",
    "docker",
    ["compose", "-f", "docker/compose.yml", "down"],
    root,
    { ...process.env, COMPOSE_PROJECT_NAME: localComposeProjectName() }
  );

  ok("PassControl stopped. Local data kept — `passcontrol reset --local` wipes it.");
}

/** Stop one local service, reporting rather than throwing when it is already down. */
async function stopLocalService(label, command, args, cwd, env = process.env) {
  if (!commandExists(command)) {
    step(`${label}: \`${command}\` not found — skipping.`);
    return;
  }
  try {
    await runCommand(command, args, { cwd, env });
    ok(`${label} stopped`);
  } catch {
    step(`${label}: already stopped (or not running).`);
  }
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

// The saved app root lives outside the npm package, so `npm uninstall -g` leaves
// it behind and a reinstall silently keeps pointing at the old checkout. `unlink`
// is the supported way to forget it — without this, deleting an undocumented
// state file by hand is the only reset.
function unlinkCommand() {
  const statePath = appRootStatePath();
  // Branch on the file, not on readSavedAppRoot(): that returns null for corrupt
  // JSON exactly as it does for a missing file, so keying off it would report
  // "does not exist" about a file that does — and leave the blockage in place.
  if (!fs.existsSync(statePath)) {
    ok(`No saved app checkout to forget (${statePath} does not exist).`);
    return;
  }
  const saved = readSavedAppRoot();

  // Forgetting the path while the stack is up strands it: `stop` resolves the
  // checkout to bring Supabase and Redis down, and can't once the path is gone.
  const running = runningManagedDashboard();
  if (running) {
    warn(`A CLI-managed dashboard (PID ${running.pid}) is still running from ${saved ?? "the saved checkout"}.`);
    warn(`Run \`${cliCommand("stop")}\` first, or stop it from that checkout by hand.`);
  }

  forgetAppRoot();
  ok(saved ? `Forgot the saved app checkout ${saved} (removed ${statePath}).` : `Removed an unreadable app checkout state file (${statePath}).`);
  // `setup --app-dir` runs the Docker/Supabase prerequisite gate before it
  // repoints, so it is not the zero-dependency answer; name the env override too.
  step(`Link another with \`${cliCommand("setup --app-dir <path>")}\` (also starts the local stack),`);
  step("or set PASSCONTROL_APP_ROOT=<path> for a one-off override.");
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
  await runLocalPrerequisiteChecks({ offset, enforce: true });
  await ensureAppRoot({ clone: true, appDir: opts.appDir, yes: opts.yes });
  step("Preparing the local Supabase, Redis, migrations, and dev user…");
  await runLocalCommand(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev:stack"], {
    ...process.env,
    PASSCONTROL_PORT_OFFSET: String(offset),
  });
  // dev:stack has just brought Supabase and Redis up (and would have exited
  // non-zero if it hadn't), so skip start's own service pass rather than print
  // two "already running" lines under a banner that just said the stack is up.
  await startDashboard({ ...opts, dashboardOnly: true });
  if (!opts.noOpen) await openDashboard(opts);
  console.log(`\n${formatLabel("Local dashboard", dashboard.url, 19)}`);
  console.log(formatLabel("Login", "the account you created during setup", 19));
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

    console.log(heading("PassControl init"));
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

// Destination first, passport second. The signature this produces is the
// passport proving itself and carries no audience, so handing it to the wrong
// host is the whole compromise — see `requirePassportGateway`. Validating here
// covers every minting caller, `doctor --deep` and `try` included.
async function mintVisa(current = config) {
  const origin = requirePassportGateway(current);
  const { passportId, passportSecret } = requirePassport(current);
  const payloadObj = { passport_id: passportId, ts: Date.now(), nonce: crypto.randomUUID() };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(payloadObj)));
  const signature = b64url(ed25519.sign(fromB64url(payload), fromB64url(passportSecret)));
  const res = await fetch(`${origin}/api/auth/challenge`, {
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
  // Before `requirePassport`, and before the banner: this line used to print
  // `config.gateway` verbatim, so `https://admin:hunter2@host` put the password
  // on the terminal and into any log scraping it.
  const origin = requirePassportGateway(config);
  requirePassport(config);
  step(`${provider}/${model} via ${origin}`);
  step(`prompt: ${prompt}\n`);

  const { visa, expires_in } = await mintVisa(config);
  ok(`minted visa (expires in ${expires_in ?? 300}s)`);

  const { path: proxyPath, body } = requestFor(provider, model, prompt);
  const res = await fetch(`${origin}/api/v1/${provider}/${proxyPath}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${visa}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(formatProxyError(res.status, await res.text()));
  await streamResponse(res);
  ok("done - check the dashboard audit log + spend for this call.");
}

// `passcontrol try` — the 60-second, no-key, no-accounts experience. Uses the
// seeded demo passport (demo scope only) to make a GOVERNED call through the
// keyless `demo` provider, then arms the kill switch to show the same call
// blocked. Everything is real (visa, scope, budget, kill) except the model.
async function tryCommand() {
  // Covers the demo proxy call AND the kill-switch PUT below, which builds its
  // own control-plane URL rather than going through the guarded `api()`.
  const gateway = requirePassportGateway(config);
  const demo = { gateway, passportId: DEMO_PASSPORT_ID, passportSecret: DEMO_PASSPORT_SECRET };

  const demoCall = async () => {
    const { visa } = await mintVisa(demo);
    return fetch(`${gateway}/api/v1/demo/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${visa}` },
      body: JSON.stringify({
        model: "demo-1",
        max_tokens: 64,
        messages: [{ role: "user", content: "Say hi in exactly three words" }],
      }),
    });
  };
  const setKill = async (armed) => {
    const res = await fetch(`${gateway}/api/control/v1/kill-switch`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${DEMO_API_KEY}`,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({ armed }),
    });
    if (!res.ok) throw new Error(`kill-switch ${armed ? "on" : "off"} → ${res.status} ${await res.text()}`);
  };

  console.log(`${heading("PassControl — 60-second try (no provider key, no accounts)")}\n`);
  step(`gateway: ${gateway}`);

  // 1. Governed, keyless call.
  let res;
  try {
    res = await demoCall();
  } catch (e) {
    const msg = e?.message || String(e);
    if (/unknown_passport|Challenge failed|challenge/i.test(msg)) {
      // Gateway reachable, but the demo passport isn't seeded in ITS database.
      fail(`The gateway is up, but the demo passport isn't seeded here (${msg}).`);
      step("Seed + enable the demo on this stack:");
      step("  PASSCONTROL_DEMO=1 npm run dev:stack    # seeds the demo passport + control key");
      step("  PASSCONTROL_DEMO=1 npm run dev:docker   # enables the keyless demo provider");
    } else {
      fail(`Could not reach the gateway at ${gateway} (${msg}).`);
      step("Bring the local demo stack up first:");
      step("  PASSCONTROL_DEMO=1 npm run dev:stack    # Supabase + Redis + migrate + seed the demo passport");
      step("  PASSCONTROL_DEMO=1 npm run dev:docker   # start the gateway with the demo provider enabled");
    }
    process.exitCode = 1;
    return;
  }
  if (res.status === 404) {
    fail("The demo provider is not enabled on this gateway.");
    step("Start it with PASSCONTROL_DEMO=1 (e.g. `PASSCONTROL_DEMO=1 npm run dev:docker`).");
    process.exitCode = 1;
    return;
  }
  if (res.status === 401 || res.status === 403) {
    fail(`Demo passport not accepted (${res.status}). Re-seed the demo stack: PASSCONTROL_DEMO=1 npm run seed`);
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    fail(`Unexpected ${res.status}: ${await res.text()}`);
    process.exitCode = 1;
    return;
  }

  const json = await res.json().catch(() => ({}));
  const text = json?.choices?.[0]?.message?.content ?? JSON.stringify(json);
  const usage = json?.usage ?? {};
  ok("Governed keyless call succeeded — the passport signed the challenge, the gateway issued a short-lived visa and enforced scope + budget, and no key was needed:");
  console.log(`\n  ${text}\n`);
  step(`tokens: ${usage.total_tokens ?? "?"} (prompt ${usage.prompt_tokens ?? "?"} + completion ${usage.completion_tokens ?? "?"})`);

  // 2. Kill switch blocks the very next call.
  console.log("");
  step("arming the kill switch…");
  await setKill(true);
  try {
    const blocked = await demoCall();
    if (blocked.status === 403) {
      ok(`Kill switch works — the same call is now ${blocked.status} blocked_suspended.`);
    } else {
      fail(`Expected 403 after arming the kill switch, got ${blocked.status}.`);
    }
  } finally {
    await setKill(false);
    step("kill switch disarmed.");
  }

  console.log("");
  ok("That's PassControl: cryptographic identity → short-lived visa → governed call → instant kill. The provider key never touched the agent.");
  step("Next: add a real provider key in the Control Tower and re-point your agent at the gateway (see the README).");
}

async function api(method, pathPart, body, { timeoutMs } = {}) {
  // Destination first, key second — same order and same reason as the SDK's
  // ControlClient. `config.gateway` is whatever PASSCONTROL_GATEWAY said, and
  // this is the one place a long-lived fleet-wide `pc_` key goes on the wire, so
  // the URL is built from the validated origin rather than from that string.
  const origin = requireControlGateway(config);
  const apiKey = requireControlApiKey(config);
  // Unbounded by default, deliberately: a fleet mutation must not be abandoned
  // halfway because a caller guessed a duration. `timeoutMs` is opt-in, for the
  // one kind of caller that is a REPORT — where a gateway that never answers is
  // itself the finding, and hanging turns a diagnostic into a hang.
  const controller = timeoutMs ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let res;
  try {
    res = await fetch(`${origin}/api/control/v1${pathPart}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(method !== "GET" ? { "idempotency-key": crypto.randomUUID() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      ...(controller ? { signal: controller.signal } : {}),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  return Object.prototype.hasOwnProperty.call(json, "data") ? json.data : json;
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
      const rows = agents.map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          tokens: a.spent_tokens,
          usd: a.spent_microcents === undefined ? undefined : usd(a.spent_microcents),
        }));
      if (opts.json) console.log(JSON.stringify(rows, null, 2));
      else console.table(rows);
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
    // Retire this agent's key and install a new one, keeping the agent — its id,
    // budgets, audit history and receipts all stay put.
    //
    // The keypair is generated HERE, on the operator's machine, and only the
    // PUBLIC half is sent. That is the product: the gateway has never held a
    // passport private key and this command must not be the first thing to
    // change that.
    case "rotate": {
      if (!args[0]) {
        throw new Error("Usage: passcontrol agent rotate <id> [--grace <seconds>]");
      }
      const grace = opts.grace === undefined ? undefined : Number(opts.grace);
      if (grace !== undefined && (!Number.isFinite(grace) || grace < 0)) {
        throw new Error("--grace must be a non-negative number of seconds.");
      }
      const priv = ed25519.utils.randomPrivateKey();
      const passportId = b64url(ed25519.getPublicKey(priv));
      const result = await api("POST", `/agents/${encodeURIComponent(args[0])}/rotate`, {
        passportPubkey: passportId,
        ...(grace === undefined ? {} : { graceSeconds: grace }),
      });

      ok(`rotated agent ${args[0]}`);
      // Printed BEFORE the deadline, and never written to a file. A rotation
      // that silently overwrote .passcontrol would destroy the only copy of the
      // key that is still working — mid-window, which is the outage the window
      // exists to prevent. The operator moves it deliberately.
      step("Store these - the secret is shown once and is the agent's new passport:");
      console.log(`  PASSPORT_ID=${passportId}`);
      console.log(`  PASSPORT_SECRET=${b64url(priv)}`);
      const until = result?.previous_valid_until;
      step(
        until
          ? `The OLD key keeps working until ${until}. Both keys authenticate until then — deploy the new one before it passes.`
          : "The old key stops working immediately."
      );
      break;
    }
    default:
      throw new Error(
        "Usage: passcontrol agent list|create <name>|suspend <id>|resume <id>|revoke <id>|rotate <id> [--grace <seconds>]"
      );
  }
}

async function spendCommand(opts = {}) {
  const data = await api("GET", "/spend");
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
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
  if (opts.json) {
    console.log(JSON.stringify(events, null, 2));
    return;
  }
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
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.table(
    rows.map((row) => {
      const input = typeof row.input_tokens === "number" && Number.isFinite(row.input_tokens)
        ? row.input_tokens
        : null;
      const output = typeof row.output_tokens === "number" && Number.isFinite(row.output_tokens)
        ? row.output_tokens
        : null;
      return {
        at: row.created_at,
        agent: row.agent_id,
        provider: row.provider,
        model: row.model,
        status: row.status,
        in: input ?? "-",
        out: output ?? "-",
        total: input === null && output === null ? "-" : (input ?? 0) + (output ?? 0),
        usd: usd(row.cost_microcents),
      };
    })
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

  // Validate before the passport is read and before the listener binds: the
  // sidecar mints on demand for the lifetime of the process, so a bad
  // destination has to be refused at start, not at the first proxied request.
  const gateway = requirePassportGateway(config);
  const { passportId, passportSecret } = requirePassport(config);
  startSidecar({
    gateway,
    passportId,
    passportSecret,
    port: sidecarPort(opts),
    host: String(opts.host ?? process.env.SIDECAR_HOST ?? "127.0.0.1"),
    // Named on the command line, never inferred. A sidecar reachable off-host
    // mints visas for whoever connects, so widening the bind is a decision the
    // operator states rather than one a config value makes quietly.
    allowNonLoopback: Boolean(opts.allowNonLoopback),
    // Hosts the agent may CONNECT-tunnel to, beyond the gateway itself. Provider
    // hosts are never eligible — see cli/proxy-policy.mjs.
    //
    // `operatorEnv`, not `process.env`, for the same reason `allowNonLoopback`
    // above takes no environment fallback at all: this is an egress control. A
    // `.passcontrol` that travels with a cloned repository was able to add tunnel
    // destinations to a sidecar started with no flags, and say nothing about it.
    allowConnectHosts: String(opts.allowConnect ?? operatorEnv("SIDECAR_ALLOW_CONNECT") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    refreshSkewSeconds: Number(opts.refreshSkewSeconds ?? process.env.REFRESH_SKEW_SECONDS ?? 30),
  });

  if (opts.for) {
    console.log("");
    printAgentPreset(String(opts.for), opts);
  }
}

async function mcpCommand() {
  const gateway = requirePassportGateway(config);
  const { passportId, passportSecret } = requirePassport(config);
  const { startMcpServer } = await import("../cli/mcp/server.mjs");
  await startMcpServer({ gateway, passportId, passportSecret });
}

function sidecarPort(opts = {}) {
  const port = Number(opts.port ?? process.env.SIDECAR_PORT ?? 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535.");
  }
  return port;
}

function sidecarBaseUrl(opts = {}) {
  const provider = String(opts.provider || config.provider);
  assertProvider(provider);
  const host = String(opts.host ?? process.env.SIDECAR_HOST ?? "127.0.0.1");
  const port = sidecarPort(opts);
  return {
    provider,
    model: activeModel(provider, opts),
    apiKey: "passcontrol",
    baseUrl: `http://${host}:${port}/api/v1/${provider}`,
    port,
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

function requireGlobalMcpPassport() {
  assertConfigLoaded();
  const globalSource = config.sources.find((source) => source.type === "global");
  const passportId = String(globalSource?.values?.PASSPORT_ID ?? "").trim();
  const passportSecret = String(globalSource?.values?.PASSPORT_SECRET ?? "").trim();
  if (!passportId || !passportSecret) {
    throw new Error(
      "MCP client setup requires a passport in the global PassControl config. Run `passcontrol init --global` first."
    );
  }
}

function passControlMcpEntry() {
  return mcpServerEntry({ cliPath: CLI_ENTRY });
}

function printMcpPreset(integration) {
  requireGlobalMcpPassport();
  if (integration === "claude-code") {
    console.log("# Add PassControl to Claude Code:");
    console.log(CLAUDE_CODE_ADD_COMMAND);
    return;
  }

  const label = integration === "cursor" ? "Cursor" : "Claude Desktop";
  console.log(`# ${label} mcpServers config:`);
  console.log(JSON.stringify(mcpServersDocument(passControlMcpEntry()), null, 2));
}

function printAgentPreset(name = "generic", opts = {}) {
  const preset = name.toLowerCase();
  if (isMcpIntegration(preset)) {
    printMcpPreset(preset);
    return;
  }

  const { provider, model, apiKey, baseUrl, port } = sidecarBaseUrl(opts);
  const modelWithProvider = `${provider}/${model}`;
  const sidecarStart = opts.port != null || process.env.SIDECAR_PORT != null
    ? cliCommand(`sidecar --port ${port}`)
    : cliCommand("sidecar");

  console.log(`# Start the bridge first: ${sidecarStart}`);

  // Desktop / GUI clients: there is nothing to export, you type these into a
  // settings form. The API-key field is required by the UI but ignored by the
  // sidecar — that is the point. It is where your real provider key used to go.
  if (isGuiPreset(preset)) {
    console.log(`# ${GUI_PRESET_LABELS[preset]} settings:`);
    console.log(`Base URL: ${baseUrl}`);
    console.log(`API key:  ${apiKey}`);
    console.log(`Model:    ${modelWithProvider}`);
    return;
  }

  switch (preset) {
    case "hermes":
      console.log("# Hermes Agent custom provider (verified against Hermes 0.18.2):");
      console.log("# Merge this model block into ~/.hermes/config.yaml:");
      console.log("model:");
      console.log(`  default: ${JSON.stringify(model)}`);
      console.log("  provider: custom");
      console.log(`  base_url: ${JSON.stringify(`${baseUrl}/v1`)}`);
      console.log(`  api_key: ${JSON.stringify(apiKey)}`);
      console.log("# The placeholder key is stripped by the sidecar. Keep `passcontrol sidecar` running.");
      break;
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
    case "generic":
      console.log("# Generic sidecar settings:");
      printExports([
        ["PASSCONTROL_SIDECAR_BASE_URL", baseUrl],
        ["PASSCONTROL_SIDECAR_API_KEY", apiKey],
        ["PASSCONTROL_MODEL", modelWithProvider],
      ]);
      break;
    default:
      throw new Error(`Usage: passcontrol env <${integrationChoices()}>`);
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

function configureMcpClient(integration, opts = {}) {
  requireGlobalMcpPassport();
  if (integration === "claude-code") {
    // Claude Code owns its MCP registry through its own CLI, so there is no
    // config file for us to merge into. `--write` used to be accepted here and
    // silently do nothing — refuse it and hand back the command that works.
    if (opts.write) {
      throw new Error(
        `Claude Code manages MCP servers through its own CLI, so there is no file to write. Run:\n  ${CLAUDE_CODE_ADD_COMMAND}`
      );
    }
    console.log("Claude Code manages MCP servers through its CLI. Run:");
    console.log(CLAUDE_CODE_ADD_COMMAND);
    return;
  }

  const target = mcpClientConfigPath(integration);
  const entry = passControlMcpEntry();
  const preview = JSON.stringify(mcpServersDocument(entry), null, 2);
  console.log(`Preview: ${target}\n\n${preview}`);
  if (!opts.write) {
    step("Dry run only. Re-run with `--write` to merge this entry.");
    return;
  }

  const result = writeMcpClientConfig({ target, entry, force: Boolean(opts.force) });
  if (!result.changed) {
    ok(`${target} already contains this PassControl MCP entry`);
    return;
  }
  if (result.backupPath) step(`backed up ${result.backupPath}`);
  ok(`wrote ${target}`);
}

async function configureCommand(rest, opts = {}) {
  const integration = String(rest[0] ?? "").toLowerCase();
  if (!integration) {
    throw new Error(
      `Usage: passcontrol configure <${integrationChoices()}> [--write] [--force]`
    );
  }
  if (!isIntegration(integration)) {
    throw new Error(
      `Unknown integration "${integration}". Use one of: ${integrationChoices()}.`
    );
  }
  if (isMcpIntegration(integration)) {
    configureMcpClient(integration, opts);
    return;
  }
  if (!supportsWrite(integration)) {
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

// ── Which build is which ─────────────────────────────────────────────────────
//
// Version drift between the CLI, the gateway and the database is the support
// question that hides behind every other support question, and until now the
// CLI could only answer a third of it. `passcontrol version` printed its own
// number and stopped.
//
// The three rows come from three different places on purpose, and each degrades
// on its own:
//
//   CLI      — the installed package. Always available.
//   Server   — GET /api/version on the configured gateway. Unauthenticated,
//              because the release version is already on the site footer.
//   Schema   — the migration block of /api/control/v1/system, which is behind
//              the operator gate. How far behind a database is doubles as a
//              list of the fixes it does not have, so it stays authenticated;
//              on a self-host the operator is the person running this, and on
//              Cloud a tenant correctly cannot read the instance's lag.

/** The gateway's own build, or null. Never throws: this is a report, not a gate. */
async function serverVersion() {
  // Same origin rule as every other outbound path in this file, even though no
  // credential travels here — see probeGatewayOrigin.
  const origin = probeGatewayOrigin();
  if (!origin) return { version: null, detail: "the configured gateway is not a bare origin" };
  try {
    const res = await fetchWithTimeout(`${origin}/api/version`);
    // A gateway that predates this endpoint is a real PassControl gateway, and
    // saying "unreachable" about one that answered would send an operator to
    // debug their network instead of deploying.
    if (res.status === 404) return { version: null, detail: "running a build older than /api/version" };
    if (!res.ok) return { version: null, detail: `the gateway answered ${res.status}` };
    const body = await res.json();
    const version = typeof body?.version === "string" ? body.version : null;
    return { version, detail: version ? null : "the gateway did not report a version" };
  } catch {
    return { version: null, detail: "unreachable" };
  }
}

/**
 * The migration block, or why it could not be read.
 *
 * Every branch is a distinct, actionable answer. "not checked" is not the same
 * as "forbidden", and neither is the same as a gateway that is simply down —
 * collapsing them is how an operator ends up debugging the wrong thing.
 */
async function schemaState() {
  if (!config.apiKey) return { state: "unchecked", detail: "no control API key configured" };
  try {
    // Bounded: `doctor` exists to explain an unavailable gateway, so this line
    // must never be the reason the report does not print.
    const snapshot = await api("GET", "/system", undefined, { timeoutMs: 2500 });
    const migrations = snapshot?.data?.migrations ?? snapshot?.migrations ?? null;
    if (!migrations) return { state: "unchecked", detail: "the gateway returned no migration block" };
    return { state: migrations.state ?? "unknown", migrations };
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/system_forbidden|system_not_configured|system_totp_required|system_allowlist_invalid/.test(message)) {
      return { state: "unchecked", detail: "this control key is not an operator of that instance" };
    }
    // A bare "fetch failed" reads as a bug in the CLI rather than as a gateway
    // that is not running, which is what it almost always means.
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|aborted/i.test(message)) {
      return { state: "unchecked", detail: "the gateway is unreachable" };
    }
    // Never echo the upstream error body into this report: it is remote text,
    // and "401 invalid_api_key no (req ?)" tells an operator less than the
    // sentence it is standing in for.
    if (/invalid_api_key|\b401\b/.test(message)) {
      return { state: "unchecked", detail: "the control API key was rejected" };
    }
    if (/\b404\b/.test(message)) {
      return { state: "unchecked", detail: "this gateway is too old to report its schema" };
    }
    return { state: "unchecked", detail: "the gateway did not answer the system check" };
  }
}

const SCHEMA_WORD = {
  current: "compatible",
  behind: "the database is missing migrations this build expects",
  ahead: "the database is newer than this build — was the app rolled back?",
  incompatible: "the applied migrations do not match this build",
  unknown: "could not be determined",
};

async function versionCommand({ json = false } = {}) {
  const [server, schema] = await Promise.all([serverVersion(), schemaState()]);
  const migrations = schema.migrations ?? null;
  const serverLabel =
    server.version === null
      ? `not reported (${server.detail})`
      : `${server.version}${server.version === CLI_VERSION ? "  ✓" : "  ✗ different build from this CLI"}`;

  if (json) {
    console.log(JSON.stringify({
      cli: CLI_VERSION,
      server: server.version,
      server_detail: server.detail,
      server_matches_cli: server.version === null ? null : server.version === CLI_VERSION,
      schema: migrations
        ? {
            state: schema.state,
            applied_head: migrations.applied_head ?? null,
            expected_head: migrations.expected_head ?? null,
            missing_count: migrations.missing_count ?? 0,
            extra_count: migrations.extra_count ?? 0,
          }
        : { state: schema.state, detail: schema.detail ?? null },
    }, null, 2));
    return;
  }

  console.log(`${heading("PassControl")}\n`);
  console.log(formatLabel("CLI", CLI_VERSION, 18));
  console.log(formatLabel("Server", serverLabel, 18));
  if (migrations) {
    console.log(formatLabel("Database schema", migrations.applied_head ?? "none recorded", 18));
    console.log(formatLabel("Expected schema", migrations.expected_head ?? "unknown", 18));
    console.log(formatLabel("Status", `${schema.state} — ${SCHEMA_WORD[schema.state] ?? "see the dashboard"}`, 18));
    if (migrations.action) step(migrations.action);
  } else {
    console.log(formatLabel("Database schema", `not checked (${schema.detail})`, 18));
  }
}

async function doctorCommand(opts = {}) {
  const gateway = await gatewayStatus(false);
  console.log(`${heading("PassControl doctor")}\n`);
  (gateway.ok ? ok : fail)(`Gateway ${gateway.label}: ${config.gateway}`);
  (config.passportId && config.passportSecret ? ok : fail)(
    `Passport ${config.passportId && config.passportSecret ? "configured" : "missing"}`
  );
  (config.apiKey ? ok : step)(`Control API key ${config.apiKey ? "configured" : "missing (needed only for agent/kill commands)"}`);
  step(`Config source: ${configPathLabel(config.sources)}`);
  // The check that answers "why did this work yesterday". A database behind the
  // build it serves is not visible from any other line in this report.
  const schema = await schemaState();
  if (schema.migrations) {
    (schema.state === "current" ? ok : fail)(
      `Database migrations ${schema.state} — ${SCHEMA_WORD[schema.state] ?? "see the dashboard"}`
    );
  } else {
    step(`Database migrations not checked (${schema.detail})`);
  }

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
  // One authenticated request for this command. Its failure is a failed
  // diagnostic, not a CLI crash: remaining local checks are still useful.
  printSystemHealthDiagnostic(await fetchSystemHealth());
  await runLocalPrerequisiteChecks({ report: true });
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

  await checkInstanceSigningKey();
}

// Receipts and agent tokens are signed by a key the DEPLOYMENT owns. A missing
// key is loud (nothing is signed), but a PASSCONTROL_ISSUER pointing somewhere
// that does not serve this deployment's JWKS fails silently: every receipt then
// carries an `iss` whose key set cannot verify it. Check it explicitly.
async function checkInstanceSigningKey() {
  const seed = process.env.INSTANCE_SIGNING_KEY;
  const issuer = process.env.PASSCONTROL_ISSUER;

  if (!seed) {
    step(
      "Instance signing key not set in this shell — receipts and agent tokens are disabled " +
        `(run \`${cliCommand("keygen instance")}\` to create one).`
    );
    return;
  }

  let kid;
  try {
    kid = instanceKidFromSeed(seed);
  } catch {
    fail("INSTANCE_SIGNING_KEY is set but is not a valid 32-byte base64url seed.");
    return;
  }
  ok(`Instance signing key configured (kid ${kid})`);

  if (!issuer) {
    fail("PASSCONTROL_ISSUER is not set — receipts would be signed with no verifiable issuer.");
    return;
  }

  const result = await checkIssuerPublishesKey({ issuer, kid });
  (result.ok ? ok : fail)(`Issuer check: ${result.reason}`);
}

// `passcontrol verify` needs no config, no passport, and no API key — it is the
// one command a stranger runs against someone else's deployment.
async function verifyCommand(rest, opts) {
  const what = rest[0];
  const artifact = rest[1];
  const issuer = String(opts.issuer || process.env.PASSCONTROL_ISSUER || "");

  if ((what !== "token" && what !== "receipt") || !artifact) {
    throw new Error(
      "Usage: passcontrol verify token <jwt> --audience <aud> --issuer <origin>\n" +
        "       passcontrol verify receipt <jws> --issuer <origin>"
    );
  }
  if (!issuer) {
    throw new Error(
      "Set --issuer <https origin> (or PASSCONTROL_ISSUER). A verifier that trusts " +
        "whatever issuer the artifact names is not verifying anything."
    );
  }

  const result =
    what === "token"
      ? await verifyAgentToken(artifact, { issuer, audience: String(opts.audience || "") })
      : await verifyReceipt(artifact, { issuer });

  if (!result.ok) {
    fail(`Not valid: ${FAILURE_REASONS[result.reason] ?? result.reason}`);
    process.exitCode = 1;
    return;
  }

  const c = result.claims;
  ok(what === "token" ? "Token is valid." : "Receipt is valid.");
  step(`Issuer:   ${c.iss}`);
  step(`Passport: ${c.sub}`);
  if (what === "token") {
    step(`Audience: ${c.aud}`);
    step(`Expires:  ${new Date(c.exp * 1000).toISOString()}`);
  } else {
    step(`Call:     ${c.mth} ${c.path} → ${c.prov}${c.mdl ? `/${c.mdl}` : ""}`);
    step(`Verdict:  ${c.res?.status} (HTTP ${c.res?.http})`);
    step(`Usage:    ${c.use?.in ?? 0} in / ${c.use?.out ?? 0} out · ${c.cost ?? 0} µ¢`);
    if (c.req) step(`Request:  ${c.req.alg} ${c.req.dig} (${c.req.len} bytes)`);
  }
  if (c.own) {
    step(
      `Owner:    ${c.own.sub} (${c.own.tier === "unverified" ? "self-declared, unverified" : c.own.tier})`
    );
  }
}

async function keygenCommand(rest) {
  const target = rest[0];
  if (target !== "instance") {
    throw new Error(`Usage: ${cliCommand("keygen instance")}`);
  }

  const { seed, kid } = generateInstanceKey();
  ok("Generated an Ed25519 instance signing key.");
  step("This key signs call receipts and agent-to-agent tokens. Store the seed like a password:");
  console.log(`  INSTANCE_SIGNING_KEY=${seed}`);
  console.log("");
  step(`Its public half publishes at /.well-known/jwks.json as kid ${kid}.`);
  step("Also set PASSCONTROL_ISSUER to this deployment's https origin — it becomes the");
  step("`iss` claim, and the origin other deployments use to find this one's JWKS.");
  step("");
  step("Rotating? Move the current value to INSTANCE_SIGNING_KEY_PREV and keep it there.");
  step("Unlike VISA_SECRET_PREV we never sign with it — its public key stays published so");
  step("receipts signed before the rotation still verify. Publish the new key, wait one");
  step("JWKS max-age window, then start signing with it.");
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

// ── Workspace snapshots ─────────────────────────────────────────────────────
// A recovery snapshot is CONFIGURATION, not a backup: it carries agents, their
// scopes, budgets, policies and failover order, and deliberately carries no
// secret value at all. What it cannot restore is stated in the file itself,
// under `exclusions`, because this is the artifact someone opens at the worst
// possible moment.

// lib/control/body.ts caps every control-plane request at 64 KiB, and it is not
// raised for one route. Checking here means a large fleet is told what to do
// instead of being handed a bare 413 by the server.
const IMPORT_BODY_LIMIT = 64 * 1024;

// Wide enough for "Skipped (already exist)", the longest label below. formatLabel
// pads to the width and does not truncate, so a short width silently glues the
// value onto the colon.
const REPORT_LABEL_WIDTH = 26;

// A passport public key is unique across the whole instance, not per workspace,
// because the gateway identifies an agent BY that key. So importing a file into
// a second workspace on the SAME instance refuses every agent still held by the
// first — which is correct, and is not what a restore looks like. A restore
// goes into a fresh instance, where the passports are free.
const IMPORT_REASONS = {
  passport_registered_elsewhere:
    "its passport is already registered on this instance. Nothing was created for it. " +
    "Passports are unique per instance, so this file restores into a FRESH deployment, " +
    "not alongside the workspace it came from.",
  policy_malformed: "its policy could not be parsed, and creating it without one would leave it unrestricted.",
  policy_shadow_malformed: "its shadow policy could not be parsed.",
  unknown_status: "it records a status this version does not recognise.",
};

async function exportCommand(opts = {}) {
  const snapshot = await api("GET", "/workspace/export");
  const body = JSON.stringify(snapshot, null, 2);
  const target = typeof opts.out === "string" ? opts.out : null;
  if (!target) {
    console.log(body);
    return;
  }
  fs.writeFileSync(target, `${body}\n`, { mode: 0o600 });
  ok(`Wrote ${snapshot.workspace.agents.length} agents to ${target}`);
  console.log(`\n${heading("Not in this file")}`);
  for (const line of snapshot.exclusions) console.log(`  • ${line}`);
}

async function importCommand(rest = [], opts = {}) {
  const file = rest[0];
  if (!file) throw new Error(`Usage: ${cliPrefix()} import <file> [--confirm IMPORT]`);

  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read ${file} as JSON: ${error.message}`);
  }
  if (snapshot?.format !== "passcontrol-export") {
    throw new Error(`${file} is not a PassControl workspace export.`);
  }
  // A file from a LATER schema may describe fields this CLI would silently drop.
  // Refusing is the honest move: a partial restore that reports success is the
  // failure this whole feature exists to prevent.
  if (Number(snapshot.version) > WORKSPACE_IMPORT_MAX_VERSION) {
    throw new Error(
      `${file} uses export format v${snapshot.version}; this CLI understands up to ` +
        `v${WORKSPACE_IMPORT_MAX_VERSION}. Upgrade PassControl and try again.`
    );
  }

  // Only what the import writes goes on the wire. Provider mappings, break-glass
  // grants, the exclusions prose and the display settings stay on disk — they
  // are not importable, so sending them would spend the size budget on bytes the
  // server ignores.
  const agents = snapshot.workspace?.agents ?? [];
  const payload = { agents, ownership: snapshot.workspace?.ownership ?? null };
  const size = Buffer.byteLength(JSON.stringify(payload));
  if (size > IMPORT_BODY_LIMIT) {
    throw new Error(
      `This snapshot holds ${agents.length} agents (${Math.ceil(size / 1024)} KiB) and the import ` +
        `API accepts ${IMPORT_BODY_LIMIT / 1024} KiB per request. Split the "agents" array across ` +
        `several files and import them one at a time — importing is additive, so the parts combine.`
    );
  }

  const preview = await api("POST", "/workspace/import?dry_run=true", payload);
  printImportReport(preview, { preview: true });

  if (preview.agents.create === 0) {
    ok(noAgentCreateMessage(preview.agents));
    return;
  }
  if (opts.confirm !== "IMPORT") {
    console.log(
      `\nNothing has been written. Re-run with \`--confirm IMPORT\` to create the ` +
        `${preview.agents.create} agent(s) above.`
    );
    return;
  }

  const result = await api("POST", "/workspace/import", payload);
  printImportReport(result, { preview: false });
  ok(importCompletionMessage(result));
}

function printImportReport(report, { preview }) {
  console.log(`\n${heading(preview ? "Dry run — nothing written yet" : "Imported")}`);
  const created = preview ? report.agents.create : report.agents.created.length;
  console.log(formatLabel(preview ? "Will create" : "Created", String(created), REPORT_LABEL_WIDTH));
  if (report.agents.skipped.length > 0) {
    console.log(formatLabel("Skipped (already exist)", report.agents.skipped.join(", "), REPORT_LABEL_WIDTH));
  }
  for (const entry of report.agents.rejected) {
    console.log(formatLabel("Refused", `${entry.name} — ${IMPORT_REASONS[entry.reason] ?? entry.reason}`, REPORT_LABEL_WIDTH));
  }
  console.log(formatLabel("Ownership", report.ownership, REPORT_LABEL_WIDTH));
  console.log(`\n${heading("Not restored")}`);
  for (const line of report.not_restored) console.log(`  • ${line}`);
  // Said once, plainly: an existing agent is never touched, so a re-run is safe.
  console.log(`\nAn agent already in the workspace is left exactly as it is — import never overwrites.`);
}

async function main() {
  const { opts, rest } = parseArgv(process.argv.slice(2));
  const [command, ...commandRest] = rest;

  // Started here and awaited at the very end, so the registry lookup overlaps
  // the command instead of being tacked onto the exit. On anything that touches
  // the network — which is most of this CLI — it costs nothing measurable, and
  // it can never turn a registry outage into a slow `passcontrol call`.
  // .catch() rather than try/catch: an unhandled rejection from a background
  // nicety must not take down a command that already did its job.
  const updateNotice = checkForUpdate({
    current: CLI_VERSION,
    json: Boolean(opts.json),
  }).catch(() => null);
  const announceUpdate = async () => {
    const notice = await updateNotice;
    if (notice) console.log(`\n${notice}`);
  };

  if (opts.help || command === "help") {
    const target = command === "help" ? commandRest[0] : command;
    console.log(target === "agent" || target === "fleet" ? agentUsage() : usage());
    return;
  }
  if (opts.version || command === "version") {
    await versionCommand({ json: Boolean(opts.json) });
    await announceUpdate();
    return;
  }

  switch (command) {
    case undefined:
    case "status":
      await printCockpit({ noNetwork: Boolean(opts.noNetwork), json: Boolean(opts.json) });
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
      await stopCommand(opts);
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
    case "unlink":
      unlinkCommand();
      break;
    case "call":
      await callCommand(commandRest, opts);
      break;
    case "try":
      await tryCommand();
      break;
    case "sidecar":
      await sidecarCommand(commandRest, opts);
      break;
    case "mcp":
      await mcpCommand();
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
      await spendCommand(opts);
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
    case "export":
      await exportCommand(opts);
      break;
    case "import":
      await importCommand(commandRest, opts);
      break;
    case "open":
      await openDashboard(opts);
      break;
    case "keygen":
      await keygenCommand(commandRest);
      break;
    case "verify":
      await verifyCommand(commandRest, opts);
      break;
    default:
      throw new Error(`Unknown command "${command}". Run \`passcontrol help\`.`);
  }
  // Only on success. A notice printed under a failure buries the error.
  await announceUpdate();
}

main().catch((error) => {
  fail(error.message);
  process.exit(1);
});
