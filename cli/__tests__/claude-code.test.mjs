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
  removeClaudeCodeStatusLine,
  writeClaudeCodeSettings,
  writeClaudeCodeStatusLine,
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

// The budget in Claude Code's status line (1.4.0 candidate 2). Same rules as the
// env keys: the file is the user's, a status line they already have is never
// replaced, and only one this command wrote is ever removed.
describe("the status line", () => {
  const CMD = "passcontrol statusline --port 8788";

  it("adds the status line beside whatever else the file holds", () => {
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, JSON.stringify({ model: "opus", env: { FOO: "1" } }));
    const out = writeClaudeCodeStatusLine({ target, command: CMD });
    expect(out.changed).toBe(true);
    expect(read(target)).toEqual({ model: "opus", env: { FOO: "1" }, statusLine: { type: "command", command: CMD } });
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("is a no-op when it is already there", () => {
    const target = path.join(dir, "settings.json");
    writeClaudeCodeStatusLine({ target, command: CMD });
    expect(writeClaudeCodeStatusLine({ target, command: CMD }).changed).toBe(false);
  });

  it("never replaces a status line the user already has", () => {
    const target = path.join(dir, "settings.json");
    const mine = { type: "command", command: "~/.claude/my-statusline.sh" };
    fs.writeFileSync(target, JSON.stringify({ statusLine: mine }));
    const out = writeClaudeCodeStatusLine({ target, command: CMD });
    expect(out).toEqual({ changed: false, existing: "~/.claude/my-statusline.sh" });
    expect(read(target)).toEqual({ statusLine: mine });
  });

  it("updates its own status line when the port changes", () => {
    const target = path.join(dir, "settings.json");
    writeClaudeCodeStatusLine({ target, command: CMD });
    const out = writeClaudeCodeStatusLine({ target, command: "passcontrol statusline --port 9000" });
    expect(out.changed).toBe(true);
    expect(read(target).statusLine.command).toBe("passcontrol statusline --port 9000");
  });

  it("writes the env keys and the status line in ONE save, so the backup is the user's original", () => {
    const target = path.join(dir, "settings.json");
    const original = { model: "opus" };
    fs.writeFileSync(target, JSON.stringify(original));
    const out = writeClaudeCodeSettings({ target, baseUrl: BASE, statusLineCommand: CMD });
    expect(out.statusLine).toEqual({ changed: true });
    expect(read(target)).toEqual({ model: "opus", env: claudeCodeEnv(BASE), statusLine: { type: "command", command: CMD } });
    expect(read(`${target}.bak`)).toEqual(original);
  });

  it("still writes the env keys when the user's own status line stays", () => {
    const target = path.join(dir, "settings.json");
    const mine = { type: "command", command: "~/.claude/my-statusline.sh" };
    fs.writeFileSync(target, JSON.stringify({ statusLine: mine }));
    const out = writeClaudeCodeSettings({ target, baseUrl: BASE, statusLineCommand: CMD });
    expect(out.statusLine).toEqual({ changed: false, existing: "~/.claude/my-statusline.sh" });
    expect(read(target)).toEqual({ statusLine: mine, env: claudeCodeEnv(BASE) });
  });

  it("--remove takes both out in one save, keeping the backup as it was before", () => {
    const target = path.join(dir, "settings.json");
    writeClaudeCodeSettings({ target, baseUrl: BASE, statusLineCommand: CMD });
    const before = read(target);
    expect(removeClaudeCodeSettings({ target }).changed).toBe(true);
    expect(read(target)).toEqual({});
    expect(read(`${target}.bak`)).toEqual(before);
  });

  it("removes only a status line it wrote", () => {
    const target = path.join(dir, "settings.json");
    writeClaudeCodeStatusLine({ target, command: CMD });
    expect(removeClaudeCodeStatusLine({ target }).changed).toBe(true);
    expect(read(target)).toEqual({});
    const mine = { type: "command", command: "~/.claude/my-statusline.sh" };
    fs.writeFileSync(target, JSON.stringify({ statusLine: mine }));
    expect(removeClaudeCodeStatusLine({ target }).changed).toBe(false);
    expect(read(target)).toEqual({ statusLine: mine });
  });
});

// ── Subscription mode ─────────────────────────────────────────────────────────
//
// A Pro/Max login talks to Anthropic directly, and Anthropic's terms forbid
// intermediating it, so this mode never sets ANTHROPIC_BASE_URL. It writes, in the
// USER settings (Claude Code ignores telemetry settings in a project's file):
//   * Claude Code's OpenTelemetry log export, pointed at the sidecar (the SEEN rows);
//   * three http hooks to the sidecar's stop gate;
//   * the status line, which carries the usage window;
//   * PASSCONTROL_SIDECAR_URL, so `/passcontrol` finds the sidecar.
// Anything of the user's own is kept, and their own telemetry is not hijacked.
import { removeClaudeCodeSubscription, subscriptionEnv, subscriptionHooks, writeClaudeCodeSubscription } from "../claude-code.mjs";

describe("subscription mode", () => {
  const STATUS = "passcontrol statusline --port 8788";
  const target = () => path.join(dir, "settings.json");
  const write = (extra = {}) => writeClaudeCodeSubscription({ target: target(), port: 8788, statusLineCommand: STATUS, ...extra });

  it("writes telemetry to the sidecar, the three hooks, the status line and the sidecar's address, and no base URL", () => {
    const out = write();
    expect(out).toMatchObject({ changed: true, backupPath: null });
    const s = read(target());
    expect(s.env).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:8788/_passcontrol/otlp/v1/logs",
      OTEL_LOGS_EXPORT_INTERVAL: "1000",
      PASSCONTROL_SIDECAR_URL: "http://127.0.0.1:8788",
    });
    expect(s.env).toEqual(subscriptionEnv(8788));
    const hook = { type: "http", url: "http://127.0.0.1:8788/_passcontrol/hook", timeout: 5 };
    // PreToolUse may wait for the owner's yes (Phase 2), and a timed-out http hook lets
    // the tool RUN: it gets Claude Code's 600 s, and tells the sidecar so in its URL.
    const toolHook = { type: "http", url: "http://127.0.0.1:8788/_passcontrol/hook?t=600", timeout: 600 };
    expect(s.hooks).toEqual({
      UserPromptSubmit: [{ hooks: [hook] }],
      PreToolUse: [{ matcher: "*", hooks: [toolHook] }],
      PostToolBatch: [{ hooks: [hook] }],
    });
    expect(s.hooks).toEqual(subscriptionHooks(8788));
    expect(s.statusLine).toEqual({ type: "command", command: STATUS });
    expect(JSON.stringify(s)).not.toContain("ANTHROPIC_BASE_URL");
    expect(fs.statSync(target()).mode & 0o777).toBe(0o600);
  });

  it("keeps the user's own hooks, env and settings, and backs the file up", () => {
    const mine = { type: "command", command: "./lint.sh" };
    fs.writeFileSync(target(), JSON.stringify({ model: "opus", env: { FOO: "1" }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [mine] }], Stop: [{ hooks: [mine] }] } }));
    const out = write();
    expect(out.backupPath).toBe(`${target()}.bak`);
    const s = read(target());
    expect(s.model).toBe("opus");
    expect(s.env.FOO).toBe("1");
    expect(s.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [mine] }, ...subscriptionHooks(8788).PreToolUse]);
    expect(s.hooks.Stop).toEqual([{ hooks: [mine] }]);
  });

  it("changes nothing the second time", () => {
    write();
    expect(write()).toMatchObject({ changed: false, backupPath: null });
    expect(read(target()).hooks.PreToolUse).toHaveLength(1);
  });

  it("moves to a new port instead of adding a second set of hooks", () => {
    write();
    write({ port: 8790, statusLineCommand: "passcontrol statusline --port 8790" });
    const s = read(target());
    expect(s.hooks).toEqual(subscriptionHooks(8790));
    expect(s.env).toEqual(subscriptionEnv(8790));
    expect(s.statusLine.command).toBe("passcontrol statusline --port 8790");
  });

  it("rewrites a Phase 1 install's 5 s PreToolUse hook to the long one, in place", () => {
    const old = { type: "http", url: "http://127.0.0.1:8788/_passcontrol/hook", timeout: 5 };
    const mine = { type: "command", command: "./lint.sh" };
    fs.writeFileSync(
      target(),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [old] }],
          PreToolUse: [{ matcher: "Bash", hooks: [mine] }, { matcher: "*", hooks: [old] }],
          PostToolBatch: [{ hooks: [old] }],
        },
      })
    );
    expect(write()).toMatchObject({ changed: true });
    const s = read(target());
    expect(s.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [mine] }, ...subscriptionHooks(8788).PreToolUse]);
    expect(s.hooks.UserPromptSubmit).toEqual(subscriptionHooks(8788).UserPromptSubmit);
  });

  it("says when an allowlist admits the old hook URL but not the tool hook's", () => {
    fs.writeFileSync(target(), JSON.stringify({ allowedHttpHookUrls: ["http://127.0.0.1:*/_passcontrol/hook"] }));
    expect(write().hookUrlsBlocked).toBe(true);
    fs.writeFileSync(target(), JSON.stringify({ allowedHttpHookUrls: ["http://127.0.0.1:*/_passcontrol/hook*"] }));
    expect(write().hookUrlsBlocked).toBe(false);
  });

  it("refuses to take over telemetry the user already sends somewhere else, unless forced", () => {
    fs.writeFileSync(target(), JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_LOGS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com" } }));
    expect(() => write()).toThrow(/OTEL_LOGS_EXPORTER.*--force/s);
    expect(read(target()).hooks).toBeUndefined();
    write({ force: true });
    expect(read(target()).env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe("http://127.0.0.1:8788/_passcontrol/otlp/v1/logs");
    expect(read(target()).env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe("https://otel.example.com");
  });

  it("leaves the user's own metrics export alone", () => {
    fs.writeFileSync(target(), JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_METRICS_EXPORTER: "otlp" } }));
    write();
    expect(read(target()).env.OTEL_METRICS_EXPORTER).toBe("otlp");
  });

  it("names a status line the user already has and keeps it", () => {
    fs.writeFileSync(target(), JSON.stringify({ statusLine: { type: "command", command: "~/my-line.sh" } }));
    const out = write();
    expect(out.statusLine).toEqual({ changed: false, existing: "~/my-line.sh" });
    expect(read(target()).statusLine.command).toBe("~/my-line.sh");
  });

  it("says when an allowlist of hook URLs would stop the hooks from running", () => {
    fs.writeFileSync(target(), JSON.stringify({ allowedHttpHookUrls: ["https://hooks.example.com/*"] }));
    expect(write().hookUrlsBlocked).toBe(true);
  });

  it("says when the same file also routes Claude Code through the sidecar with an API key", () => {
    fs.writeFileSync(target(), JSON.stringify({ env: claudeCodeEnv(BASE) }));
    expect(write().routed).toBe(true);
  });

  describe("removing", () => {
    it("takes out exactly what it wrote and leaves the rest as it was", () => {
      const mine = { type: "command", command: "./lint.sh" };
      const before = { model: "opus", env: { FOO: "1" }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [mine] }] } };
      fs.writeFileSync(target(), JSON.stringify(before));
      write();
      expect(removeClaudeCodeSubscription({ target: target() })).toEqual({ changed: true });
      expect(read(target())).toEqual(before);
    });

    it("keeps the telemetry switch when the user still exports metrics", () => {
      fs.writeFileSync(target(), JSON.stringify({ env: { OTEL_METRICS_EXPORTER: "otlp" } }));
      write();
      removeClaudeCodeSubscription({ target: target() });
      expect(read(target()).env).toEqual({ OTEL_METRICS_EXPORTER: "otlp", CLAUDE_CODE_ENABLE_TELEMETRY: "1" });
    });

    it("leaves a logs export that points somewhere else", () => {
      const env = { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_LOGS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://otel.example.com/v1/logs" };
      fs.writeFileSync(target(), JSON.stringify({ env }));
      expect(removeClaudeCodeSubscription({ target: target() })).toEqual({ changed: false });
      expect(read(target()).env).toEqual(env);
    });

    it("does nothing to a missing file", () => {
      expect(removeClaudeCodeSubscription({ target: target() })).toEqual({ changed: false });
      expect(fs.existsSync(target())).toBe(false);
    });
  });
});
