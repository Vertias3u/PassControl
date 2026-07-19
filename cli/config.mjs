import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_FILE = ".passcontrol";
export const PROVIDERS = ["openai", "anthropic", "groq", "mistral", "together", "deepseek"];
export const OPENAI_SHAPE_PROVIDERS = new Set(["openai", "groq", "mistral", "together", "deepseek"]);

const DEFAULT_GATEWAY = "http://localhost:3000";
const DEFAULT_PROVIDER = "anthropic";
const CONFIG_KEYS = [
  "PASSCONTROL_GATEWAY",
  "PASSPORT_ID",
  "PASSPORT_SECRET",
  "PASSCONTROL_API_KEY",
  "PROVIDER",
  "MODEL",
];

const trimSlash = (value) => String(value ?? "").replace(/\/+$/, "");
const ANSI = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
  heading: "\x1b[1;32m",
};

function paint(code, value) {
  if (
    process.stdout.isTTY !== true ||
    process.env.NO_COLOR !== undefined ||
    process.env.CI
  ) {
    return String(value);
  }
  return `${code}${value}${ANSI.reset}`;
}

export function defaultModelForProvider(provider) {
  switch (provider) {
    case "openai":
      return "gpt-4o-mini";
    case "groq":
      return "llama-3.1-8b-instant";
    case "mistral":
      return "mistral-small-latest";
    case "together":
      return "openai/gpt-oss-20b";
    case "deepseek":
      return "deepseek-chat";
    case "anthropic":
    default:
      return "claude-haiku-4-5";
  }
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseDotenv(text, source = CONFIG_FILE) {
  const values = {};
  for (const [i, rawLine] of text.split(/\r?\n/).entries()) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const line = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const eq = line.indexOf("=");
    if (eq === -1) throw new Error(`Invalid ${source} line ${i + 1}: expected KEY=value.`);

    const key = line.slice(0, eq).trim();
    const value = unquote(line.slice(eq + 1).trim());
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid ${source} line ${i + 1}: bad env var name "${key}".`);
    }
    values[key] = value;
  }
  return values;
}

function readConfigFile(file) {
  return parseDotenv(fs.readFileSync(file, "utf8"), file);
}

export function globalConfigPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "passcontrol", "config");
}

export function findProjectConfig(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(candidate)) return candidate;

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function loadConfigSources({ cwd = process.cwd(), env = process.env } = {}) {
  const sources = [];
  const globalPath = globalConfigPath(env);
  const projectPath = findProjectConfig(cwd);

  if (fs.existsSync(globalPath)) {
    sources.push({ type: "global", path: globalPath, values: readConfigFile(globalPath) });
  }
  if (projectPath) {
    sources.push({ type: "project", path: projectPath, values: readConfigFile(projectPath) });
  }
  return sources;
}

export function applyConfigSourcesToEnv({ cwd = process.cwd(), env = process.env } = {}) {
  const sources = loadConfigSources({ cwd, env });
  const merged = {};
  for (const source of sources) Object.assign(merged, source.values);
  for (const [key, value] of Object.entries(merged)) {
    if (env[key] === undefined) env[key] = value;
  }
  return sources;
}

export let configLoadError = null;
export let configSources = [];

try {
  configSources = applyConfigSourcesToEnv();
} catch (error) {
  configLoadError = error;
}

export function assertConfigLoaded() {
  if (configLoadError) throw configLoadError;
}

export function resolveModel(provider) {
  return process.env.MODEL ?? defaultModelForProvider(provider);
}

export function resolvedConfig() {
  assertConfigLoaded();
  return currentConfig();
}

function currentConfig() {
  const provider = process.env.PROVIDER ?? DEFAULT_PROVIDER;
  return {
    gateway: trimSlash(process.env.PASSCONTROL_GATEWAY ?? DEFAULT_GATEWAY),
    passportId: process.env.PASSPORT_ID ?? "",
    passportSecret: process.env.PASSPORT_SECRET ?? "",
    apiKey: process.env.PASSCONTROL_API_KEY ?? "",
    provider,
    model: resolveModel(provider),
    sources: configSources,
  };
}

export const config = currentConfig();

export function configPathLabel(sources = configSources) {
  const project = sources.find((source) => source.type === "project");
  const global = sources.find((source) => source.type === "global");
  if (project) return project.path;
  if (global) return global.path;
  return "none";
}

export function writeConfigFile(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    "# PassControl CLI config.",
    "# Keep this file private: it can contain a passport secret.",
    "",
  ];
  for (const key of CONFIG_KEYS) {
    lines.push(`${key}=${values[key] ?? ""}`);
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
}

export function heading(message = "") {
  return paint(ANSI.heading, message);
}

export function formatLabel(label, value, width = 11) {
  return `${paint(ANSI.cyan, `${label}:`.padEnd(width))}${value}`;
}

export function step(message = "") {
  console.log(`${paint(ANSI.cyan, "→")} ${message}`);
}

export function ok(message = "") {
  console.log(`${paint(ANSI.green, "✓")} ${message}`);
}

export function fail(message = "") {
  console.error(`${paint(ANSI.red, "✗")} ${message}`);
}

export function die(message) {
  fail(message);
  process.exit(1);
}

export function requirePassport(current = config) {
  assertConfigLoaded();
  if (!current.passportId || !current.passportSecret) {
    die(
      "No passport configured. Run `passcontrol init`, copy .passcontrol.example to .passcontrol, or pass PASSPORT_ID/PASSPORT_SECRET as env."
    );
  }
  return { passportId: current.passportId, passportSecret: current.passportSecret };
}

export function requireControlApiKey(current = config) {
  assertConfigLoaded();
  if (!current.apiKey) {
    die(
      "No control-plane API key configured. Run `passcontrol init`, set PASSCONTROL_API_KEY in .passcontrol, or pass it as env."
    );
  }
  return current.apiKey;
}

export function redact(value, keep = 4) {
  if (!value) return "missing";
  const s = String(value);
  if (s.length <= keep) return "configured";
  return `configured (...${s.slice(-keep)})`;
}

export function formatChallengeError(status, body) {
  const detail = String(body ?? "").trim();
  if (status === 403 && detail.includes("agent_not_active")) {
    return "Challenge failed: this agent is suspended or revoked. Re-enable it in the dashboard, or run `passcontrol agent resume <id>`.";
  }
  if (status === 401) {
    return `Challenge failed: 401 ${detail}. Check PASSPORT_ID/PASSPORT_SECRET, then retry.`;
  }
  return `Challenge failed: ${status} ${detail}`;
}

export function formatProxyError(status, body) {
  const detail = String(body ?? "").trim();
  if (status === 402) {
    return `Proxy blocked the call with 402: ${detail}\n→ Fix: raise or clear the agent budget in the dashboard, then retry.`;
  }
  if (status === 403) {
    return `Proxy blocked the call with 403: ${detail}\n→ Fix: check the agent scope, suspend/revoke state, and kill switch.`;
  }
  return `Proxy error ${status}: ${detail}`;
}
