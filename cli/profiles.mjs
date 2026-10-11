// Named profiles: one identity per coding tool (1.4.0 candidate 4, owner 2026-10-10;
// design plans/one-identity-per-tool.md).
//
// A profile is a config file at <config dir>/profiles/<name>, in the global config's
// format, holding a passport and the sidecar port it serves. It holds a passport
// SECRET, so it gets the same protection: a 0700 directory, a 0600 file, and nothing
// in this module ever prints a value.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The port each coding tool's dedicated sidecar serves. 8788 stays the shared default. */
export const TOOL_PROFILE_PORTS = { "claude-code": 8790, codex: 8791 };

export function profilesDir(env = process.env) {
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "passcontrol", "profiles");
}

export function profilePath(name, env = process.env) {
  if (typeof name !== "string" || !PROFILE_NAME_RE.test(name)) {
    throw new Error(`Invalid profile name ${JSON.stringify(String(name)).slice(0, 48)}: use lowercase letters, digits and dashes (up to 32).`);
  }
  return path.join(profilesDir(env), name);
}

function parse(text) {
  const values = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

/** The profile's values, or null when it does not exist. */
export function readProfile(name, env = process.env) {
  const file = profilePath(name, env);
  if (!fs.existsSync(file)) return null;
  return parse(fs.readFileSync(file, "utf8"));
}

/** Merge values into a profile, creating it (and its directory) owner-only. */
export function writeProfile(name, values, env = process.env) {
  const file = profilePath(name, env);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const merged = { ...(readProfile(name, env) ?? {}), ...values };
  const body =
    "# PassControl profile. Keep this file private: it holds a passport secret.\n" +
    Object.entries(merged)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") +
    "\n";
  fs.writeFileSync(file, body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** Every profile's name, passport id and port; never a secret. */
export function listProfiles(env = process.env) {
  const dir = profilesDir(env);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => PROFILE_NAME_RE.test(name))
    .sort()
    .map((name) => {
      const v = readProfile(name, env) ?? {};
      return { name, passportId: v.PASSPORT_ID ?? "", port: v.SIDECAR_PORT ?? "" };
    });
}

/**
 * The profile this process was asked to use: `--profile <name>` on the command line,
 * or PASSCONTROL_PROFILE from the OPERATOR's shell. Read before any config file is
 * merged into the environment, so a project's `.passcontrol` cannot choose which
 * identity this machine speaks as.
 */
export function selectedProfile(argv = process.argv, env = process.env) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--profile") return argv[i + 1] ?? "";
    if (arg.startsWith("--profile=")) return arg.slice("--profile=".length);
  }
  return env.PASSCONTROL_PROFILE ?? null;
}
