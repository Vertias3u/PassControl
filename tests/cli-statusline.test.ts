// `passcontrol statusline`: the agent's budget in Claude Code's status line, all day
// (1.4.0 candidate 2). Claude Code runs the command after every assistant message
// (debounced 300ms) and cancels a run still going when the next one starts
// (code.claude.com/docs/en/statusline, read 2026-10-08). So it must:
//   * answer from a short-lived cache, not ask the gateway every message;
//   * ask through the running sidecar, which holds a warm visa: minting one per run
//     would spend the passport's challenge allowance the sidecar itself needs;
//   * print one line and exit 0 whatever happens. A status line that throws breaks
//     the person's editor, not the agent.
// Run as a real process, the way Claude Code runs it.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));
const SELF = {
  agent_id: "a",
  auth: "passport",
  scope: [],
  as_of: "2026-10-08T12:00:00.000Z",
  budget: {
    tokens: null,
    cost: null,
    period: { kind: "day", limit_microcents: 200_000_000, used_microcents: 42_000_000, remaining_microcents: 158_000_000, resets_in_seconds: 39_600 },
  },
};

let server: Server;
let port = 0;
let hits: string[] = [];
let answer: (res: import("node:http").ServerResponse) => void;

beforeEach(async () => {
  hits = [];
  answer = (res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(SELF));
  };
  server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    answer(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  port = typeof a === "object" && a ? a.port : 0;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

function run(args: string[], home = mkdtempSync(join(tmpdir(), "pc-statusline-")), closeStdin = true) {
  return new Promise<{ code: number; out: string; err: string; home: string; ms: number }>((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: home,
      env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1" } as unknown as NodeJS.ProcessEnv,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    // What Claude Code sends; the command must not depend on it, or hang without it.
    child.stdin.write(JSON.stringify({ session_id: "s1", model: { display_name: "Opus" } }));
    if (closeStdin) child.stdin.end();
    child.on("close", (code) => resolve({ code: code ?? -1, out, err, home, ms: Date.now() - started }));
  });
}

describe("passcontrol statusline", () => {
  it("prints the agent's budget on one line, read through the sidecar", async () => {
    const r = await run(["statusline", "--port", String(port)]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("PassControl · $0.42 of $2.00 today\n");
    expect(hits).toEqual(["GET /api/v1/self"]);
  });

  it("answers from its cache for the next run, without asking again", async () => {
    const first = await run(["statusline", "--port", String(port)]);
    const second = await run(["statusline", "--port", String(port)], first.home);
    expect(second.out).toBe(first.out);
    expect(hits).toHaveLength(1);
  });

  it("keeps its cache readable only by its owner", async () => {
    const r = await run(["statusline", "--port", String(port)]);
    const dir = join(r.home, "passcontrol");
    const files = readdirSync(dir).filter((f) => f.startsWith("statusline"));
    expect(files.length).toBe(1);
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
  });

  it("says the sidecar is not running when nothing answers, and exits 0", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    server = createServer(); // afterEach closes something
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const r = await run(["statusline", "--port", "1"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("PassControl · sidecar not running on port 1\n");
  });

  it("says the agent is stopped when the gateway refuses it", async () => {
    answer = (res) => {
      res.statusCode = 403;
      res.end(JSON.stringify({ error: "blocked_suspended" }));
    };
    const r = await run(["statusline", "--port", String(port)]);
    expect(r.code).toBe(0);
    expect(r.out).toBe("PassControl · agent stopped\n");
  });

  it("gives up quickly on a slow answer instead of holding Claude Code's status line", async () => {
    answer = () => {
      /* never answers */
    };
    const r = await run(["statusline", "--port", String(port)]);
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(4_000);
    expect(r.out).toBe("PassControl · no answer from the sidecar\n");
  });

  it("never prints a stack trace, whatever comes back", async () => {
    answer = (res) => res.end("<html>not json</html>");
    const r = await run(["statusline", "--port", String(port)]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n").filter(Boolean)).toHaveLength(1);
    expect(r.out + r.err).not.toMatch(/at .*\.mjs:\d+/);
  });

  it("does not wait for stdin to close", async () => {
    const r = await run(["statusline", "--port", String(port)], undefined, false);
    expect(r.code).toBe(0);
    expect(r.out).toBe("PassControl · $0.42 of $2.00 today\n");
  });

  it("writes no file when it cannot reach anything", async () => {
    const r = await run(["statusline", "--port", "1"]);
    expect(existsSync(join(r.home, "passcontrol"))).toBe(false);
  });
});
