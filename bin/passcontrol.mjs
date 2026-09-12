#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519";
import { availableGroups, browse, printStatic, updateRecents } from "../cli/menu.mjs";
import {
  agentStateArgv,
  collectMenuRemoteStatus,
  integrationPreviewArgv,
  killSwitchArgv,
  logsArgv,
  verificationArgv,
} from "../cli/menu-session.mjs";
import {
  CLOUD_GATEWAY,
  CONFIG_FILE,
  OPENAI_SHAPE_PROVIDERS,
  PROVIDERS,
  WORKSPACE_IMPORT_MAX_VERSION,
  accent,
  alarm,
  amber,
  assertConfigLoaded,
  bareGatewayOrigin,
  config,
  configPathLabel,
  defaultModelForProvider,
  fail,
  formatLabel,
  formatChallengeError,
  formatProxyError,
  globalConfigPath,
  mergeConfigFile,
  mergeConfigFileAtomic,
  muted,
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
  INTEGRATIONS,
  integrationChoices,
  isGuiPreset,
  isIntegration,
  supportsWrite,
} from "../cli/presets.mjs";
import { importCompletionMessage, noAgentCreateMessage } from "../cli/workspace-import-report.mjs";
import { checkForUpdate } from "../cli/update-check.mjs";
import { startSidecar } from "../cli/sidecar.mjs";
import { waitForGateway as awaitGateway } from "../cli/gateway-wait.mjs";
import { loginCommand } from "../cli/login.mjs";
import { logoutCommand } from "../cli/logout.mjs";
import { proveItWorks } from "../cli/selftest.mjs";
import {
  checkIssuerPublishesKey,
  generateInstanceKey,
  instanceKidFromSeed,
  retiredKeyEntry,
} from "../cli/instance-key.mjs";
import { FAILURE_REASONS, verifyAgentToken, verifyReceipt, verifyStatement } from "../cli/verify.mjs";
import { compareProtocolSets } from "../cli/protocols.mjs";
import { defaultAllowedModelForProvider } from "../cli/integration-defaults.mjs";
import {
  PASSPORT_KEY_STORAGE_OS,
  createPassportCredentialStore,
  keyStorageDeclaration,
  migratePassportKey,
} from "../cli/passport-key-store.mjs";

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

const DEMO_API_KEY = "pc_demolocaltrydemolocaltrydemolocaltry0000";
const DASHBOARD_STATE_FILE = "local-dashboard.json";
const APP_STATE_FILE = "app.json";
const PUBLIC_REPO_URL = "https://github.com/Vertias3u/PassControl.git";
// The hosted demo. `try` cannot simply DEFAULT here: its second step arms and
// disarms the tenant kill switch, so concurrent visitors would collide on shared
// demo-tenant state and an aborted run would leave the public demo killed. It is
// offered as a browser link instead — the one zero-install way to see the
// pipeline when there is no local stack yet.
// One literal, in cli/config.mjs. The demo and the Cloud gateway are the same
// origin, and keeping two copies is how they stop being the same origin.
const HOSTED_DEMO_URL = CLOUD_GATEWAY;
const LOCAL_DASHBOARD_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const LOCAL_DASHBOARD_ORIGIN = "http://localhost:3000";
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
  ${cmd}                         browse the commands (shows status when not a terminal)
  ${cmd} settings                browse the commands
  ${cmd} <command> [options]

${heading("Quick start")}
  Cloud. No Docker, no database — this CLI is the only thing you install.
  ${cmd} login [--project]        sign in through your browser and set this machine up
  ${cmd} call "hi"                mint a visa and make a governed model call
  ${cmd} mcp                      passport identity for Claude Desktop, Cursor, Claude Code
  ${cmd} sidecar [--port 8788] [--allow-connect host[,host]]
                                 passport identity for any tool that takes an api_key

${heading("Operate")}
  ${cmd} status [--no-network] [--json]
                                 show active config and instance state
  ${cmd} version [--json]         CLI, gateway and database schema versions
  ${cmd} doctor [--deep] [--fix]  diagnose setup and repair a stopped dashboard
  ${cmd} open                     open the Control Tower in a browser
  ${cmd} logout [--revoke-agent]  revoke this machine's key and clear its credentials
  ${cmd} init [--global]          configure by hand, without a browser
  ${cmd} passport import --global --gateway <origin> --id <passport-id> [--replace]
                                 securely import a dashboard-issued passport

${heading("Manage")}
  ${cmd} agent list [--json]      list agents
  ${cmd} agent create <name> [--write]
                                 create an agent passport (--write saves it here)
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
  ${cmd} statements [--limit 20] [--json]
                                 show the chain of signed spend statements
  ${cmd} kill on|off              toggle the tenant kill switch
  ${cmd} export [--out FILE]      save a workspace configuration snapshot
  ${cmd} import <file> [--confirm IMPORT]
                                 restore agents from a snapshot (never overwrites)

${heading("Integrate")}
  ${cmd} env [integration]        print settings without writing anything
  ${cmd} configure <integration> [--write] [--force]
                                 preview or write integration config
  integrations: ${integrationChoices()}

${heading("Trust")}
  ${cmd} key status               show the local passport key storage tier
  ${cmd} key migrate              move a tier 0 file key into the OS credential store
  ${cmd} keygen instance          create the receipt-signing key
  ${cmd} keygen instance --retire <seed>
                                 print the public entry that keeps a rotated-out
                                 key's receipts verifiable
  ${cmd} verify receipt <jws> --issuer <origin>
                                 verify a signed call receipt
  ${cmd} verify token <jwt> --audience <aud> --issuer <origin>
                                 verify an agent-to-agent token

${heading("Self-host — run your own gateway")}
  Clones the app and runs Docker + Supabase + Redis here. You operate it, and
  your instance signs its own receipts — they verify against your JWKS, not ours.
  ${cmd} setup [--no-open] [--port-offset N] [--app-dir DIR] [--forget-active-credentials]
                                 clone the app, start Docker + Supabase + Redis
  ${cmd} start [--dashboard-only] [--forget-active-credentials]
                                 start the whole local stack (clones the app if missing)
  ${cmd} stop [--dashboard-only]  stop the whole local stack (dashboard + Supabase + Redis)
  ${cmd} restart [--forget-active-credentials]
                                 restart the CLI-managed local dashboard
  ${cmd} local-logs [--follow]    show local dashboard logs
  ${cmd} reset --local --confirm RESET
                                 destroy and recreate the local stack
  ${cmd} unlink                   forget the remembered app checkout

${heading("Config:")}
  Env vars win, then nearest .passcontrol, then ~/.config/passcontrol/config.
  Only the self-host commands (setup/start/reset) ever clone anything. Installed
  globally, they resolve a cloned app checkout in this order:
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
                          [--write [--project] [--force]]
  ${cmd} agent rotate <id> [--grace <seconds>]
  ${cmd} agent suspend <id>
  ${cmd} agent resume <id>
  ${cmd} agent revoke <id>

${heading("Examples")}
  ${cmd} agent create prod-summarizer --provider anthropic --scope 'claude-*'
  ${cmd} agent create this-box --write        # save the passport here, never print it
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

async function gatewayStatus(noNetwork = false, gateway = config.gateway) {
  if (noNetwork) return { label: "not checked", ok: null };
  const origin = probeGatewayOrigin({ gateway });
  if (!origin) return { label: "invalid configuration", ok: false };
  try {
    const res = await fetchWithTimeout(`${origin}/api/version`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { label: `unhealthy (${res.status})`, ok: false };
    const body = await res.json().catch(() => null);
    const version = typeof body?.version === "string" && body.version.trim() ? body.version.trim() : null;
    return version
      ? { label: `online (${res.status}, PassControl ${version})`, ok: true, version }
      : { label: "unhealthy (not a PassControl version response)", ok: false };
  } catch {
    return { label: "offline or unreachable", ok: false };
  }
}

async function printCockpit({ noNetwork = false, json = false } = {}) {
  const gateway = await gatewayStatus(noNetwork);
  const local = managedDashboardTarget();
  const localGateway = await gatewayStatus(noNetwork, local.url);
  const passportSecret = config.passportSecret;
  const passportStorage = config.passportStorage;
  const passportConfigured = Boolean(config.passportId && passportSecret);
  const adminConfigured = Boolean(config.apiKey);
  const dashboard = dashboardStatusLabel(localGateway, noNetwork, local);
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
      dashboard: { url: local.url, state: dashboard, healthy: localGateway.ok },
      app: { state: app },
      config: {
        source: configFile,
        provider: config.provider,
        model: config.model,
        passport_configured: passportConfigured,
        passport_key_storage_tier: passportStorage.tier,
        passport_key_storage_source: passportStorage.source,
        passport_key_storage_fallback: passportStorage.fallback,
        control_api_key_configured: adminConfigured,
      },
      system_health: systemHealthForJson(systemHealth),
    }, null, 2));
    return;
  }

  console.log(`${heading("PassControl")}\n`);
  console.log(formatLabel("Gateway", `${gateway.label}  ${config.gateway}`));
  console.log(formatLabel("Dashboard", `${dashboard}  ${local.url}`));
  console.log(formatLabel("App", app));
  console.log(formatLabel("Config", configFile));
  console.log(formatLabel("Provider", config.provider));
  console.log(formatLabel("Model", config.model));
  console.log(formatLabel("Passport", passportConfigured ? redact(config.passportId) : "missing"));
  console.log(formatLabel("Key storage", passportStorage.message));
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

// Every docker call the CLI makes needs a bound, not just the daemon probe. A
// wedged Docker Desktop leaves its CLI socket present and answers nothing, so an
// unbounded `docker ps` waits forever — which is how `doctor --deep` hung
// indefinitely on the very check that exists to REPORT a wedged engine. The
// value is the cold-start allowance argued for in checkDockerDaemon below;
// sharing it keeps one number rather than three that drift.
const DOCKER_TIMEOUT_MS = 15_000;

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
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: DOCKER_TIMEOUT_MS });
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

async function readHiddenLine(question) {
  if (!process.stdin.isTTY) {
    let value = "";
    for await (const chunk of process.stdin) value += chunk;
    return value.replace(/\r?\n$/u, "").trim();
  }
  if (typeof process.stdin.setRawMode !== "function") {
    throw new Error("This terminal cannot hide secret input. Redirect the secret on stdin from a private file or secret manager.");
  }
  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return await new Promise((resolve, reject) => {
    let value = "";
    const finish = (error = null) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const byte of Buffer.from(chunk)) {
        if (byte === 3) return finish(new Error("Passport import cancelled."));
        if (byte === 10 || byte === 13) return finish();
        if (byte === 8 || byte === 127) value = value.slice(0, -1);
        else value += String.fromCharCode(byte);
      }
    };
    process.stdin.on("data", onData);
  });
}

/**
 * Yes/no prompt. Enter means YES unless `{ default: false }` is passed.
 *
 * The option exists for one caller — `passcontrol login` asking before it
 * replaces a passport secret. That answer is unrecoverable, so the reply an
 * operator gives by reflex has to be the one that changes nothing. Every other
 * caller keeps the enter-means-yes behaviour it was written against.
 */
async function confirmYes(question, { default: fallback = true } = {}) {
  const answer = (await promptLine(question, "")).toLowerCase();
  if (answer === "") return fallback;
  return answer === "y" || answer === "yes";
}

const GATEWAY_BOUND_CONFIG_KEYS = [
  "PASSCONTROL_GATEWAY",
  "PASSPORT_ID",
  "PASSPORT_SECRET",
  "PASSPORT_KEY_STORAGE",
  "PASSCONTROL_API_KEY",
];

function sameOrigin(left, right) {
  try {
    return bareGatewayOrigin(left) === bareGatewayOrigin(right);
  } catch {
    return false;
  }
}

/** Decide a local-mode transition before starting any service. The decision is
 * committed only after the local PassControl endpoint is healthy. */
async function prepareLocalActivation(target, opts = {}) {
  const shellOverride = GATEWAY_BOUND_CONFIG_KEYS.find((key) => operatorEnv(key) !== undefined);
  if (shellOverride) {
    throw new Error(
      `${shellOverride} comes from the operator environment, so a global self-host configuration cannot replace it. Unset it before running this command.`
    );
  }

  const project = config.sources.find((source) =>
    source.type === "project" && GATEWAY_BOUND_CONFIG_KEYS.some((key) => Object.hasOwn(source.values, key))
  );
  if (project) {
    throw new Error(
      `${project.path} overrides gateway-bound configuration. PassControl will not rewrite a project file during a machine-wide self-host switch. Remove those lines or run the command outside that project.`
    );
  }

  const global = config.sources.find((source) => source.type === "global");
  const values = global?.values ?? {};
  const switching = !sameOrigin(config.gateway, target.url);
  const passportId = String(values.PASSPORT_ID ?? "").trim();
  const storageMarker = String(values.PASSPORT_KEY_STORAGE ?? "").trim();
  const hasCredentials = switching && Boolean(
    passportId ||
    String(values.PASSPORT_SECRET ?? "").trim() ||
    storageMarker ||
    String(values.PASSCONTROL_API_KEY ?? "").trim()
  );

  if (hasCredentials && opts.forgetActiveCredentials !== true) {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive) {
      throw new Error(
        "Switching this machine to self-host would forget gateway-bound credentials. Re-run interactively to confirm, or pass --forget-active-credentials. --yes never authorises credential deletion."
      );
    }
    warn(`The current credentials are bound to ${config.gateway}.`);
    warn("Forgetting them locally does not revoke the remote control key or Passport agent.");
    const confirmed = await confirmYes(
      `Forget the local credentials and switch this machine to ${target.url}? [y/N] `,
      { default: false }
    );
    if (!confirmed) throw new Error("Self-host switch cancelled; no services or credentials were changed.");
  }

  return {
    target,
    switching,
    hasCredentials,
    passportId,
    storageMarker,
    previousGateway: config.gateway,
    globalPath: globalConfigPath(),
  };
}

function restoreFileAtomically(file, contents) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.restore-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, contents, { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function commitLocalActivation(prepared) {
  if (!prepared.switching) return;
  const existed = fs.existsSync(prepared.globalPath);
  const previous = existed ? fs.readFileSync(prepared.globalPath, "utf8") : null;
  mergeConfigFileAtomic(prepared.globalPath, {
    PASSCONTROL_GATEWAY: prepared.target.url,
    PASSPORT_ID: "",
    PASSPORT_SECRET: "",
    PASSPORT_KEY_STORAGE: "",
    PASSCONTROL_API_KEY: "",
  });

  if (prepared.storageMarker === PASSPORT_KEY_STORAGE_OS && prepared.passportId) {
    const removed = createPassportCredentialStore().delete(prepared.passportId);
    if (!removed.ok) {
      if (previous === null) fs.rmSync(prepared.globalPath, { force: true });
      else restoreFileAtomically(prepared.globalPath, previous);
      throw new Error(
        `${removed.message}. The gateway switch was rolled back because the old Passport key could not be removed from the OS credential store.`
      );
    }
  }

  ok(`active gateway set to ${prepared.target.url}`);
  if (prepared.hasCredentials) {
    warn(`Credentials for ${prepared.previousGateway} were forgotten locally, not revoked remotely.`);
    if (prepared.passportId) warn(`Remote Passport ID that may still need cleanup: ${prepared.passportId}`);
    warn("Return to the previous gateway with an authorised machine to revoke any remaining remote identity.");
  }
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
        { encoding: "utf8", timeout: DOCKER_TIMEOUT_MS }
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

function parseLocalDashboard(value, label = "PASSCONTROL_GATEWAY") {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${label} URL.`);
  }

  if (url.protocol !== "http:" || !LOCAL_DASHBOARD_HOSTS.has(url.hostname)) {
    throw new Error(
      `passcontrol only manages local HTTP gateways on localhost, 127.0.0.1 or [::1].`
    );
  }
  if (!url.port) {
    throw new Error(
      `${label} is a local URL without an explicit port. Use ${LOCAL_DASHBOARD_ORIGIN}, or specify the port of the local dashboard you intend PassControl to manage.`
    );
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid local dashboard port in ${label}.`);
  }
  return { url: url.toString().replace(/\/$/, ""), port };
}

function canonicalLocalDashboard() {
  return parseLocalDashboard(LOCAL_DASHBOARD_ORIGIN, "the canonical local dashboard");
}

/** Resolve the local process target independently from the active Cloud/API
 * gateway. A running state file wins, then an explicit valid local gateway;
 * remote active config falls back to the canonical local dashboard. */
function managedDashboardTarget({ forceCanonical = false } = {}) {
  if (!forceCanonical) {
    const state = readDashboardState();
    if (state?.gateway) {
      try {
        return { ...parseLocalDashboard(state.gateway, "saved dashboard state"), state };
      } catch {
        removeDashboardState();
      }
    }
    let parsed = null;
    try {
      parsed = new URL(config.gateway);
    } catch {
      // The active gateway is reported separately; local management still has
      // a deterministic target.
    }
    if (parsed?.protocol === "http:" && LOCAL_DASHBOARD_HOSTS.has(parsed.hostname)) {
      // Deliberately outside the URL parse catch: a local URL without a port is
      // a configuration error, not a reason to silently choose another port.
      return parseLocalDashboard(config.gateway);
    }
  }
  return canonicalLocalDashboard();
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

function dashboardStatusLabel(gateway, noNetwork, target = managedDashboardTarget()) {
  if (noNetwork) return "local server not checked";
  const managed = runningManagedDashboard();
  if (managed) return gateway.ok ? `CLI-managed (PID ${managed.pid})` : `CLI-managed, unhealthy (PID ${managed.pid})`;
  return gateway.ok ? `online at ${target.url} (not managed by CLI)` : `stopped (${target.url})`;
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

/**
 * Adapter over cli/gateway-wait.mjs — that module owns the decision, this
 * supplies the three real probes. `port` and `pid` are optional because one
 * caller (an already-running dashboard we did not spawn) knows the pid but the
 * budget logic is the same either way.
 */
async function waitForGateway({ gateway = LOCAL_DASHBOARD_ORIGIN, port = null, pid = null } = {}) {
  return awaitGateway({
    probeGateway: async () => (await gatewayStatus(false, gateway)).ok,
    probePort: port ? () => portIsListening(port) : null,
    processAlive: pid
      ? () => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        }
      : null,
    onCompiling: () =>
      step("server is up and compiling — first run only, this can take a couple of minutes…"),
  });
}

function ownSupabaseDatabaseIsRunning(offset = 0) {
  try {
    const root = appRoot ?? resolveAppRoot();
    if (!root) return false;
    const project = `${path.basename(root)}${offset ? `-${offset}` : ""}`;
    return Boolean(
      execFileSync("docker", ["ps", "-q", "--filter", `name=^/supabase_db_${project}$`], { encoding: "utf8", timeout: DOCKER_TIMEOUT_MS }).trim()
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
    // Every failure, not just the first. These checks are independent, and each
    // one a first-time user hits is its own install-and-come-back detour; finding
    // them one run at a time turns a single setup into three sittings. `results`
    // already holds them all — only the reporting was lossy.
    const failures = results.filter((result) => !result.ok);
    if (failures.length > 0) {
      // `fail()` marks the first line; the rest carry their own marker so a
      // four-item list does not read as one failure with three stray sentences.
      throw new Error(failures.map((failure) => failure.message).join("\n\u2717 "));
    }
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
  const dashboard = opts.dashboardTarget ?? managedDashboardTarget({ forceCanonical: opts.forceCanonical === true });

  const envFile = path.join(appRoot, ".env.docker");
  if (!fs.existsSync(envFile)) {
    throw new Error(`Local stack is not configured. Run \`${cliCommand("setup")}\` in ${appRoot} first.`);
  }

  if (opts.dashboardOnly) step("Leaving Supabase and Redis alone (--dashboard-only).");
  else await startLocalServices();

  if ((await gatewayStatus(false, dashboard.url)).ok) {
    ok(`dashboard already online at ${dashboard.url}`);
    return dashboard;
  }

  const running = runningManagedDashboard();
  if (running) {
    step(`dashboard is still starting (PID ${running.pid}); waiting for ${dashboard.url}…`);
    if (await waitForGateway({ gateway: dashboard.url, port: dashboard.port, pid: running.pid })) {
      ok(`dashboard online at ${dashboard.url}`);
      return dashboard;
    }
    throw new Error(`CLI-managed dashboard (PID ${running.pid}) did not become ready. See ${running.logPath}.`);
  }

  const statePath = dashboardStatePath();
  const logPath = dashboardLogPath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(logPath, "a", 0o600);
  // `node scripts/dev-docker.mjs` rather than `npm run dev:docker`: identical
  // work (that is all the npm script is now), minus npm/cmd wrappers. Next's CLI
  // still forks its HTTP worker, so this pid is deliberately the SUPERVISOR.
  // Unix stops its process group; Windows uses taskkill /T for the whole tree.
  const devServer = path.join(appRoot, "scripts", "dev-docker.mjs");
  if (!fs.existsSync(devServer)) {
    throw new Error(`${devServer} is missing — this checkout is incomplete or predates the local-stack launcher. Re-clone, or run \`npm run dev:docker\` from ${appRoot} by hand.`);
  }
  const child = spawn(process.execPath, [devServer], {
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
  if (!await waitForGateway({ gateway: dashboard.url, port: dashboard.port, pid: child.pid })) {
    removeDashboardState();
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
    if (process.platform === "win32") {
      execFileSync("taskkill.exe", ["/PID", String(state.pid), "/T"], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
    } else process.kill(-state.pid, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") {
      removeDashboardState();
      ok("No CLI-managed local dashboard is running.");
      return;
    }
    throw error;
  }

  if (!await waitForPortRelease(state.port)) {
    if (process.platform === "win32") {
      execFileSync("taskkill.exe", ["/PID", String(state.pid), "/T", "/F"], {
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      });
    }
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
  const target = opts.dashboardTarget ?? managedDashboardTarget();
  const managed = runningManagedDashboard();
  if (!managed) {
    if ((await gatewayStatus(false, target.url)).ok) {
      throw new Error("Dashboard is online but was not started by passcontrol; stop it manually before restarting.");
    }
    return startDashboard({ ...opts, dashboardTarget: target });
  }
  await stopDashboard();
  return startDashboard({ ...opts, dashboardTarget: target });
}

async function startLocalCommand(opts = {}) {
  const target = managedDashboardTarget();
  const activation = await prepareLocalActivation(target, opts);
  const dashboard = await startDashboard({ ...opts, dashboardTarget: target });
  commitLocalActivation(activation);
  return dashboard;
}

async function restartLocalCommand(opts = {}) {
  const target = managedDashboardTarget();
  const activation = await prepareLocalActivation(target, opts);
  const dashboard = await restartDashboard({ ...opts, dashboardTarget: target });
  commitLocalActivation(activation);
  return dashboard;
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

// Windows will not spawn a `.cmd`/`.bat` without a shell. Since Node 18.20.2 /
// 20.12.2 (the CVE-2024-27980 hardening) it refuses outright with EINVAL rather
// than executing it, which is how `passcontrol setup` died on the very first
// step with nothing but `✗ spawn EINVAL` to go on.
//
// Scoped to batch files ON PURPOSE, not applied to every spawn. `runCommand`
// also carries `docker compose -f docker/compose.yml` and `supabase start`;
// routing those through cmd.exe would re-introduce shell quoting to arguments
// that today are passed as an array and are safe in a path containing spaces.
function batchFileShell(command) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command) ? { shell: true } : {};
}

async function runCommand(command, args, { cwd = appRoot, env = process.env } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", ...batchFileShell(command) });
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
  managedDashboardTarget();
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
  const dashboard = canonicalLocalDashboard();
  const activation = await prepareLocalActivation(dashboard, opts);
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
  await startDashboard({ ...opts, dashboardOnly: true, dashboardTarget: dashboard });
  commitLocalActivation(activation);
  if (!opts.noOpen) openUrl(dashboard.url);
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
    const gatewayInput = await ask("Gateway URL", config.gateway);
    const passportIdInput = await ask("Passport ID", config.passportId);
    // Never use a passport secret as ask()'s fallback: fallbacks are rendered
    // inside square brackets, which would print a Keychain-retrieved key. A
    // blank answer preserves the current key silently. For Tier 1 that means
    // preserving only the non-secret marker; the key stays in the OS store.
    const passportSecretInput = await ask(
      "Passport Secret (input is visible; leave blank to keep current)"
    );
    const preserveOsStorage =
      !passportSecretInput && config.passportStorageMarker === PASSPORT_KEY_STORAGE_OS;
    const values = {
      PASSCONTROL_GATEWAY: gatewayInput,
      PASSPORT_ID: passportIdInput,
      PASSPORT_SECRET: preserveOsStorage
        ? ""
        : passportSecretInput || config.passportSecret,
      PASSPORT_KEY_STORAGE: preserveOsStorage ? PASSPORT_KEY_STORAGE_OS : "",
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
  const { passportId, passportSecret, keyStorage } = requirePassport(current);
  const payloadObj = {
    passport_id: passportId,
    ts: Date.now(),
    nonce: crypto.randomUUID(),
    // Declared, never checked: see lib/passport-key-storage.ts. Inside the
    // signed bytes so the claim belongs to whoever holds the key.
    ...(keyStorage ? { key_storage: keyStorage } : {}),
  };
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
      const scopeModel = String(opts.scope || defaultAllowedModelForProvider(provider));
      const priv = ed25519.utils.randomPrivateKey();
      const pub = ed25519.getPublicKey(priv);
      const passportId = b64url(pub);
      const created = await api("POST", "/agents", {
        name,
        passportPubkey: passportId,
        scopes: [{ provider, models: [scopeModel] }],
      });
      ok(`created agent ${created.id} (${created.name})`);

      // --write puts the passport somewhere durable INSTEAD of on the terminal.
      // Ordering matters: the file is written before anything is printed, so a
      // failure to write can still fall through to printing. The reverse — print
      // suppressed, write failed — loses the key permanently.
      if (opts.write) {
        const target = opts.project ? path.join(process.cwd(), CONFIG_FILE) : globalConfigPath();
        // Refuse rather than prompt. This command is run non-interactively (CI,
        // provisioning scripts) at least as often as by hand, and PassControl has
        // no copy of whatever is already in that file — an overwrite is not
        // undoable by us or by anyone.
        const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
        if (/^PASSPORT_SECRET=(.+)$/mu.exec(existing)?.[1]?.trim() && !opts.force) {
          throw new Error(
            `${target} already holds a passport secret, and PassControl has no copy of it.\n` +
              "  Re-run with --force to replace it, or without --write to print the new one instead."
          );
        }
        mergeConfigFile(target, {
          PASSPORT_ID: passportId,
          PASSPORT_SECRET: b64url(priv),
          PASSPORT_KEY_STORAGE: "",
        });
        ok(`wrote the passport to ${target} — it was not printed`);
        break;
      }

      step("Store these - the secret is shown once and is the agent's passport:");
      console.log(`  PASSPORT_ID=${passportId}`);
      console.log(`  PASSPORT_SECRET=${b64url(priv)}`);
      // The paste is the fallback, not the lesson. Copying a private key between
      // a browser, a clipboard and a file is how a passport secret once ended up
      // in a Hermes `api_key` field — and for a second machine it is not even
      // necessary: `login` there mints its own passport and copies nothing.
      step("Running this agent on ANOTHER machine? Run `passcontrol login` there instead —");
      step("it creates its own passport locally and no secret is ever copied.");
      step("Otherwise store the secret like a password, or re-run with --write to save it here.");
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
      // No --write here, deliberately: see the note above the reveal. What this
      // CAN say is that a machine you control does not need the rotation at all.
      step("Rotating only to set up a new machine? `passcontrol login` there creates its own");
      step("passport instead, and leaves this one working everywhere it already runs.");
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
      class: opts.class,
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
  const { passportId, passportSecret, keyStorage } = requirePassport(config);
  startSidecar({
    gateway,
    passportId,
    passportSecret,
    keyStorage,
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
  const { passportId, passportSecret, keyStorage } = requirePassport(config);
  const { startMcpServer } = await import("../cli/mcp/server.mjs");
  await startMcpServer({ gateway, passportId, passportSecret, keyStorage });
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
      dashboard = managedDashboardTarget();
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
    // The whole chain, not just the mint. "Visa mint works" proves the passport
    // authenticates and says nothing about scope, budget, the proxy or receipts —
    // so the most useful diagnostic in the tool was the one thing `login` already
    // did better. Shared implementation (cli/selftest.mjs) rather than a second
    // copy, because two copies of a five-leg check drift.
    const proof = await proveItWorks({
      origin: requirePassportGateway(config),
      passportId: config.passportId,
      passportSecret: config.passportSecret,
      keyStorage: keyStorageDeclaration(config.passportStorage),
      apiKey: config.apiKey,
      fetchImpl: fetch,
    });
    if (proof.receipt === "verified") ok("End to end: governed call made, receipt verified");
    else if (proof.call) step("Governed call works; its receipt was not verified (see above)");
    else if (proof.visa) step("Passport authenticates; no governed call was possible here");
    else fail("Passport could not authenticate — see the reason above");
  } else {
    step("Skipping the end-to-end check: no passport configured.");
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

  if ((what !== "token" && what !== "receipt" && what !== "statement") || !artifact) {
    throw new Error(
      "Usage: passcontrol verify token <jwt> --audience <aud> --issuer <origin>\n" +
        "       passcontrol verify receipt <jws> --issuer <origin>\n" +
        "       passcontrol verify statement <jws> --issuer <origin>"
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
      : what === "statement"
        ? await verifyStatement(artifact, { issuer })
        : await verifyReceipt(artifact, { issuer });

  if (!result.ok) {
    fail(`Not valid: ${FAILURE_REASONS[result.reason] ?? result.reason}`);
    process.exitCode = 1;
    return;
  }

  const c = result.claims;
  ok(what === "token" ? "Token is valid." : what === "statement" ? "Statement is valid." : "Receipt is valid.");
  step(`Issuer:   ${c.iss}`);
  if (what === "statement") {
    // What this signature does and does not settle. The totals below are what
    // the issuer CLAIMED and committed to — verifying the signature proves they
    // cannot change it now, not that it was right when they computed it.
    // Recomputing `root` needs every receipt in the window, which you do not have.
    step(`Workspace: ${c.sub}`);
    step(`Statement: #${c.seq}${c.pst ? "" : " (first in this chain)"}`);
    step(
      `Window:    ${new Date(c.per?.from * 1000).toISOString()} → ${new Date(c.per?.to * 1000).toISOString()}`
    );
    step(`Covers:    ${c.n} of ${c.nr} logged calls · ${c.cost} µ¢`);
    if (c.nr > c.n) {
      step(`           ${c.nr - c.n} call(s) carried no receipt and are NOT covered by the root.`);
    }
    if (c.unp) step(`           ${c.unp} call(s) could not be priced — that cost is unknown, not zero.`);
    if (c.unk) step(`           ${c.unk} call(s) have no recorded cost and no recorded reason.`);
    step(`Root:      ${c.root ?? "none — this window covered no receipts"}`);
    step(`Follows:   ${c.pst ?? "nothing — this is the head of the chain"}`);
    step("");
    step("This proves the issuer committed to that set of receipts at that time and");
    step("cannot change it now. It does not independently confirm the totals: that");
    step("would need every receipt in the window.");
    return;
  }
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

/**
 * The chain of signed spend statements for this workspace.
 *
 * `covered` and `rows` are shown side by side on purpose, and so are the two
 * pricing columns. A statement's honesty is in the gap between them — rows it
 * could not cover, calls nobody could price, calls whose pricing was never
 * recorded — and a table that printed only the count and the cost would quietly
 * turn "we cannot say" into "zero".
 */
async function statementsCommand(opts) {
  // One binary serves both audiences, so this command ships everywhere while the
  // endpoint behind it exists only on a deployment that OPERATES a chain. A
  // gateway that merely verifies statements has no /statements route, and the
  // 404 that comes back is a correct answer about that gateway rather than a
  // fault — say so, instead of letting a raw HTTP error read as a broken CLI.
  let rows;
  try {
    rows = await api("GET", controlPath("/statements", { limit: safeLimit(opts.limit) }));
  } catch (e) {
    // api() formats a failure as `<status> <code> <message> (req <id>)`, so the
    // status is the leading token. Anchor on it: a 200 body that merely contains
    // "404" must not be read as a missing route.
    if (/^404\b/.test(String(e?.message || ""))) {
      step("This gateway does not operate a statement chain.");
      step("Producing statements — the nightly job, the stored chain, inclusion proofs —");
      step("is a hosted capability. Verifying one needs no account and works here:");
      step("  passcontrol verify statement <jws> --issuer <origin>");
      return;
    }
    throw e;
  }
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    step("No signed statements yet. They are produced once a day, for the day before.");
    step("If this stays empty, check that the deployment sets INSTANCE_SIGNING_KEY and");
    step("that its statements cron is scheduled.");
    return;
  }
  console.table(
    rows.map((row) => ({
      seq: row.seq,
      day: String(row.period_start ?? "").slice(0, 10),
      covered: row.covered_count,
      rows: row.row_count,
      "µ¢": row.cost_microcents,
      unpriced: row.unpriced_count,
      unknown: row.unknown_pricing_count,
      chained: row.prev_digest ? "yes" : "first",
    }))
  );
}

async function keygenCommand(rest, opts = {}) {
  const target = rest[0];
  if (target !== "instance") {
    throw new Error(`Usage: ${cliCommand("keygen instance")}`);
  }

  // `--retire <seed>` prints the public pair for a key being taken out of
  // service. Nothing about it is secret, and that is the point: the operator
  // has no other way to derive a public half, and the alternative they reach
  // for — pasting the seed — is 32 base64url bytes too.
  // From `opts`, not `rest`: parseArgv consumes every `--flag` and its value
  // before the command ever sees the array, so scanning `rest` for "--retire"
  // finds nothing and silently generates a NEW key instead — which, run against
  // a live deployment's seed, looks like it worked.
  if (opts.retire !== undefined) {
    const seed = typeof opts.retire === "string" ? opts.retire : "";
    if (!seed) throw new Error(`Usage: ${cliCommand("keygen instance --retire <seed>")}`);
    const { entry, kid } = retiredKeyEntry(seed);
    ok(`Retired key ${kid}.`);
    step("Append this to INSTANCE_SIGNING_KEY_HISTORY (comma-separated) and leave it there");
    step("forever — receipts carry no expiry, so this is what keeps old ones checkable:");
    console.log(`  ${entry}`);
    console.log("");
    step("It is a PUBLIC key. It cannot sign, which is why history takes this and not the");
    step("seed: a retired seed left in configuration can mint new receipts under the old kid.");
    step("Delete the seed once this is in place.");
    return;
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
  step("Rotating? Two steps, and the FIRST is the one that lasts:");
  step(`  1. ${cliCommand("keygen instance --retire <the old seed>")} — append the pair it prints`);
  step("     to INSTANCE_SIGNING_KEY_HISTORY. That list is permanent and public-only.");
  step("  2. Move the old seed to INSTANCE_SIGNING_KEY_PREV for the changeover, then delete it.");
  step("Unlike VISA_SECRET_PREV we never sign with either — their public keys stay published");
  step("so receipts signed before the rotation still verify. _PREV holds ONE generation, so");
  step("history is what keeps the receipts from the rotation before this one checkable.");
  step("Publish the new key, wait one JWKS max-age window, then start signing with it.");
}

function passportFileForMigration() {
  if (operatorEnv("PASSPORT_SECRET") !== undefined) {
    throw new Error(
      "PASSPORT_SECRET comes from the operator environment. Migration can remove only a tier 0 config-file key; move it into a PassControl config file first."
    );
  }

  let source = null;
  for (const candidate of config.sources) {
    if (Object.prototype.hasOwnProperty.call(candidate.values, "PASSPORT_SECRET")) source = candidate;
  }
  const secret = String(source?.values?.PASSPORT_SECRET ?? "");
  if (!source || !secret) {
    throw new Error("No tier 0 passport key was found in a PassControl config file.");
  }
  return { path: source.path, secret };
}

async function keyCommand(rest, opts = {}) {
  const subcommand = rest[0] ?? "status";
  if (subcommand === "status") {
    if (rest.length > 1) throw new Error(`Usage: ${cliCommand("key status")}`);
    assertConfigLoaded();
    const storage = config.passportStorage;
    console.log(formatLabel("Key storage", storage.message, 14));
    if (storage.fallback) warn("The OS credential store was not used; this process is using the tier 0 file key.");
    return;
  }

  if (subcommand !== "migrate" || rest.length > 1) {
    throw new Error(`Usage: ${cliCommand("key status")}\n       ${cliCommand("key migrate")}`);
  }
  if (opts.to && opts.to !== "keychain" && opts.to !== "os") {
    throw new Error("--to supports only `keychain` (the operating system credential store).");
  }
  assertConfigLoaded();
  if (config.passportStorageMarker === PASSPORT_KEY_STORAGE_OS) {
    throw new Error("This passport is already configured for tier 1 OS credential storage.");
  }
  if (!config.passportId) throw new Error("No PASSPORT_ID is configured for this passport key.");

  const file = passportFileForMigration();
  const store = createPassportCredentialStore();
  const result = migratePassportKey({
    passportId: config.passportId,
    secret: file.secret,
    store,
    removeFileSecret: () => mergeConfigFile(file.path, {
      PASSPORT_SECRET: "",
      PASSPORT_KEY_STORAGE: PASSPORT_KEY_STORAGE_OS,
    }),
  });

  if (!result.ok) {
    throw new Error(`${result.message} Key storage in use: tier 0 — file (${file.path}).`);
  }
  ok(result.message);
  step(`Removed PASSPORT_SECRET from ${file.path} only after verified readback.`);
}

function isEncodedEd25519Key(value) {
  return /^[A-Za-z0-9_-]{43}$/u.test(value) && fromB64url(value).length === 32;
}

async function passportCommand(rest, opts = {}) {
  const subcommand = rest[0];
  if (subcommand !== "import" || rest.length !== 1) {
    throw new Error(
      `Usage: ${cliCommand("passport import --global --gateway <origin> --id <passport-id> [--replace]")}`
    );
  }
  if (opts.global !== true) {
    throw new Error("Passport import is machine-wide for sidecar and MCP use; pass --global explicitly.");
  }
  if (typeof opts.gateway !== "string" || typeof opts.id !== "string") {
    throw new Error(
      `Usage: ${cliCommand("passport import --global --gateway <origin> --id <passport-id> [--replace]")}`
    );
  }

  const gateway = bareGatewayOrigin(opts.gateway, "--gateway");
  const passportId = opts.id.trim();
  if (!isEncodedEd25519Key(passportId)) {
    throw new Error("--id must be a 32-byte Ed25519 public key encoded as unpadded base64url.");
  }

  const project = config.sources.find((source) =>
    source.type === "project" && GATEWAY_BOUND_CONFIG_KEYS.some((key) => Object.hasOwn(source.values, key))
  );
  const shellOverride = GATEWAY_BOUND_CONFIG_KEYS.find((key) => operatorEnv(key) !== undefined);
  if (project) warn(`${project.path} contains gateway-bound values and will shadow this global import.`);
  if (shellOverride) warn(`${shellOverride} comes from the shell and will shadow this global import.`);

  const target = globalConfigPath();
  const global = config.sources.find((source) => source.type === "global");
  const oldId = String(global?.values?.PASSPORT_ID ?? "").trim();
  const oldSecret = String(global?.values?.PASSPORT_SECRET ?? "").trim();
  const oldStorage = String(global?.values?.PASSPORT_KEY_STORAGE ?? "").trim();
  if ((oldId || oldSecret || oldStorage) && opts.replace !== true) {
    throw new Error(
      `A global Passport is already configured. Refusing to replace an unrecoverable key; re-run with --replace after verifying the old identity can be retired.`
    );
  }

  const secret = await readHiddenLine("Paste the Passport secret (input hidden): ");
  if (!isEncodedEd25519Key(secret)) {
    throw new Error("Passport secret must be a 32-byte Ed25519 private key encoded as unpadded base64url.");
  }
  const derived = b64url(ed25519.getPublicKey(fromB64url(secret)));
  if (derived !== passportId) {
    throw new Error("Passport secret does not match the supplied Passport ID. Nothing was stored.");
  }

  const store = createPassportCredentialStore();
  const written = store.write(passportId, secret);
  if (!written.ok) throw new Error(`${written.reason}. Nothing was written to the PassControl config.`);
  const readback = store.read(passportId);
  if (!readback.ok || readback.secret !== secret) {
    store.delete(passportId);
    throw new Error(`${store.name} did not return the key that was just stored. The new item was removed and config was not changed.`);
  }

  try {
    mergeConfigFileAtomic(target, {
      PASSCONTROL_GATEWAY: gateway,
      PASSPORT_ID: passportId,
      PASSPORT_SECRET: "",
      PASSPORT_KEY_STORAGE: PASSPORT_KEY_STORAGE_OS,
    });
  } catch (error) {
    store.delete(passportId);
    throw error;
  }

  if (oldStorage === PASSPORT_KEY_STORAGE_OS && oldId && oldId !== passportId) {
    const removed = store.delete(oldId);
    if (!removed.ok) {
      warn(`The previous Passport key could not be confirmed removed from ${store.name}; the new import is active, but the old OS item needs manual cleanup.`);
    }
  }
  ok(`Passport ${passportId} imported into ${store.name}.`);
  step(`Global gateway: ${gateway}`);
  step("The private key was verified and never written to the config file or command line.");
}

async function openDashboard(opts = {}) {
  let parsed;
  try {
    parsed = new URL(config.gateway);
  } catch {
    throw new Error(`Invalid PASSCONTROL_GATEWAY URL: ${config.gateway}`);
  }
  const url = parsed.protocol === "http:" && LOCAL_DASHBOARD_HOSTS.has(parsed.hostname)
    ? (await startDashboard({ ...opts, dashboardTarget: parseLocalDashboard(config.gateway) })).url
    : config.gateway;
  openUrl(url);
}

/**
 * Open a URL in the operator's browser. Nothing else.
 *
 * Extracted from openDashboard because openDashboard is NOT a URL opener: for a
 * localhost gateway it routes through startDashboard, which is
 * `ensureAppRoot({ clone: true })`. Any new caller that reached for the obvious
 * function would have put a self-host `git clone` on the Cloud path — and
 * tests/cli-cloud-path-no-clone.test.ts could not have seen it, because that
 * guard pins DIRECT cloning callers and startDashboard is legitimately one.
 *
 * So this is the safe half, with no stack logic attached.
 * tests/cli-login-shape.test.ts pins both that it exists and that openDashboard
 * still delegates to it — a second hand-rolled spawn would pass the first check
 * and quietly lose the degradation below.
 */
function openUrl(url) {
  const platform = process.platform;
  const command =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  // A headless box, a container, or a machine with no handler: say the URL out
  // loud rather than appearing to hang.
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

  // The envelope, before anything is planned or sent.
  //
  // This used to be `snapshot.workspace?.agents ?? []`, which turns a truncated
  // file into an empty fleet: the API plans nothing, `every()` over an empty
  // plan is true, the report says `complete: true`, and the CLI prints "Nothing
  // to create." and exits 0. A damaged snapshot restored no fleet at all and
  // every surface reported success (T4-03). A MISSING agents collection is
  // corruption; an EMPTY one is a workspace that genuinely has no agents and
  // still imports fine.
  //
  // The server validates this independently — it has to, since anyone can curl
  // it — but the operator holding the damaged file is here, so this is where the
  // message can name the file and say what is wrong with it.
  if (!Array.isArray(snapshot.workspace?.agents)) {
    throw new Error(
      `${file} has no "workspace.agents" array. That is a truncated or damaged export, ` +
        `not an empty workspace — importing it would restore nothing and report success. ` +
        `Re-export from the source deployment.`
    );
  }

  // Only what the import writes goes on the wire. Provider mappings, break-glass
  // grants, the exclusions prose and the display settings stay on disk — they
  // are not importable, so sending them would spend the size budget on bytes the
  // server ignores.
  const agents = snapshot.workspace.agents;
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

function menuLocalStatus() {
  let gateway = "invalid or unavailable";
  // `host` is what the header shows and `gateway` is what the per-item "Current:"
  // lines show, so both are kept. Dropping the scheme from the header loses
  // nothing an operator needs: bareGatewayOrigin only accepts plain HTTP for a
  // loopback host, so http ⟺ loopback ⟺ the LOCAL badge already on the line.
  let host = "";
  let loopback = false;
  try {
    gateway = bareGatewayOrigin(config.gateway);
    const url = new URL(gateway);
    host = url.host;
    loopback = LOCAL_DASHBOARD_HOSTS.has(url.hostname);
  } catch {
    // Never the configured value: a rejected gateway URL can itself carry a
    // credential. "invalid" and "not configured" are different failures and the
    // operator fixes them differently, so they are not collapsed into one word.
    host = config.gateway ? "invalid" : "not configured";
  }
  const passportReady = Boolean(config.passportId && config.passportSecret);
  const controlReady = Boolean(config.apiKey);
  const source = configPathLabel(config.sources);
  const key = config.passportStorage?.message ?? `tier ${config.passportStorage?.tier ?? "unknown"}`;
  return {
    gateway,
    host,
    loopback,
    source,
    provider: `${config.provider}/${config.model}`,
    passport: passportReady ? "ready" : "missing",
    control: controlReady ? "ready" : "missing",
    key,
    app: appRootLabel(),
    current: {
      config: source,
      provider: `${config.provider}/${config.model}`,
      account: controlReady ? "control key configured" : "control key missing",
      app: appRootLabel(),
      key,
      gateway,
    },
  };
}

async function menuRemoteStatus() {
  return collectMenuRemoteStatus({
    hasApiKey: Boolean(config.apiKey),
    gatewayStatus: () => gatewayStatus(false),
    request: (pathPart, options) => api("GET", pathPart, undefined, options),
    safeText: safeHealthText,
  });
}

/**
 * Status tones for the browser header. Semantic, not decorative: a green ● is a
 * working thing, a dim ○ is an absent-but-not-broken thing, an amber ! is
 * degraded, and a red × is failed. Red appears in exactly two places in this
 * whole interface — a failed row here, and the Danger zone under the cursor —
 * which is what keeps it meaning something.
 */
const MENU_TONES = {
  ok: { glyph: "\u25cf", ink: accent },
  idle: { glyph: "\u25cb", ink: muted },
  warn: { glyph: "!", ink: amber },
  bad: { glyph: "\u00d7", ink: alarm },
};
const MENU_LABEL_WIDTH = 10;
const MENU_STATE_WIDTH = 16;

/**
 * Fit a cell to its column, with an ellipsis when it does not.
 *
 * The state column has to hold whatever `collectMenuRemoteStatus` produces, and
 * two of its values are already longer than the column: "100+ agents (partial)"
 * on a fleet of a hundred, and any account email past sixteen characters. An
 * overlong cell does not wrap, it pushes that row's tail right of every other
 * row's and the table stops being a table. Truncating loses the end of one
 * value; not truncating loses the alignment of all of them.
 */
function menuCell(text, width) {
  const value = String(text ?? "");
  // A truncated cell still ends in a space. Filling the column edge to edge
  // ran the ellipsis straight into the next column — "…write key" reads as one
  // mangled word rather than as two cells, which is the exact failure the
  // truncation is here to prevent.
  if (value.length <= width - 1) return value.padEnd(width);
  return `${value.slice(0, width - 2)}\u2026 `;
}

function menuRow(tone, label, state, tail = "") {
  const { glyph, ink } = MENU_TONES[tone];
  // Pad the RAW strings, then colour them. padEnd counts escape bytes, so
  // colouring first pushes every later column right by the width of an
  // invisible sequence — and because only some rows are coloured, the table
  // would jitter as the cursor moved. Every padEnd here is on plain text.
  const head = `  ${ink(glyph)} ${menuCell(label, MENU_LABEL_WIDTH)}`;
  if (!tail) return `${head}${ink(state)}`;
  return `${head}${ink(menuCell(state, MENU_STATE_WIDTH))}${muted(tail)}`;
}

/**
 * Shorten a gatewayStatus label to one word, with the tone it deserves.
 *
 * The HTTP code in that label is real information, but it belongs in
 * `passcontrol status`, not on a line the operator reads fifty times a day.
 * "not authenticated" maps to "not checked" rather than to a failure on
 * purpose: with no control key the menu never probes the gateway at all, so its
 * health is unknown rather than bad — and the Account row directly below is the
 * one that should explain why.
 */
function gatewayTone(label) {
  const text = String(label ?? "");
  if (text.startsWith("online")) return ["ok", "online"];
  if (text.startsWith("unhealthy")) return ["warn", "unhealthy"];
  if (text === "not authenticated" || text === "not checked") return ["idle", "not checked"];
  if (text === "invalid configuration") return ["bad", "misconfigured"];
  return ["bad", "unreachable"];
}

/**
 * Where the passport private key resolves from, as a tone and two short cells.
 *
 * The tail never carries the file path, only the word "file". The path is in
 * `passcontrol key status` and in `passcontrol status`; on the front door it is
 * an implementation detail wide enough to push the row off the screen.
 */
function keyTone(storage) {
  if (storage?.fallback) return ["warn", "file fallback", "the OS store was unavailable"];
  if (storage?.available !== true) return ["idle", "not configured", ""];
  if (storage?.tier === 1) return ["ok", "ready", String(storage.source ?? "OS store")];
  return ["ok", "ready", "file"];
}

/**
 * `PassControl <version>` on the left, a LOCAL/REMOTE badge at the right margin.
 *
 * The badge comes from the same loopback set the stack commands use, so LOCAL
 * means exactly what `passcontrol start` means by it. REMOTE rather than CLOUD:
 * a self-hosted gateway on a LAN address or a company domain is neither local
 * nor Cloud, and only one of those two words stays true for it. On a non-TTY
 * `columns` is undefined, so the badge falls back to two spaces instead of
 * padding a piped line out to a width nobody is watching.
 */
function menuTitle(local) {
  const badge = local.loopback ? "LOCAL" : "REMOTE";
  const plain = `PassControl ${CLI_VERSION}`;
  const painted = `${heading("PassControl")} ${muted(CLI_VERSION)}`;
  const gap = (Number(process.stdout.columns) || 0) - plain.length - badge.length - 1;
  return gap > 2 ? `${painted}${" ".repeat(gap)}${muted(badge)}` : `${painted}  ${muted(badge)}`;
}

/**
 * The browser header: a glyph table, not a status dump.
 *
 * It answers three questions and stops — is PassControl alive, what is it
 * pointed at, and is anything wrong. The configuration path, the HTTP status
 * code, the storage tier number and the redacted identifiers that used to sit
 * here are all one keystroke away in `passcontrol status`. A front door has to
 * be readable at a glance, and a detail that is always on screen stops reading
 * as a detail.
 *
 * THE TABLE IS A FIXED HEIGHT FOR A GIVEN INSTALL, and that is a layout
 * requirement rather than a nicety. The four control-plane reads land about a
 * second after the first frame; if the rows they fill did not exist until then,
 * the whole menu below would shift down under the reader's eyes just as they
 * were choosing. So Account and Fleet are drawn as "checking…" while the reads
 * are in flight and as "unavailable" when they fail — same rows, same height,
 * only the words change. `remote` has four states and each renders: `null` in
 * flight, `false` on the static non-TTY path that makes no requests at all,
 * `{unavailable:true}` for failed reads, and an object for the answer.
 *
 * The one row that appears and disappears is the kill switch, and only into the
 * gap at the bottom: it is drawn when armed, which is an emergency worth a line
 * and a colour, and omitted when clear, which is the state that should take up
 * no room. Six rows is the ceiling, and the whole top level fits an 80x24
 * terminal with it.
 */
function menuHeader(local, remote) {
  const pending = remote === null;
  const staticOnly = remote === false;
  const broken = Boolean(remote) && remote !== true && remote.unavailable === true;
  const live = !pending && !staticOnly && !broken ? remote : null;
  const rows = [];

  if (pending) rows.push(menuRow("idle", "Gateway", "checking\u2026", local.host));
  else if (staticOnly) rows.push(menuRow("idle", "Gateway", "not checked", local.host));
  else if (broken) rows.push(menuRow("bad", "Gateway", "unreachable", local.host));
  else {
    const [tone, state] = gatewayTone(live.gateway);
    rows.push(menuRow(tone, "Gateway", state, local.host));
  }

  rows.push(local.passport === "ready"
    ? menuRow("ok", "Provider", "ready", local.provider)
    : menuRow("idle", "Provider", "no passport", local.provider));

  const [tone, state, tail] = keyTone(config.passportStorage);
  rows.push(menuRow(tone, "Key", state, tail));

  // Everything below is a control-plane fact, so the static path ends here
  // rather than printing rows of "unknown" it never tried to look up. So does
  // an install with no control key: "no control key" on the Account row is the
  // whole explanation, and two more rows repeating it would be noise.
  if (staticOnly) return [menuTitle(local), ...rows].join("\n");
  if (local.control === "missing") {
    rows.push(menuRow("idle", "Account", "no control key"));
    return [menuTitle(local), ...rows].join("\n");
  }

  if (pending) rows.push(menuRow("idle", "Account", "checking\u2026"));
  else if (!live || live.account === "unavailable") rows.push(menuRow("idle", "Account", "unavailable"));
  else if (live.account === null) rows.push(menuRow("idle", "Account", "not served here"));
  else {
    const [email, scope = ""] = String(live.account).split(" \u00b7 ");
    rows.push(menuRow("ok", "Account", email, scope));
  }

  if (pending) rows.push(menuRow("idle", "Fleet", "checking\u2026"));
  else if (live && live.fleet !== "unavailable") {
    const [size, ...rest] = String(live.fleet).split(" \u00b7 ");
    rows.push(menuRow("ok", "Fleet", size, rest.join(" \u00b7 ")));
  } else rows.push(menuRow("idle", "Fleet", "unavailable"));

  // Armed, the kill switch is the reason every call in the workspace is
  // failing, and it must not read as another grey line in a table. Clear, it is
  // the absence of an alarm and takes no row at all — `passcontrol kill` and
  // `passcontrol status` both still report it in full.
  if (live && String(live.kill).includes("armed")) {
    rows.push(menuRow("bad", "Kill", "ARMED", live.kill));
  }

  return [menuTitle(local), ...rows].join("\n");
}

async function chooseMenuOption(question, options) {
  console.log(`\n${heading(question)}`);
  options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}`));
  const answer = await promptLine("Choose a number, or q to cancel: ", "q");
  if (String(answer).toLowerCase() === "q") return null;
  const index = Number(answer) - 1;
  return Number.isInteger(index) && options[index] ? options[index] : null;
}

async function eligibleAgent(status) {
  const agents = await api("GET", controlPath("/agents", { status, limit: 100 }), undefined, { timeoutMs: 1200 });
  if (!Array.isArray(agents) || agents.length === 0) {
    step(`No ${status} agents are eligible.`);
    return null;
  }
  return chooseMenuOption(
    status === "active" ? "Suspend an active agent" : "Resume a suspended agent",
    agents.map((agent) => ({ value: agent.id, label: `${safeHealthText(agent.name, "unnamed")} · ${String(agent.id).slice(0, 8)}…` }))
  );
}

async function guideMenuChoice(chosen) {
  switch (chosen.guide) {
    case "integration": {
      const picked = await chooseMenuOption("Preview an integration", INTEGRATIONS.map((value) => ({ value, label: value })));
      return picked ? integrationPreviewArgv(picked.value) : null; // Preview only: never append --write.
    }
    case "logs": {
      const agents = await api("GET", "/agents?limit=100", undefined, { timeoutMs: 1200 });
      const agent = await chooseMenuOption("Logs: agent", [
        { value: "", label: "All agents" },
        ...(Array.isArray(agents) ? agents.map((row) => ({ value: row.id, label: `${safeHealthText(row.name, "unnamed")} · ${String(row.id).slice(0, 8)}…` })) : []),
      ]);
      if (!agent) return null;
      const callClass = await chooseMenuOption("Logs: call class", ["all", "inference", "housekeeping"].map((value) => ({ value, label: value })));
      if (!callClass) return null;
      const status = await promptLine("Optional status filter (Enter for all): ", "");
      const limit = await chooseMenuOption("Logs: limit", [20, 50, 100].map((value) => ({ value, label: String(value) })));
      if (!limit) return null;
      return logsArgv({ agentId: agent.value, callClass: callClass.value, status, limit: limit.value });
    }
    case "verify-receipt":
    case "verify-token": {
      const type = chosen.guide === "verify-token" ? "token" : "receipt";
      const artifact = await promptLine(`${type === "token" ? "Token" : "Receipt"}: `, "");
      if (!artifact) return null;
      const issuer = await promptLine("Trusted issuer (https origin): ", process.env.PASSCONTROL_ISSUER || "");
      if (!issuer) return null;
      const audience = type === "token" ? await promptLine("Expected token audience: ", "") : "";
      if (type === "token" && !audience) return null;
      return verificationArgv({ type, artifact, issuer, audience });
    }
    case "suspend":
    case "resume": {
      const suspend = chosen.guide === "suspend";
      const picked = await eligibleAgent(suspend ? "active" : "suspended");
      if (!picked) return null;
      const confirmed = await confirmYes(`${suspend ? "Suspend" : "Resume"} ${picked.label}? [y/N] `, { default: false });
      return confirmed ? agentStateArgv({ suspend, id: picked.value }) : null;
    }
    case "kill": {
      const state = await api("GET", "/kill-switch", undefined, { timeoutMs: 1200 });
      if (state.armed) {
        const confirmed = await confirmYes("Disable the tenant kill switch? [y/N] ", { default: false });
        return killSwitchArgv({ armed: true, confirmed });
      }
      const typed = await promptLine("Type ARM to enable the tenant kill switch: ", "");
      return killSwitchArgv({ armed: false, typed });
    }
    case "key-migrate": {
      const confirmed = await confirmYes("Move the file key into the OS credential store? [y/N] ", { default: false });
      return confirmed ? ["key", "migrate"] : null;
    }
    default:
      return [...chosen.run];
  }
}

async function pauseForSettings() {
  const answer = await promptLine("\nPress Enter to return to Settings, or q to quit: ", "");
  return String(answer).toLowerCase() !== "q";
}

/** Drive one in-memory settings session; no arguments, artifacts, or secrets are retained. */
/**
 * What this machine can actually do, for the groups that ask.
 *
 * `localStack` is true when a PassControl checkout resolves — the surrounding
 * repo, `PASSCONTROL_APP_ROOT`, or a remembered one. An install from npm has
 * none of those, and on that machine the Local stack commands would all fail
 * and `setup` would be an unsolicited invitation to run the server yourself.
 *
 * A THROW counts as true, not false. `resolveAppRootSource` only throws when
 * `PASSCONTROL_APP_ROOT` is set to something that is not a checkout — which is
 * an operator who has deliberately pointed at a local deployment and got the
 * path wrong. Hiding the group would take away `doctor`'s neighbours from
 * exactly the person trying to fix it. Absence of a checkout is the signal;
 * a broken pointer is a self-hoster with a typo.
 */
function menuCapabilities() {
  try {
    return { localStack: resolveAppRootSource() !== null };
  } catch {
    return { localStack: true };
  }
}

async function settingsCommand() {
  const local = menuLocalStatus();
  const staticHeader = menuHeader(local, false);
  const capabilities = menuCapabilities();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    printStatic((text) => process.stdout.write(text), {
      header: staticHeader,
      groups: availableGroups(capabilities),
    });
    return;
  }

  let recentIds = [];
  for (;;) {
    const chosen = await browse({
      header: (remote) => menuHeader(local, remote),
      context: local.current,
      recentIds,
      status: menuRemoteStatus(),
      capabilities,
    });
    if (!chosen) return;

    let argv;
    if (chosen.guide) {
      // A guide only GATHERS input — its first act is a control-plane read, and
      // nothing has been written when that read fails. So the failure costs the
      // answer, not the session. Without this the error escapes settingsCommand
      // entirely and main()'s top-level catch calls process.exit(1) from inside
      // the menu: picking "Governed call logs" with the gateway down ended the
      // whole session with a bare "fetch failed". Unlike the run below, this
      // catch is NOT gated on returnToMenu — no command has run yet, so there is
      // no half-finished write for the session to end on.
      try {
        argv = await guideMenuChoice(chosen);
      } catch (error) {
        fail(error.message);
        if (!(await pauseForSettings())) return;
        continue;
      }
    } else if (chosen.needsArgs) {
      console.log(`\n  ${heading("Command template — nothing was run:")}\n\n    passcontrol ${chosen.detail}\n`);
      if (!(await pauseForSettings())) return;
      continue;
    } else argv = [...chosen.run];
    if (!argv) continue;

    console.log(`\n  ${heading("Running:")} passcontrol ${argv.join(" ")}\n`);
    try {
      await main(argv, { skipUpdate: true });
    } catch (error) {
      if (!chosen.returnToMenu) throw error;
      fail(error.message);
    }
    recentIds = updateRecents(recentIds, chosen);
    if (!chosen.returnToMenu || !(await pauseForSettings())) return;
  }
}

async function main(argv = process.argv.slice(2), runtime = {}) {
  const { opts, rest } = parseArgv(argv);
  const [command, ...commandRest] = rest;

  // Started here and awaited at the very end, so the registry lookup overlaps
  // the command instead of being tacked onto the exit. On anything that touches
  // the network — which is most of this CLI — it costs nothing measurable, and
  // it can never turn a registry outage into a slow `passcontrol call`.
  // .catch() rather than try/catch: an unhandled rejection from a background
  // nicety must not take down a command that already did its job.
  const updateNotice = runtime.skipUpdate ? Promise.resolve(null) : checkForUpdate({
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

  // Bare `passcontrol` opens the browser for a human at a terminal, and keeps
  // printing status for everything else. The TTY guard is what makes this safe
  // to change: scripts, CI and `cli/mcp/gateway.mjs` all reach the old
  // behaviour, because none of them is a terminal. `--json` and `--no-network`
  // are explicit requests for the status output and win over the menu.
  if (command === undefined && !opts.json && !opts.noNetwork && process.stdin.isTTY && process.stdout.isTTY) {
    await settingsCommand();
    await announceUpdate();
    return;
  }

  switch (command) {
    case "settings":
    case "menu": {
      await settingsCommand();
      break;
    }
    case undefined:
    case "status":
      await printCockpit({ noNetwork: Boolean(opts.noNetwork), json: Boolean(opts.json) });
      break;
    case "login":
      // openUrl, never openDashboard: the latter routes a localhost gateway
      // through startDashboard, which clones the self-host repo.
      await loginCommand(opts, { openUrl, promptLine, confirmYes });
      break;
    case "logout":
      await logoutCommand(opts, { confirmYes });
      break;
    case "init":
      await initCommand(opts);
      break;
    case "doctor":
      await doctorCommand(opts);
      break;
    case "start":
      await startLocalCommand(opts);
      break;
    case "stop":
      await stopCommand(opts);
      break;
    case "restart":
      await restartLocalCommand(opts);
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
      // Removed, not silently dropped. `passcontrol try` is named in the help
      // text and README of every published release up to this one, so somebody
      // is following a page that still lists it. `Unknown command "try"` reads
      // as a broken install; this reads as a changelog.
      //
      // CLI_VERSION, never a typed literal — tests/site-metadata.test.ts exists
      // because advertised version strings drift the moment they are hand-written.
      throw new Error(
        `\`passcontrol try\` was removed in ${CLI_VERSION}.\n` +
          "  `passcontrol login` now does the same thing with YOUR agent rather than a\n" +
          "  shared demo one: a governed call and a signed receipt you can verify."
      );
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
    case "statements":
      await statementsCommand(opts);
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
      await keygenCommand(commandRest, opts);
      break;
    case "passport":
      await passportCommand(commandRest, opts);
      break;
    case "key":
      await keyCommand(commandRest, opts);
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
