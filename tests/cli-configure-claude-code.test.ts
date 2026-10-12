// `passcontrol configure claude-code` writes or removes two env keys (and, with
// --statusline, a status line) in a Claude Code settings file. None of that uses a
// passport: the sidecar holds the passport, and it is started separately. Requiring
// a global passport first meant `--remove` could not undo the settings after the
// CLI config was deleted, which is exactly when someone wants to undo them.
// Cursor and Claude Desktop launch `passcontrol mcp`, which does need the global
// passport, so they keep the requirement.
// Run as a real process with an empty HOME and XDG_CONFIG_HOME: no config at all.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));

function run(args: string[], home: string, extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        NO_COLOR: "1",
        PASSCONTROL_NO_UPDATE_CHECK: "1",
        ...extraEnv,
      } as unknown as NodeJS.ProcessEnv,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

const freshHome = () => mkdtempSync(join(tmpdir(), "pc-configure-cc-"));
const projectSettings = (home: string) => join(home, ".claude", "settings.local.json");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("configure claude-code needs no global passport", () => {
  it("dry run previews the two keys", async () => {
    const home = freshHome();
    const r = await run(["configure", "claude-code"], home);
    expect(r.err).not.toMatch(/requires a passport/);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ANTHROPIC_BASE_URL");
    expect(existsSync(projectSettings(home))).toBe(false);
  });

  it("--write writes the project settings", async () => {
    const home = freshHome();
    const r = await run(["configure", "claude-code", "--write"], home);
    expect(r.err).not.toMatch(/requires a passport/);
    expect(r.code).toBe(0);
    expect(read(projectSettings(home)).env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8788/api/v1/anthropic");
  });

  it("--write --statusline adds the status line", async () => {
    const home = freshHome();
    const r = await run(["configure", "claude-code", "--write", "--statusline"], home);
    expect(r.code).toBe(0);
    const settings = read(projectSettings(home));
    expect(settings.statusLine?.command).toMatch(/statusline/);
    expect(settings.env.ANTHROPIC_BASE_URL).toContain("/api/v1/anthropic");
  });

  it("--write --global writes under CLAUDE_CONFIG_DIR", async () => {
    const home = freshHome();
    const dir = join(home, "claude-config");
    const r = await run(["configure", "claude-code", "--write", "--global"], home, { CLAUDE_CONFIG_DIR: dir });
    expect(r.code).toBe(0);
    expect(read(join(dir, "settings.json")).env.ANTHROPIC_BASE_URL).toContain("/api/v1/anthropic");
  });

  it("--remove undoes a write after the CLI config is gone", async () => {
    const home = freshHome();
    expect((await run(["configure", "claude-code", "--write", "--statusline"], home)).code).toBe(0);
    // A setting of the user's own survives the removal.
    const file = projectSettings(home);
    const written = read(file);
    writeFileSync(file, JSON.stringify({ ...written, model: "opus" }));
    const r = await run(["configure", "claude-code", "--remove"], home);
    expect(r.err).not.toMatch(/requires a passport/);
    expect(r.code).toBe(0);
    expect(read(file)).toEqual({ model: "opus" });
  });

  it("--remove with nothing written says so and succeeds", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const r = await run(["configure", "claude-code", "--remove"], home);
    expect(r.code).toBe(0);
  });
});

describe("the MCP clients still need the global passport", () => {
  for (const client of ["cursor", "claude-desktop"]) {
    it(`configure ${client} refuses without one`, async () => {
      const home = freshHome();
      const r = await run(["configure", client, "--write"], home);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/requires a passport in the global PassControl config/);
    });
  }
});

// The same mistake in `passcontrol env claude-code` (carry-over finding, 2026-10-10):
// it only prints two env lines pointing Claude Code at the sidecar, yet it asked for a
// global passport first. Cursor and Claude Desktop print an MCP entry that launches
// `passcontrol mcp`, which does sign in with it, so they keep the requirement.
describe("env claude-code needs no global passport", () => {
  it("prints the two exports", async () => {
    const r = await run(["env", "claude-code"], freshHome());
    expect(r.err).not.toMatch(/requires a passport/);
    expect(r.code).toBe(0);
    expect(r.out).toContain("ANTHROPIC_BASE_URL");
  });

  it.each(["cursor", "claude-desktop"])("env %s still refuses without one", async (client) => {
    const r = await run(["env", client], freshHome());
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/requires a passport in the global PassControl config/);
  });
});

// Subscription mode: a Pro/Max login keeps talking to
// Anthropic directly; PassControl is told about each call and asked before each
// prompt and tool. It writes the USER settings (Claude Code ignores telemetry in a
// project's file), never ANTHROPIC_BASE_URL, and needs no passport to write or undo.
describe("configure claude-code --subscription", () => {
  const userSettings = (home: string) => join(home, ".claude", "settings.json");

  it("previews without writing anything", async () => {
    const home = freshHome();
    const r = await run(["configure", "claude-code", "--subscription"], home);
    expect(r.code).toBe(0);
    expect(r.out).toContain("/_passcontrol/hook");
    expect(r.out).toContain("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT");
    expect(existsSync(userSettings(home))).toBe(false);
  });

  it("says before writing that the reported calls also go to the agent's page, and how to keep them local", async () => {
    // Phase 1b: a new data flow from a personal subscription to the gateway. The
    // person setting it up reads that here, not first on the dashboard.
    const r = await run(["configure", "claude-code", "--subscription"], freshHome());
    expect(r.out).toMatch(/agent's (dashboard )?page/);
    expect(r.out).toContain("--no-report-calls");
  });

  it("writes the user settings with no base URL, and removes them again", async () => {
    const home = freshHome();
    const w = await run(["configure", "claude-code", "--subscription", "--write"], home);
    expect(w.code).toBe(0);
    const s = read(userSettings(home));
    expect(s.env.PASSCONTROL_SIDECAR_URL).toBe("http://127.0.0.1:8788");
    expect(s.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(s.hooks.PreToolUse[0].hooks[0]).toMatchObject({ url: "http://127.0.0.1:8788/_passcontrol/hook?t=600", timeout: 600 });
    expect(s.hooks.UserPromptSubmit[0].hooks[0]).toMatchObject({ url: "http://127.0.0.1:8788/_passcontrol/hook", timeout: 5 });
    expect(s.statusLine.command).toMatch(/statusline --port 8788$/);
    expect(existsSync(projectSettings(home))).toBe(false);

    const r = await run(["configure", "claude-code", "--subscription", "--remove"], home);
    expect(r.code).toBe(0);
    expect(read(userSettings(home))).toEqual({});
  });

  it("refuses to take over the user's own log export, writing nothing", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const mine = { env: { OTEL_LOGS_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "https://otel.example.com/v1/logs" } };
    writeFileSync(userSettings(home), JSON.stringify(mine));
    const r = await run(["configure", "claude-code", "--subscription", "--write"], home);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/--force/);
    expect(read(userSettings(home))).toEqual(mine);
  });
});
