import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_EXPORT_PROTOCOL } from "./protocols.mjs";
import {
  createPassportCredentialStore,
  keyStorageDeclaration,
  resolvePassportKey,
} from "./passport-key-store.mjs";
import { defaultClientModelForProvider } from "./integration-defaults.mjs";

export const CONFIG_FILE = ".passcontrol";

// The version the shipped CLI reports. Read from the installed package.json rather
// than typed anywhere — the MCP server used to carry its own literal and was still
// announcing 0.2.0 to clients at 0.4.0.
export const PACKAGE_VERSION = (() => {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
// The CLI imports snapshots only through the shared protocol declaration. A
// standalone package still has no app dependency, but no longer carries a
// second numeric copy that can drift from system-health capability reporting.
export const WORKSPACE_IMPORT_MAX_VERSION = WORKSPACE_EXPORT_PROTOCOL.maximum;

export const PROVIDERS = ["openai", "anthropic", "groq", "mistral", "together", "deepseek", "gemini"];
export const OPENAI_SHAPE_PROVIDERS = new Set(["openai", "groq", "mistral", "together", "deepseek", "gemini"]);

const DEFAULT_GATEWAY = "http://localhost:3000";

/**
 * The hosted Cloud instance — the one origin this CLI knows by name.
 *
 * Declared HERE, once, because two copies drift: `bin/passcontrol.mjs` had the
 * only literal (as `HOSTED_DEMO_URL`) and now imports this instead.
 *
 * It is NOT the same thing as DEFAULT_GATEWAY above, and the difference matters.
 * DEFAULT_GATEWAY is what an already-configured operator falls back to while
 * working locally. This is where a machine with NO configuration at all should
 * be pointed — which is `passcontrol login` and nothing else, because login is
 * the one command whose whole job is running before any config exists.
 */
export const CLOUD_GATEWAY = "https://passcontrol.vertias.eu";
const DEFAULT_PROVIDER = "anthropic";
const CONFIG_KEYS = [
  "PASSCONTROL_GATEWAY",
  "PASSPORT_ID",
  "PASSPORT_SECRET",
  "PASSPORT_KEY_STORAGE",
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
  yellow: "\x1b[33m",
  heading: "\x1b[1;32m",
  // Two more, for the settings browser's header. Both stay inside the 16-colour
  // set on purpose: nothing in this CLI emits 38;5; or 38;2;, and a lone file
  // that did would look wrong beside the rest and can disappear entirely on a
  // terminal that has not been told its palette.
  lime: "\x1b[92m",   // bright green — the focus and healthy colour
  faint: "\x1b[90m",  // bright black — a second dim level below \x1b[2m
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
  return defaultClientModelForProvider(provider);
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

/**
 * Keys that arrived from a `.passcontrol` FILE rather than the operator's shell.
 *
 * A config file is checked in and travels with a repository, so for anything
 * security-relevant "the environment says so" and "the operator said so" are not
 * the same statement. Recorded at injection time rather than derived afterwards:
 * a key present in BOTH the shell and a file keeps its shell value below, and
 * that value is the operator's — so asking the file later would wrongly disown it.
 */
export const configInjectedKeys = new Set();

export function applyConfigSourcesToEnv({ cwd = process.cwd(), env = process.env } = {}) {
  const sources = loadConfigSources({ cwd, env });
  const merged = {};
  for (const source of sources) Object.assign(merged, source.values);
  for (const [key, value] of Object.entries(merged)) {
    if (env[key] === undefined) {
      env[key] = value;
      configInjectedKeys.add(key);
    }
  }
  return sources;
}

/**
 * Read an environment variable ONLY if the operator set it.
 *
 * For an egress or credential control, a value a cloned repository's
 * `.passcontrol` dropped into the environment must not stand in for a decision
 * the operator made. Everything else — `MODEL`, `SIDECAR_PORT`, `PROMPT` — is
 * still perfectly good to configure from a file and goes on reading `process.env`
 * directly; this is deliberately opt-in per key rather than a blanket filter,
 * because narrowing what a config file may set would break ordinary use.
 */
export function operatorEnv(key, { env = process.env, injected = configInjectedKeys } = {}) {
  return injected.has(key) ? undefined : env[key];
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
  const passportId = process.env.PASSPORT_ID ?? "";
  const fileSecret = process.env.PASSPORT_SECRET ?? "";
  const passportStorageMarker = process.env.PASSPORT_KEY_STORAGE ?? "";
  const fileLabel = operatorEnv("PASSPORT_SECRET") !== undefined
    ? "environment variable"
    : configPathLabel(configSources);
  let passport = null;
  const resolvedPassport = () => {
    passport ??= resolvePassportKey({
      passportId,
      fileSecret,
      fileLabel,
      preferFileSecret: fileLabel === "environment variable" && Boolean(fileSecret),
      storageMarker: passportStorageMarker,
      store: createPassportCredentialStore(),
    });
    return passport;
  };
  return {
    gateway: trimSlash(process.env.PASSCONTROL_GATEWAY ?? DEFAULT_GATEWAY),
    passportId,
    get passportSecret() {
      return resolvedPassport().secret;
    },
    get passportStorage() {
      return resolvedPassport().storage;
    },
    passportStorageMarker,
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

/**
 * Write the whole config. Every ordinary CONFIG_KEY is emitted, so a key absent
 * from `values` is BLANKED — that is correct for `init`, which collects all of
 * them, and wrong for any caller that means to change a subset. The one
 * exception is an unset PASSPORT_KEY_STORAGE marker: omitting it keeps a Tier 0
 * file byte-for-byte in the old shape. Use mergeConfigFile for partial changes.
 *
 * The chmod is not redundant with the `mode` option. Node applies `mode` only
 * when it CREATES the file, so overwriting a config that already exists as 0644
 * leaves it 0644 — and this file holds a passport secret. The directory mode is
 * applied on the global path only: for a project-local `.passcontrol` the
 * dirname is the user's own project directory, and silently 0700-ing that is a
 * surprising thing for a config write to do.
 */
export function writeConfigFile(file, values) {
  const dir = path.dirname(file);
  const isGlobal = path.resolve(file) === path.resolve(globalConfigPath());
  fs.mkdirSync(dir, { recursive: true, ...(isGlobal ? { mode: 0o700 } : {}) });
  const lines = [
    "# PassControl CLI config.",
    "# Keep this file private: it can contain a passport secret.",
    "",
  ];
  for (const key of CONFIG_KEYS) {
    if (key === "PASSPORT_KEY_STORAGE" && !values[key]) continue;
    lines.push(`${key}=${values[key] ?? ""}`);
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  // Explicit, because `mode` above is a no-op on an existing file.
  try {
    fs.chmodSync(file, 0o600);
    if (isGlobal) fs.chmodSync(dir, 0o700);
  } catch {
    // Windows and some network filesystems have no meaningful POSIX mode. A
    // config that is written but not tightened beats a login that dies here.
  }
}

/**
 * Change SOME keys, keeping the rest.
 *
 * `passcontrol login` writes three credential keys. Routing that through
 * writeConfigFile would emit `PROVIDER=`, `MODEL=` and `PASSCONTROL_GATEWAY=`
 * as empty strings and wipe a working setup — right result, wrong side effect,
 * and invisible until the next call failed against the wrong provider.
 */
export function mergeConfigFile(file, patch) {
  let existing = {};
  try {
    existing = readConfigFile(file);
  } catch {
    // No file yet, or unreadable. A first login lands here, and writing the
    // patch alone is exactly right — there is nothing to preserve.
  }
  writeConfigFile(file, { ...existing, ...patch });
}

/** Merge a partial config through a same-directory temporary file and rename.
 * Credential/gateway transitions use this so interruption cannot leave a
 * half-written dotenv file that points a credential at the wrong origin. */
export function mergeConfigFileAtomic(file, patch) {
  let existing = {};
  try {
    existing = readConfigFile(file);
  } catch {
    // First global configuration: the patch is the complete known state.
  }
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
  );
  try {
    writeConfigFile(temporary, { ...existing, ...patch });
    fs.renameSync(temporary, file);
    try {
      fs.chmodSync(file, 0o600);
      fs.chmodSync(directory, 0o700);
    } catch {
      // Same portability rule as writeConfigFile.
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function heading(message = "") {
  return paint(ANSI.heading, message);
}

/**
 * Colour helpers for callers that lay out their own columns.
 *
 * `formatLabel` above owns the label/value shape used by every report. The
 * settings browser's header is a glyph table instead, so it paints its own
 * cells — but it must do so through the same `paint`, which is what keeps
 * NO_COLOR, CI and a piped stdout honoured in one place.
 */
export const accent = (value) => paint(ANSI.lime, value);
export const muted = (value) => paint(ANSI.faint, value);
export const amber = (value) => paint(ANSI.yellow, value);
export const alarm = (value) => paint(ANSI.red, value);

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

// Goes to stdout, not stderr: a warning accompanies work that still succeeded,
// so it must not make a passing command look failed to a caller reading stderr.
export function warn(message = "") {
  console.log(`${paint(ANSI.yellow, "!")} ${message}`);
}

export function die(message) {
  fail(message);
  process.exit(1);
}

export function requirePassport(current = config) {
  assertConfigLoaded();
  const passportSecret = current.passportSecret;
  const storage = current.passportStorage;
  if (!current.passportId || !passportSecret) {
    die(
      storage?.tier === 1 && storage?.available === false
        ? `No passport key available. ${storage.message}.`
        : "No passport configured. Run `passcontrol init`, copy .passcontrol.example to .passcontrol, or pass PASSPORT_ID/PASSPORT_SECRET as env."
    );
  }
  if (storage?.fallback) warn(`Key storage fallback: ${storage.message}.`);
  // Handed out beside the secret so every minting caller declares the tier it
  // actually read from, without any of them deriving it a second time.
  return {
    passportId: current.passportId,
    passportSecret,
    keyStorage: keyStorageDeclaration(storage),
  };
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

/**
 * The only hosts allowed to speak plain HTTP. Exact matches, never a prefix or
 * suffix: `localhost.`, `localhost.example` and `127.0.0.1.attacker.example` are
 * other people's hostnames. Compared against the parsed `hostname`, which the URL
 * parser has already lowercased and canonicalised (`127.1` → `127.0.0.1`), so
 * shorthand loopback spellings land here instead of slipping past a string test.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A value that still carries its own quote characters, explained.
 *
 * `cmd.exe` does not treat `'` as quoting. A Windows operator copying a POSIX
 * invocation out of a README types `--gateway 'http://localhost:3000'` and the
 * CLI receives those quotes as part of the argument — so a value that is right
 * on the line they typed is refused by a message about the string that arrived.
 * The same trap already broke `npm run dev:docker`, which was a bash one-liner
 * in single quotes until cmd handed bash `'set` as its whole command; see the
 * header of `scripts/dev-docker.mjs`.
 *
 * Deliberately a hint and not a repair. The callers below validate values that
 * decide where a credential is sent, and quietly normalizing an argument before
 * a strict rule sees it is how strict rules stop being strict. This only
 * explains the refusal.
 *
 * Returns a sentence to append, or "". It describes the shape and never the
 * value: a gateway URL or a passport id can itself be a credential.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function shellQuotingHint(value) {
  const text = String(value ?? "");
  if (text.length < 2) return "";
  const quote = text[0];
  if ((quote !== "'" && quote !== '"') || text[text.length - 1] !== quote) return "";
  // Only single quotes get the cmd.exe sentence: cmd *does* strip double
  // quotes, so a value that arrives wrapped in them came from a config file or
  // another shell, and naming cmd would send the reader somewhere wrong.
  const cause =
    quote === "'" ? " Windows cmd.exe does not treat ' as quoting and passes it through literally." : "";
  const name = quote === "'" ? "a single quote" : "a double quote";
  return ` The value starts and ends with ${name}, so the quote characters are part of it.${cause} Retype it with no quotes around it.`;
}

/**
 * Validate a gateway value and return the origin to build URLs from.
 *
 * A bare HTTPS origin — scheme, host, optional port — with no path beyond `/`,
 * no query, fragment, username or password. HTTP only on loopback. The value is
 * parsed and the result re-derived from `URL.origin`, so no path material
 * survives into a request URL and `https://trusted.example@attacker.example`
 * cannot pose as the host it imitates.
 *
 * **This is deliberately the same rule as `sdk/gateway.ts`'s
 * `requireGatewayOrigin`, and deliberately a second implementation of it.** The
 * SDK is TypeScript that only becomes JavaScript after `tsc`; `cli/` is plain
 * .mjs run straight from the repository, so importing across that line works in
 * the published package and breaks every CLI invocation in a checkout. The two
 * are held in agreement by `tests/cli-control-gateway.test.ts`, which runs one
 * table through both — if you change one, that test fails until you change both.
 *
 * Throws rather than `die`s: `bin/passcontrol.mjs` has a top-level handler that
 * prints the message and exits 1, and `doctor` catches it to report a failed
 * check instead of vanishing mid-diagnosis. The message never quotes the value,
 * because a rejected gateway can itself carry credentials.
 *
 * The unparseable branch appends `shellQuotingHint`, which the SDK has no reason
 * to carry — it is never handed a cmd.exe argv. That is a message, not a rule:
 * what this accepts and refuses is still identical to the SDK's, which is all
 * the parity test asserts.
 */
export function bareGatewayOrigin(gateway, label = "PASSCONTROL_GATEWAY") {
  let url;
  try {
    url = new URL(String(gateway ?? ""));
  } catch {
    throw new Error(
      `${label} must be an absolute URL (for example https://passcontrol.example.com).` +
        shellQuotingHint(gateway)
    );
  }
  const loopback = LOOPBACK_HOSTNAMES.has(url.hostname);
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      `${label} must be a bare HTTPS origin — scheme, host and optional port, with no path, ` +
        "query, fragment or embedded credentials. Plain HTTP is accepted only for localhost, " +
        "127.0.0.1 and [::1]. The configured value is refused and is not printed here, because " +
        "a gateway URL can itself contain a credential."
    );
  }
  return url.origin;
}

/**
 * The gateway guard for the control plane, beside the key guard above.
 *
 * A `pc_` key is long-lived and manages the whole fleet, so where it is sent is
 * part of the credential's security, not configuration taste. Every `api()` call
 * resolves its destination through this, never through the raw config string.
 */
/**
 * The same origin rule, for probes that carry NO credential.
 *
 * `passcontrol version` reads an unauthenticated /api/version, so the leak the
 * rule normally prevents — a signature or a `pc_` key reaching a host the
 * operator did not choose — does not apply. The destination still has to be
 * validated: a project-local `.passcontrol` pointing elsewhere would make a
 * DIAGNOSTIC command report a stranger's build as your gateway's, which is its
 * own kind of wrong answer, and it would turn `version` into a beacon.
 *
 * Returns null rather than throwing. A malformed gateway is a row in a report
 * here, not a reason to abort the command the operator actually ran.
 */
export function probeGatewayOrigin(current = config) {
  try {
    return bareGatewayOrigin(current.gateway);
  } catch {
    return null;
  }
}

export function requireControlGateway(current = config) {
  assertConfigLoaded();
  return bareGatewayOrigin(current.gateway);
}

/**
 * The same guard for the passport paths — `call`, `try`, `doctor --deep`,
 * `sidecar`, `mcp`.
 *
 * It exists as its own name because the two credentials fail differently, not
 * because the rule differs: it is `bareGatewayOrigin` in both cases, so the two
 * cannot drift. A `pc_` key is long-lived and manages the fleet; what travels
 * here is an Ed25519 challenge signature and the short-lived visa minted from
 * it. That signature is the passport proving itself, and
 * `app/api/auth/challenge/route.ts` binds it to no audience — so a copy taken
 * off the wire replays against the REAL gateway for as long as its `SKEW_MS`
 * window allows, and mints a genuine visa carrying the agent's scope and budget.
 *
 * Which is why this must be called BEFORE the credentials are read, before the
 * signature is computed, and before the destination is echoed to the terminal.
 * Every caller resolves its URLs from the returned origin, never from
 * `config.gateway`; `tests/cli-passport-gateway.test.ts` pins both the ordering
 * and the absence of raw-string interpolation.
 */
export function requirePassportGateway(current = config) {
  assertConfigLoaded();
  return bareGatewayOrigin(current.gateway);
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
