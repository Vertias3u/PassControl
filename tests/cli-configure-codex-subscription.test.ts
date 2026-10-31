// `passcontrol configure codex --subscription` and `passcontrol codex-hook` (1.6.0, L5),
// run as real processes with an empty HOME: no PassControl config at all, and Codex's
// home in the temp directory. The hooks file logic itself is cli/__tests__/codex-hooks.test.mjs.
import { spawn } from "node:child_process";
import http from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));

function run(args: string[], home: string, stdin = "") {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        CODEX_HOME: join(home, ".codex"),
        NO_COLOR: "1",
        PASSCONTROL_NO_UPDATE_CHECK: "1",
      } as unknown as NodeJS.ProcessEnv,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.end(stdin);
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

const freshHome = () => mkdtempSync(join(tmpdir(), "pc-configure-codex-"));
const hooksFile = (home: string) => join(home, ".codex", "hooks.json");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("configure codex --subscription", () => {
  it("previews without writing anything, and says what it cannot do", async () => {
    const home = freshHome();
    const r = await run(["configure", "codex", "--subscription"], home);
    expect(r.code).toBe(0);
    expect(r.out).toContain("codex-hook --port 8788");
    expect(r.out).toMatch(/no strict hook mode/);
    expect(r.out).toMatch(/do not apply here\. Command rules \(Bash\) and MCP tool rules do/);
    expect(existsSync(hooksFile(home))).toBe(false);
    // The API-key setup is not written either: this mode never routes Codex's calls.
    expect(existsSync(join(home, ".codex", "passcontrol.config.toml"))).toBe(false);
  });

  it("writes the three hooks next to someone else's, says to trust them, and removes only its own", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    const theirs = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "other-tool hook", timeout: 10 }] }] } };
    writeFileSync(hooksFile(home), JSON.stringify(theirs));

    const w = await run(["configure", "codex", "--subscription", "--write", "--port", "8791"], home);
    expect(w.code).toBe(0);
    expect(w.out + w.err).toMatch(/type \/hooks, and trust PassControl's three hooks/);
    // The exact command, run as Codex would under a bare PATH (the bare `passcontrol` failed this).
    expect(w.out).toMatch(/the hook command runs on its own/);
    const s = read(hooksFile(home));
    expect(s.hooks.UserPromptSubmit).toHaveLength(2);
    expect(s.hooks.UserPromptSubmit[0]).toEqual(theirs.hooks.UserPromptSubmit[0]);
    expect(s.hooks.PreToolUse[0].hooks[0]).toMatchObject({ type: "command", timeout: 600 });
    expect(s.hooks.PreToolUse[0].hooks[0].command).toMatch(/codex-hook --port 8791$/);
    expect(s.hooks.PostToolUse[0].hooks[0]).toMatchObject({ type: "command", timeout: 5 });
    expect(s.hooks.PostToolUse[0].hooks[0].command).toBe(s.hooks.PreToolUse[0].hooks[0].command);
    expect(existsSync(`${hooksFile(home)}.passcontrol-backup`)).toBe(true);

    const again = await run(["configure", "codex", "--subscription", "--write", "--port", "8791"], home);
    expect(again.out).toMatch(/already has PassControl's hooks/);

    const r = await run(["configure", "codex", "--subscription", "--remove"], home);
    expect(r.code).toBe(0);
    expect(read(hooksFile(home))).toEqual(theirs);
  });

  it("refuses a hooks file it cannot read, and leaves it as it was", async () => {
    const home = freshHome();
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(hooksFile(home), "{ broken");
    const r = await run(["configure", "codex", "--subscription", "--write"], home);
    expect(r.code).not.toBe(0);
    expect(readFileSync(hooksFile(home), "utf8")).toBe("{ broken");
  });
});

describe("passcontrol codex-hook", () => {
  it("prints only Codex's answer: a stopped agent's tool is denied, with no field that fails the hook", async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          continue: false,
          stopReason: "PassControl: this agent is stopped.",
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "PassControl: this agent is stopped." },
        }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const port = (server.address() as AddressInfo).port;
      const r = await run(["codex-hook", "--port", String(port)], freshHome(), JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }));
      expect(r.code).toBe(0);
      const lines = r.out.trim().split("\n");
      expect(lines).toHaveLength(1);
      const answer = JSON.parse(lines[0] ?? "");
      expect(answer).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "PassControl: this agent is stopped." } });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("with no sidecar, exits 0 with one warning line: Codex goes ahead", async () => {
    const r = await run(["codex-hook", "--port", "1"], freshHome(), JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hi" }));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim())).toEqual({ systemMessage: expect.stringMatching(/goes ahead unchecked/) });
  });

  it("prints nothing at all for an event it does not handle", async () => {
    const r = await run(["codex-hook", "--port", "1"], freshHome(), JSON.stringify({ hook_event_name: "SessionStart" }));
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });
});
