// Route Codex's own model calls through the PassControl sidecar.
//
// Codex takes a custom model provider only from user-level config: a project's
// `.codex/config.toml` cannot set one, and the old `profile = "..."` selector is
// refused (verified 2026-10-07, Codex CLI 0.160.1). So this writes a profile file,
// `$CODEX_HOME/passcontrol.config.toml`, which Codex layers over config.toml when
// started with `codex --profile passcontrol`. With no key configured for the
// provider, Codex sends no Authorization header at all (captured); the sidecar
// adds the agent's credential and the gateway injects the real OpenAI key.
//
// config.toml is never opened: the Codex app shares it, and PassControl would
// need a TOML parser to edit it safely. The profile file is PassControl's own,
// marked on its first line, so a file at that path without the marker is someone
// else's and is not replaced without --force, nor ever removed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CODEX_PROFILE = "passcontrol";
export const CODEX_PROFILE_MARKER = "# Written by `passcontrol configure codex`.";

function codexHome(env) {
  return env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex");
}

export function codexProfilePath({ env = process.env } = {}) {
  return path.join(codexHome(env), `${CODEX_PROFILE}.config.toml`);
}

/**
 * Whether Codex keeps an OpenAI API key of its own (`codex login --api-key`, in
 * auth.json). The profile never sends it, but plain `codex` does. True or false
 * only: the value is never returned, and an unreadable file counts as no key.
 */
export function codexStoresApiKey({ env = process.env } = {}) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(codexHome(env), "auth.json"), "utf8"));
    return typeof auth?.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.length > 0;
  } catch {
    return false;
  }
}

// A TOML basic string. JSON's escapes (\" \\ \n \uXXXX …) are all valid TOML
// escapes, so a value cannot close its string and start a key of its own.
const tomlString = (value) => JSON.stringify(String(value));

export function codexProfileToml({ baseUrl, model }) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    url = null;
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error(`The sidecar address must be an http(s) URL, not ${JSON.stringify(String(baseUrl))}.`);
  }
  return [
    CODEX_PROFILE_MARKER,
    `# Use it with: codex --profile ${CODEX_PROFILE}`,
    "# Codex's model calls go to the PassControl sidecar, which must be running. No OpenAI",
    "# key belongs here: the gateway adds the real one. Undo: passcontrol configure codex --remove",
    ...(model ? [`model = ${tomlString(model)}`] : []),
    `model_provider = ${tomlString(CODEX_PROFILE)}`,
    "",
    `[model_providers.${CODEX_PROFILE}]`,
    'name = "PassControl"',
    `base_url = ${tomlString(baseUrl)}`,
    'wire_api = "responses"',
    "",
  ].join("\n");
}

const isOurs = (text) => text.startsWith(CODEX_PROFILE_MARKER);

export function writeCodexProfile({ target, baseUrl, model, force = false }) {
  const next = codexProfileToml({ baseUrl, model });
  const exists = fs.existsSync(target);
  let backupPath = null;
  if (exists) {
    const current = fs.readFileSync(target, "utf8");
    if (current === next) return { changed: false, backupPath: null };
    if (!isOurs(current) && !force) {
      throw new Error(
        `${target} exists and was not written by PassControl. Re-run with --force to replace it (a backup is kept).`
      );
    }
    backupPath = `${target}.bak`;
    fs.copyFileSync(target, backupPath);
    fs.chmodSync(backupPath, 0o600);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, next, { mode: 0o600 });
  fs.chmodSync(target, 0o600);
  return { changed: true, backupPath };
}

export function removeCodexProfile({ target }) {
  if (!fs.existsSync(target) || !isOurs(fs.readFileSync(target, "utf8"))) return { changed: false };
  fs.rmSync(target);
  return { changed: true };
}
