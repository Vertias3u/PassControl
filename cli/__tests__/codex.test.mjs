// `passcontrol configure codex` routes Codex's model calls through the sidecar
// (1.3.0 #5). Codex reads custom providers only from user-level config: a
// project's `.codex/config.toml` cannot set one, and the old `profile = "..."`
// key is refused (verified 2026-10-07, Codex CLI 0.160.1). So PassControl writes
// a PROFILE FILE, `$CODEX_HOME/passcontrol.config.toml`, which Codex layers over
// config.toml when started with `--profile passcontrol`.
//
// The file is PassControl's own, marked on its first line; config.toml, which the
// Codex app shares, is never opened. A file at that path without the marker is
// someone else's and is not replaced without --force.
import fs from "node:fs";
import { sidecarKey } from "../sidecar-token.mjs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_PROFILE,
  CODEX_PROFILE_MARKER,
  codexProfilePath,
  codexProfileToml,
  codexStoresApiKey,
  removeCodexProfile,
  writeCodexProfile,
} from "../codex.mjs";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-codex-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const BASE = "http://127.0.0.1:8788/api/v1/openai";
// The sidecar's key (review C-03, cli/sidecar-token.mjs) for a fixed test passport.
const KEY = sidecarKey(Buffer.alloc(32, 4).toString("base64url"));

describe("where the profile goes", () => {
  it("is passcontrol.config.toml in ~/.codex, or in CODEX_HOME when set", () => {
    expect(CODEX_PROFILE).toBe("passcontrol");
    expect(codexProfilePath({ env: { HOME: "/h" } })).toBe("/h/.codex/passcontrol.config.toml");
    expect(codexProfilePath({ env: { HOME: "/h", CODEX_HOME: "/c" } })).toBe("/c/passcontrol.config.toml");
  });
});

describe("what it says", () => {
  it("selects a provider at the sidecar's OpenAI address, over the Responses API, with the sidecar's key", () => {
    const toml = codexProfileToml({ sidecarKey: KEY, baseUrl: BASE });
    expect(toml.startsWith(CODEX_PROFILE_MARKER)).toBe(true);
    expect(toml).toContain('model_provider = "passcontrol"');
    expect(toml).toContain("[model_providers.passcontrol]");
    expect(toml).toContain(`base_url = "${BASE}"`);
    expect(toml).toContain('wire_api = "responses"');
    // Review C-03: the sidecar's own key as the provider's bearer token (Codex 0.166
    // sends it as Authorization: Bearer, captured 2026-11-15). Never an OpenAI key,
    // never an env variable, never OpenAI's own auth.
    expect(toml).toContain(`experimental_bearer_token = "${KEY}"`);
    expect(toml).not.toMatch(/env_key|api_key|requires_openai_auth/i);
    expect(() => codexProfileToml({ baseUrl: BASE })).toThrow(/passcontrol login/);
    expect(toml).toContain("codex --profile passcontrol");
  });

  it("leaves the model to Codex's own config unless one is named", () => {
    expect(codexProfileToml({ sidecarKey: KEY, baseUrl: BASE })).not.toMatch(/^model\s*=/m);
    expect(codexProfileToml({ sidecarKey: KEY, baseUrl: BASE, model: "gpt-5-mini" })).toMatch(/^model = "gpt-5-mini"$/m);
  });

  it("writes values as TOML strings, so a quote cannot end one", () => {
    const toml = codexProfileToml({ sidecarKey: KEY, baseUrl: BASE, model: 'x"\nmodel_provider = "openai' });
    expect(toml).toContain('model = "x\\"\\nmodel_provider = \\"openai"');
    expect(toml.match(/^model_provider = /gm)).toHaveLength(1);
  });

  it("refuses an address that is not http(s)", () => {
    expect(() => codexProfileToml({ sidecarKey: KEY, baseUrl: "file:///etc/passwd" })).toThrow(/http/);
    expect(() => codexProfileToml({ sidecarKey: KEY, baseUrl: "not a url" })).toThrow(/http/);
  });
});

describe("writing", () => {
  it("creates the profile, readable by its owner, and leaves config.toml alone", () => {
    const home = path.join(dir, ".codex");
    fs.mkdirSync(home);
    const config = path.join(home, "config.toml");
    fs.writeFileSync(config, 'model = "gpt-6-sol"\n[desktop]\nappearanceTheme = "dark"\n');
    const before = fs.readFileSync(config);
    const target = path.join(home, "passcontrol.config.toml");
    expect(writeCodexProfile({ target, sidecarKey: KEY, baseUrl: BASE })).toEqual({ changed: true, backupPath: null });
    expect(fs.readFileSync(target, "utf8")).toBe(codexProfileToml({ sidecarKey: KEY, baseUrl: BASE }));
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(config)).toEqual(before);
  });

  it("creates CODEX_HOME when Codex has never run", () => {
    const target = path.join(dir, "fresh", "passcontrol.config.toml");
    writeCodexProfile({ target, sidecarKey: KEY, baseUrl: BASE });
    expect(fs.existsSync(target)).toBe(true);
  });

  it("is a no-op when the same profile is already there", () => {
    const target = path.join(dir, "passcontrol.config.toml");
    writeCodexProfile({ target, sidecarKey: KEY, baseUrl: BASE });
    expect(writeCodexProfile({ target, sidecarKey: KEY, baseUrl: BASE })).toEqual({ changed: false, backupPath: null });
    expect(fs.existsSync(`${target}.bak`)).toBe(false);
  });

  it("rewrites its own profile when the address changes, keeping a backup", () => {
    const target = path.join(dir, "passcontrol.config.toml");
    writeCodexProfile({ target, sidecarKey: KEY, baseUrl: BASE });
    const other = "http://127.0.0.1:9000/api/v1/openai";
    expect(writeCodexProfile({ target, sidecarKey: KEY, baseUrl: other })).toEqual({ changed: true, backupPath: `${target}.bak` });
    expect(fs.readFileSync(target, "utf8")).toContain(other);
    expect(fs.readFileSync(`${target}.bak`, "utf8")).toContain(BASE);
  });

  it("does not replace a profile someone else wrote, unless forced", () => {
    const target = path.join(dir, "passcontrol.config.toml");
    fs.writeFileSync(target, 'model_provider = "mine"\n');
    expect(() => writeCodexProfile({ target, sidecarKey: KEY, baseUrl: BASE })).toThrow(/--force/);
    expect(fs.readFileSync(target, "utf8")).toBe('model_provider = "mine"\n');
    expect(writeCodexProfile({ target, sidecarKey: KEY, baseUrl: BASE, force: true }).backupPath).toBe(`${target}.bak`);
    expect(fs.readFileSync(`${target}.bak`, "utf8")).toBe('model_provider = "mine"\n');
  });
});

describe("removing", () => {
  it("removes the profile it wrote", () => {
    const target = path.join(dir, "passcontrol.config.toml");
    writeCodexProfile({ target, sidecarKey: KEY, baseUrl: BASE });
    expect(removeCodexProfile({ target })).toEqual({ changed: true });
    expect(fs.existsSync(target)).toBe(false);
  });

  it("leaves a file it did not write, and a missing one, alone", () => {
    const target = path.join(dir, "passcontrol.config.toml");
    expect(removeCodexProfile({ target })).toEqual({ changed: false });
    fs.writeFileSync(target, 'model_provider = "mine"\n');
    expect(removeCodexProfile({ target })).toEqual({ changed: false });
    expect(fs.readFileSync(target, "utf8")).toBe('model_provider = "mine"\n');
  });
});

// Codex keeps `codex login --api-key` in $CODEX_HOME/auth.json. The PassControl
// profile never sends it (captured: no Authorization header even with a key
// there or in OPENAI_API_KEY), but plain `codex` does, so its presence is worth
// a warning. Presence only: the value is never returned or printed.
describe("a key Codex already stores", () => {
  const write = (text) => fs.writeFileSync(path.join(dir, "auth.json"), text);

  it("is reported when auth.json holds an API key, and only then", () => {
    expect(codexStoresApiKey({ env: { CODEX_HOME: dir } })).toBe(false);
    write(JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "x" } }));
    expect(codexStoresApiKey({ env: { CODEX_HOME: dir } })).toBe(false);
    write(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-test-not-real" }));
    expect(codexStoresApiKey({ env: { CODEX_HOME: dir } })).toBe(true);
  });

  it("is never the value itself, and an unreadable file is not a key", () => {
    write(JSON.stringify({ OPENAI_API_KEY: "sk-test-not-real" }));
    expect(codexStoresApiKey({ env: { CODEX_HOME: dir } })).toBe(true);
    write("not json");
    expect(codexStoresApiKey({ env: { CODEX_HOME: dir } })).toBe(false);
  });
});
