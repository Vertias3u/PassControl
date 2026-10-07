// `passcontrol configure claude-code` routes Claude Code's OWN model calls
// through the sidecar, not only the MCP chat tool. Claude Code reads an `env`
// block from its settings files wherever it is started (verified 2026-10-07,
// Claude Code 2.1.292): ANTHROPIC_BASE_URL points it at the sidecar, and
// ANTHROPIC_AUTH_TOKEN, a placeholder, is sent as a Bearer token with no prompt.
// The sidecar strips it; the gateway injects the real key.
//
// The file is the user's. Only these two keys are ever written or removed, the
// previous file is backed up, and a different gateway already configured there is
// not replaced without --force.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_AUTH_PLACEHOLDER,
  claudeCodeEnv,
  claudeCodeSettingsPath,
  removeClaudeCodeSettings,
  writeClaudeCodeSettings,
} from "../claude-code.mjs";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-claude-code-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const BASE = "http://127.0.0.1:8788/api/v1/anthropic";
const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

describe("where the settings go", () => {
  it("defaults to this project's settings.local.json, which Claude Code keeps out of git", () => {
    expect(claudeCodeSettingsPath({ scope: "project", cwd: "/work/app", env: {} })).toBe("/work/app/.claude/settings.local.json");
  });

  it("--global writes the user settings, honouring CLAUDE_CONFIG_DIR", () => {
    expect(claudeCodeSettingsPath({ scope: "user", cwd: "/x", env: { HOME: "/h" } })).toBe("/h/.claude/settings.json");
    expect(claudeCodeSettingsPath({ scope: "user", cwd: "/x", env: { HOME: "/h", CLAUDE_CONFIG_DIR: "/c" } })).toBe("/c/settings.json");
  });
});

describe("writing", () => {
  it("creates the file with only the two keys, readable by its owner", () => {
    const target = path.join(dir, ".claude", "settings.local.json");
    const out = writeClaudeCodeSettings({ target, baseUrl: BASE });
    expect(out).toEqual({ changed: true, backupPath: null, rawKeyFound: false });
    expect(read(target)).toEqual({ env: claudeCodeEnv(BASE) });
    expect(claudeCodeEnv(BASE)).toEqual({ ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: CLAUDE_CODE_AUTH_PLACEHOLDER });
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("keeps everything else in the file and backs it up first", () => {
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, JSON.stringify({ model: "opus", env: { FOO: "1" }, permissions: { allow: ["Read"] } }));
    const out = writeClaudeCodeSettings({ target, baseUrl: BASE });
    expect(out.backupPath).toBe(`${target}.bak`);
    expect(read(target)).toEqual({ model: "opus", permissions: { allow: ["Read"] }, env: { FOO: "1", ...claudeCodeEnv(BASE) } });
    expect(read(`${target}.bak`)).toEqual({ model: "opus", env: { FOO: "1" }, permissions: { allow: ["Read"] } });
  });

  it("does nothing when it is already configured", () => {
    const target = path.join(dir, "settings.json");
    writeClaudeCodeSettings({ target, baseUrl: BASE });
    expect(writeClaudeCodeSettings({ target, baseUrl: BASE })).toEqual({ changed: false, backupPath: null, rawKeyFound: false });
  });

  it("refuses to replace a different gateway without force", () => {
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://litellm.example" } }));
    expect(() => writeClaudeCodeSettings({ target, baseUrl: BASE })).toThrow(/already points Claude Code at https:\/\/litellm.example/);
    writeClaudeCodeSettings({ target, baseUrl: BASE, force: true });
    expect(read(target).env.ANTHROPIC_BASE_URL).toBe(BASE);
  });

  it("reports a raw ANTHROPIC_API_KEY left in the file, and leaves it alone", () => {
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-left-behind" } }));
    expect(writeClaudeCodeSettings({ target, baseUrl: BASE }).rawKeyFound).toBe(true);
    expect(read(target).env.ANTHROPIC_API_KEY).toBe("sk-ant-left-behind");
  });

  it("refuses a file that is not a JSON object rather than overwriting it", () => {
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, "{ not json");
    expect(() => writeClaudeCodeSettings({ target, baseUrl: BASE })).toThrow(/not valid JSON/);
    expect(fs.readFileSync(target, "utf8")).toBe("{ not json");
  });
});

describe("removing", () => {
  it("removes only PassControl's two keys", () => {
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, JSON.stringify({ model: "opus", env: { FOO: "1" } }));
    writeClaudeCodeSettings({ target, baseUrl: BASE });
    expect(removeClaudeCodeSettings({ target })).toEqual({ changed: true });
    expect(read(target)).toEqual({ model: "opus", env: { FOO: "1" } });
  });

  it("drops an env block it emptied", () => {
    const target = path.join(dir, "settings.json");
    writeClaudeCodeSettings({ target, baseUrl: BASE });
    removeClaudeCodeSettings({ target });
    expect(read(target)).toEqual({});
  });

  it("leaves a gateway it did not write", () => {
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://litellm.example", ANTHROPIC_AUTH_TOKEN: "theirs" } }));
    expect(removeClaudeCodeSettings({ target })).toEqual({ changed: false });
    expect(read(target).env.ANTHROPIC_BASE_URL).toBe("https://litellm.example");
  });

  it("is a no-op when there is no file", () => {
    expect(removeClaudeCodeSettings({ target: path.join(dir, "missing.json") })).toEqual({ changed: false });
  });
});
