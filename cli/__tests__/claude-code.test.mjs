// `passcontrol configure claude-code` routes Claude Code's OWN model calls
// through the sidecar, not only the MCP chat tool. Claude Code reads an `env`
// block from its settings files wherever it is started (verified 2026-10-07,
// Claude Code 2.1.292): ANTHROPIC_BASE_URL points it at the sidecar, and
// ANTHROPIC_AUTH_TOKEN, the sidecar's own key (review C-03), is sent as a Bearer
// token with no prompt. The sidecar strips it; the gateway injects the real key.
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
import { sidecarKey } from "../sidecar-token.mjs";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-claude-code-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const BASE = "http://127.0.0.1:8788/api/v1/anthropic";
// The sidecar's key (review C-03, cli/sidecar-token.mjs) for a fixed test passport.
const KEY = sidecarKey(Buffer.alloc(32, 3).toString("base64url"));
// What each hook of ours carries since the sidecar's own paths ask for the key (C-03 follow-up).
const KEY_HEADERS = { Authorization: `Bearer ${KEY}` };
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

describe("settings an older version wrote (review C-03)", () => {
  it("replaces the old public placeholder with the sidecar's key", () => {
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, JSON.stringify({ env: { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: CLAUDE_CODE_AUTH_PLACEHOLDER } }));
    expect(writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY }).changed).toBe(true);
    expect(read(target).env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
  });

  it("still removes the old placeholder, and refuses to write without a key", () => {
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, JSON.stringify({ model: "opus", env: { ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: CLAUDE_CODE_AUTH_PLACEHOLDER } }));
    removeClaudeCodeSettings({ target });
    expect(read(target)).toEqual({ model: "opus" });
    expect(() => writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: "run-passcontrol-login-first" })).toThrow(/passcontrol login/);
  });
});

describe("writing", () => {
  it("creates the file with env keys and the tool hook, readable by its owner", () => {
    const target = path.join(dir, ".claude", "settings.local.json");
    const out = writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY });
    expect(out).toEqual({ changed: true, backupPath: null, rawKeyFound: false });
    expect(read(target)).toEqual({ env: claudeCodeEnv(BASE, KEY), hooks: { PreToolUse: apiTools() } });
    // Review C-03: the sidecar's own key, not the old public placeholder.
    expect(claudeCodeEnv(BASE, KEY)).toEqual({ ANTHROPIC_BASE_URL: BASE, ANTHROPIC_AUTH_TOKEN: KEY });
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it("keeps everything else in the file and backs it up first", () => {
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, JSON.stringify({ model: "opus", env: { FOO: "1" }, permissions: { allow: ["Read"] } }));
    const out = writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY });
    expect(out.backupPath).toBe(`${target}.bak`);
    expect(read(target)).toEqual({ model: "opus", permissions: { allow: ["Read"] }, env: { FOO: "1", ...claudeCodeEnv(BASE, KEY) }, hooks: { PreToolUse: apiTools() } });
    expect(read(`${target}.bak`)).toEqual({ model: "opus", env: { FOO: "1" }, permissions: { allow: ["Read"] } });
  });

  it("does nothing when it is already configured", () => {
    const target = path.join(dir, "settings.json");
    writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY });
    expect(writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY })).toEqual({ changed: false, backupPath: null, rawKeyFound: false });
  });

  it("refuses to replace a different gateway without force", () => {
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://litellm.example" } }));
    expect(() => writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY })).toThrow(/already points Claude Code at https:\/\/litellm.example/);
    writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY, force: true });
    expect(read(target).env.ANTHROPIC_BASE_URL).toBe(BASE);
  });

  it("reports a raw ANTHROPIC_API_KEY left in the file, and leaves it alone", () => {
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-left-behind" } }));
    expect(writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY }).rawKeyFound).toBe(true);
    expect(read(target).env.ANTHROPIC_API_KEY).toBe("sk-ant-left-behind");
  });

  it("refuses a file that is not a JSON object rather than overwriting it", () => {
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, "{ not json");
    expect(() => writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY })).toThrow(/not valid JSON/);
    expect(fs.readFileSync(target, "utf8")).toBe("{ not json");
  });
});

describe("removing", () => {
  it("removes only PassControl's two keys", () => {
    const target = path.join(dir, "settings.json");
    fs.writeFileSync(target, JSON.stringify({ model: "opus", env: { FOO: "1" } }));
    writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY });
    expect(removeClaudeCodeSettings({ target })).toEqual({ changed: true });
    expect(read(target)).toEqual({ model: "opus", env: { FOO: "1" } });
  });

  it("drops an env block it emptied", () => {
    const target = path.join(dir, "settings.json");
    writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY });
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
    const out = writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY, statusLineCommand: CMD });
    expect(out.statusLine).toEqual({ changed: true });
    expect(read(target)).toEqual({ model: "opus", env: claudeCodeEnv(BASE, KEY), hooks: { PreToolUse: apiTools() }, statusLine: { type: "command", command: CMD } });
    expect(read(`${target}.bak`)).toEqual(original);
  });

  it("still writes the env keys when the user's own status line stays", () => {
    const target = path.join(dir, "settings.json");
    const mine = { type: "command", command: "~/.claude/my-statusline.sh" };
    fs.writeFileSync(target, JSON.stringify({ statusLine: mine }));
    const out = writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY, statusLineCommand: CMD });
    expect(out.statusLine).toEqual({ changed: false, existing: "~/.claude/my-statusline.sh" });
    expect(read(target)).toEqual({ statusLine: mine, env: claudeCodeEnv(BASE, KEY), hooks: { PreToolUse: apiTools() } });
  });

  it("--remove takes both out in one save, keeping the backup as it was before", () => {
    const target = path.join(dir, "settings.json");
    writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY, statusLineCommand: CMD });
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
  const write = (extra = {}) => writeClaudeCodeSubscription({ target: target(), sidecarKey: KEY, port: 8788, statusLineCommand: STATUS, ...extra });

  it("writes telemetry to the sidecar, the three hooks, the status line and the sidecar's address, and no base URL", () => {
    const out = write();
    expect(out).toMatchObject({ changed: true, backupPath: null });
    const s = read(target());
    expect(s.env).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: "1",
      OTEL_LOGS_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:8788/_passcontrol/otlp/v1/logs",
      // The receiver asks for the sidecar's key (review C-03 follow-up).
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: `Authorization=Bearer ${KEY}`,
      OTEL_LOGS_EXPORT_INTERVAL: "1000",
      PASSCONTROL_SIDECAR_URL: "http://127.0.0.1:8788",
    });
    expect(s.env).toEqual(subscriptionEnv(8788, KEY));
    const hook = { type: "http", url: "http://127.0.0.1:8788/_passcontrol/hook", headers: KEY_HEADERS, timeout: 5 };
    // PreToolUse may wait for the owner's yes (Phase 2), and a timed-out http hook lets
    // the tool RUN: it gets Claude Code's 600 s, and tells the sidecar so in its URL.
    const toolHook = { type: "http", url: "http://127.0.0.1:8788/_passcontrol/hook?t=600", headers: KEY_HEADERS, timeout: 600 };
    expect(s.hooks).toEqual({
      UserPromptSubmit: [{ hooks: [hook] }],
      PreToolUse: [{ matcher: "*", hooks: [toolHook] }],
      PostToolBatch: [{ hooks: [hook] }],
    });
    expect(s.hooks).toEqual(subscriptionHooks(8788, { key: KEY }));
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
    expect(s.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [mine] }, ...subscriptionHooks(8788, { key: KEY }).PreToolUse]);
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
    expect(s.hooks).toEqual(subscriptionHooks(8790, { key: KEY }));
    expect(s.env).toEqual(subscriptionEnv(8790, KEY));
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
    expect(s.hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [mine] }, ...subscriptionHooks(8788, { key: KEY }).PreToolUse]);
    expect(s.hooks.UserPromptSubmit).toEqual(subscriptionHooks(8788, { key: KEY }).UserPromptSubmit);
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
    fs.writeFileSync(target(), JSON.stringify({ env: claudeCodeEnv(BASE, KEY) }));
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

// 1.6.0: the agent's opt-in note (cli/agent-note.mjs) is a URL on the prompt hook:
// `?note=1` on subscription mode's own, and in API mode a hook of its own,
// `?note=only`, which never blocks. Each setup owns only its own hooks.
describe("review C-03 follow-up: hooks written before the key get it on the next write", () => {
  const target = () => path.join(dir, "settings.json");
  it("subscription mode: keyless hooks and logs export are replaced in place, not duplicated", () => {
    const keyless = { type: "http", url: "http://127.0.0.1:8788/_passcontrol/hook", timeout: 5 };
    fs.writeFileSync(target(), JSON.stringify({
      env: { OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://127.0.0.1:8788/_passcontrol/otlp/v1/logs", OTEL_LOGS_EXPORTER: "otlp" },
      hooks: {
        UserPromptSubmit: [{ hooks: [keyless] }],
        PreToolUse: [{ matcher: "*", hooks: [{ type: "http", url: "http://127.0.0.1:8788/_passcontrol/hook?t=600", timeout: 600 }] }],
        PostToolBatch: [{ hooks: [keyless] }],
      },
    }));
    expect(writeClaudeCodeSubscription({ target: target(), sidecarKey: KEY, port: 8788, statusLineCommand: null }).changed).toBe(true);
    const s = read(target());
    expect(s.hooks).toEqual(subscriptionHooks(8788, { key: KEY }));
    expect(s.env.OTEL_EXPORTER_OTLP_LOGS_HEADERS).toBe(`Authorization=Bearer ${KEY}`);
  });

  it("API mode: a keyless tool hook gets the header", () => {
    fs.writeFileSync(target(), JSON.stringify({
      env: claudeCodeEnv("http://127.0.0.1:8788/api/v1/anthropic", KEY),
      hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "http", url: "http://127.0.0.1:8788/_passcontrol/hook?t=600&mode=api", timeout: 600 }] }] },
    }));
    expect(writeClaudeCodeSettings({ target: target(), baseUrl: "http://127.0.0.1:8788/api/v1/anthropic", sidecarKey: KEY }).changed).toBe(true);
    expect(read(target()).hooks.PreToolUse).toEqual(apiTools());
  });

  it("writing subscription mode without a key refuses and writes nothing", () => {
    expect(() => writeClaudeCodeSubscription({ target: target(), port: 8788, statusLineCommand: null })).toThrow(/passcontrol login/u);
    expect(fs.existsSync(target())).toBe(false);
  });

  it("removing takes out the logs headers it wrote, and leaves the user's own", () => {
    writeClaudeCodeSubscription({ target: target(), sidecarKey: KEY, port: 8788, statusLineCommand: null });
    removeClaudeCodeSubscription({ target: target() });
    expect(fs.existsSync(target()) ? read(target()).env?.OTEL_EXPORTER_OTLP_LOGS_HEADERS : undefined).toBeUndefined();
  });
});

describe("the agent's note", () => {
  const target = () => path.join(dir, "settings.json");
  const NOTE_ONLY = { type: "http", url: "http://127.0.0.1:8788/_passcontrol/hook?note=only", headers: KEY_HEADERS, timeout: 5 };

  it("subscription mode: --agent-note puts ?note=1 on the prompt hook only, and a re-run without it takes it off", () => {
    writeClaudeCodeSubscription({ target: target(), sidecarKey: KEY, port: 8788, statusLineCommand: null, note: true });
    let s = read(target());
    expect(s.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "http", url: "http://127.0.0.1:8788/_passcontrol/hook?note=1", headers: KEY_HEADERS, timeout: 5 }] }]);
    expect(s.hooks.PostToolBatch).toEqual(subscriptionHooks(8788, { key: KEY }).PostToolBatch);
    expect(subscriptionHooks(8788, { note: true, key: KEY }).UserPromptSubmit).toEqual(s.hooks.UserPromptSubmit);
    writeClaudeCodeSubscription({ target: target(), sidecarKey: KEY, port: 8788, statusLineCommand: null });
    s = read(target());
    expect(s.hooks).toEqual(subscriptionHooks(8788, { key: KEY }));
    removeClaudeCodeSubscription({ target: target() });
    expect(read(target()).hooks).toBeUndefined();
  });

  it("API mode: --agent-note adds one note-only prompt hook beside the env keys", () => {
    const out = writeClaudeCodeSettings({ target: target(), baseUrl: BASE, sidecarKey: KEY, noteHookPort: 8788 });
    expect(out.changed).toBe(true);
    const s = read(target());
    expect(s.hooks).toEqual({ UserPromptSubmit: [{ hooks: [NOTE_ONLY] }], PreToolUse: apiTools() });
    expect(writeClaudeCodeSettings({ target: target(), baseUrl: BASE, sidecarKey: KEY, noteHookPort: 8788 }).changed).toBe(false);
  });

  it("API mode: a re-run without it, or --remove, takes only that hook out", () => {
    const mine = { type: "command", command: "echo hi" };
    fs.writeFileSync(target(), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [mine] }] } }));
    writeClaudeCodeSettings({ target: target(), baseUrl: BASE, sidecarKey: KEY, noteHookPort: 8788 });
    expect(read(target()).hooks.UserPromptSubmit).toEqual([{ hooks: [mine] }, { hooks: [NOTE_ONLY] }]);
    writeClaudeCodeSettings({ target: target(), baseUrl: BASE, sidecarKey: KEY });
    expect(read(target()).hooks.UserPromptSubmit).toEqual([{ hooks: [mine] }]);
    writeClaudeCodeSettings({ target: target(), baseUrl: BASE, sidecarKey: KEY, noteHookPort: 8788 });
    removeClaudeCodeSettings({ target: target() });
    expect(read(target()).hooks).toEqual({ UserPromptSubmit: [{ hooks: [mine] }] });
  });

  it("API setup replaces the subscription tool hook and preserves its other hooks", () => {
    writeClaudeCodeSubscription({ target: target(), sidecarKey: KEY, port: 8788, statusLineCommand: null });
    writeClaudeCodeSettings({ target: target(), baseUrl: BASE, sidecarKey: KEY, noteHookPort: 8788, force: true });
    writeClaudeCodeSettings({ target: target(), baseUrl: BASE, sidecarKey: KEY, force: true });
    expect(read(target()).hooks).toEqual({ ...subscriptionHooks(8788, { key: KEY }), PreToolUse: apiTools() });
    writeClaudeCodeSettings({ target: target(), baseUrl: BASE, sidecarKey: KEY, noteHookPort: 8788, force: true });
    removeClaudeCodeSubscription({ target: target() });
    expect(read(target()).hooks).toEqual({ UserPromptSubmit: [{ hooks: [NOTE_ONLY] }] });
  });
});

const apiTools = (port = 8788) => [{ matcher: "*", hooks: [{ type: "http", url: `http://127.0.0.1:${port}/_passcontrol/hook?t=600&mode=api`, headers: KEY_HEADERS, timeout: 600 }] }];

describe("API tool hook", () => {
  it("always writes the hook and makes no backup on an identical second write", () => {
    const target = path.join(dir, "settings.json");
    writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY });
    expect(read(target).hooks.PreToolUse).toEqual(apiTools());
    expect(writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY })).toMatchObject({ changed: false, backupPath: null });
    expect(fs.existsSync(`${target}.bak`)).toBe(false);
  });

  // Removing API mode must not take subscription mode's tool hook with it: that would
  // leave a Pro/Max setup with its prompt and batch hooks but no tool rules.
  it("API --remove leaves a subscription-mode install whole", () => {
    const target = path.join(dir, "settings.json");
    writeClaudeCodeSubscription({ target, sidecarKey: KEY, port: 8788, statusLineCommand: null });
    const before = read(target).hooks;
    removeClaudeCodeSettings({ target });
    expect(read(target).hooks).toEqual(before);
  });

  it("preserves user groups and mixed hooks through port changes, switching and removal", () => {
    const target = path.join(dir, "settings.json");
    const mine = { type: "command", command: "echo mine" };
    const userGroups = [{ matcher: "Read", hooks: [mine] }, { matcher: "Bash", hooks: [mine] }];
    fs.writeFileSync(target, JSON.stringify({ hooks: { PreToolUse: userGroups } }));
    writeClaudeCodeSettings({ target, baseUrl: BASE, sidecarKey: KEY, noteHookPort: 8788 });
    expect(read(target).hooks.PreToolUse).toEqual([...userGroups, ...apiTools()]);
    writeClaudeCodeSettings({ target, baseUrl: BASE.replace("8788", "9000"), sidecarKey: KEY, force: true, noteHookPort: 8788 });
    expect(read(target).hooks.PreToolUse).toEqual([...userGroups, ...apiTools(9000)]);
    expect(read(target).hooks.UserPromptSubmit[0].hooks[0].url).toContain("8788/_passcontrol/hook?note=only");
    writeClaudeCodeSubscription({ target, sidecarKey: KEY, port: 9000 });
    expect(read(target).hooks.PreToolUse).toEqual([...userGroups, ...subscriptionHooks(9000, { key: KEY }).PreToolUse]);
    writeClaudeCodeSettings({ target, baseUrl: BASE.replace("8788", "9000"), sidecarKey: KEY });
    expect(read(target).hooks.PreToolUse).toEqual([...userGroups, ...apiTools(9000)]);
    const settings = read(target);
    settings.hooks.PreToolUse.at(-1).hooks.push(mine);
    fs.writeFileSync(target, JSON.stringify(settings));
    removeClaudeCodeSettings({ target });
    expect(read(target).hooks.PreToolUse).toEqual([...userGroups, { matcher: "*", hooks: [mine] }]);
  });
});
