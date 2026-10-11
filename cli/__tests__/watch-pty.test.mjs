import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

import { createSidecar } from "../sidecar.mjs";

// `passcontrol watch` under a REAL pseudo-terminal: the whole CLI, a real sidecar and a
// fake gateway. A full-screen program can pass every unit test and still leave a
// person's terminal in raw mode with no cursor, which only a pty shows. This drives
// one through: calls arrive live, a refusal shows DENIED with its code, the window is
// resized, Ctrl-C quits, and then `stty -a` runs IN THE SAME pty, so the test reads
// the terminal state the person would be left with.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "bin", "passcontrol.mjs");

function hasPython() {
  try {
    execFileSync("python3", ["-c", "import pty"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Forks a pty running the board, then `stty -a`. Talks to the test over stderr
// ("@@" lines) and stdin ("go"), and prints the pty's whole output, base64, on stdout.
const DRIVER = String.raw`
import base64, fcntl, os, pty, select, struct, sys, termios, time
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("sh", ["sh", "-c", '"$PTY_NODE" "$PTY_CLI" watch --port "$PTY_PORT"; stty -a'], os.environ)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 14, 100, 0, 0))
buf = b""
def pump(sec, until=None):
    global buf
    end = time.time() + sec
    while time.time() < end:
        if until is not None and until in buf:
            return True
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return until is None
            if not chunk:
                return until is None
            buf += chunk
    return until is None or until in buf
def say(text):
    sys.stderr.write("@@" + text + "\n"); sys.stderr.flush()
ok = pump(15, b"live")
say("live" if ok else "no-live")
sys.stdin.readline()
say("denied" if pump(10, b"DENIED blocked_suspended") else "no-denied")
mark = len(buf)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 12, 60, 0, 0))
pump(10, b"TIME      SUB-AGENT")
say("resized:%d" % mark)
os.write(fd, b"\x03")
pump(10)
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass
sys.stdout.write(base64.b64encode(buf).decode()); sys.stdout.flush()
`;

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  }));
  return server.address().port;
}

describe.skipIf(process.platform === "win32" || !hasPython())("passcontrol watch under a real pty", () => {
  it("fills live, shows a refusal's reason, survives a resize, and Ctrl-C leaves the terminal sane", async () => {
    const gateway = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if (req.url === "/api/auth/challenge") {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ visa: "fake.visa.token", expires_in: 300 }));
        }
        if (req.url.startsWith("/api/v1/self")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ budget: { period: { kind: "day", used_microcents: 50_000_000, limit_microcents: 200_000_000, remaining_microcents: 150_000_000 } } }));
        }
        if (req.headers["x-test-mode"] === "denied") {
          res.writeHead(403, { "content-type": "application/json", "x-passcontrol-receipt-id": "r2" });
          return res.end(JSON.stringify({ error: "blocked_suspended" }));
        }
        res.writeHead(200, { "content-type": "application/json", "x-passcontrol-receipt-id": "r1" });
        res.end("{}");
      });
    });
    const gatewayPort = await listen(gateway);
    const secret = ed25519.utils.randomPrivateKey();
    const sidecar = createSidecar({
      gateway: `http://127.0.0.1:${gatewayPort}`,
      passportId: Buffer.from(ed25519.getPublicKey(secret)).toString("base64url"),
      passportSecret: Buffer.from(secret).toString("base64url"),
      onRefusal: () => {},
    });
    const port = await listen(sidecar.server);
    cleanup.push(async () => sidecar.feed.close());

    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-watch-pty-"));
    cleanup.push(async () => fs.rmSync(home, { recursive: true, force: true }));
    const driverPath = path.join(home, "..", `pc-watch-driver-${process.pid}.py`);
    fs.writeFileSync(driverPath, DRIVER);
    cleanup.push(async () => fs.rmSync(driverPath, { force: true }));
    fs.mkdirSync(path.join(home, "home"));
    fs.mkdirSync(path.join(home, "config"));

    const child = spawn("python3", ["-I", driverPath], {
      env: {
        PATH: process.env.PATH,
        TERM: "xterm-256color",
        NO_COLOR: "1",
        PASSCONTROL_NO_UPDATE_CHECK: "1",
        HOME: path.join(home, "home"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        PTY_NODE: process.execPath,
        PTY_CLI: CLI,
        PTY_PORT: String(port),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    cleanup.push(async () => child.kill("SIGKILL"));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    const said = (word) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`driver never said ${word}; stderr: ${stderr}`)), 30_000);
        const check = () => {
          const line = stderr.split("\n").find((l) => l.startsWith(`@@${word}`) || l.startsWith(`@@no-${word}`));
          if (!line) return;
          clearTimeout(timer);
          child.stderr.off("data", onData);
          resolve(line.slice(2));
        };
        const onData = (c) => {
          stderr += c;
          check();
        };
        child.stderr.on("data", onData);
        check();
      });

    expect(await said("live")).toBe("live");

    const post = (headers) =>
      fetch(`http://127.0.0.1:${port}/api/v1/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "hi" }] }),
      }).then((r) => r.text());
    await post({ "x-claude-code-session-id": "sess-pty-1" });
    await post({ "x-claude-code-session-id": "sess-pty-1", "x-claude-code-agent-id": "a0000000000000002", "x-test-mode": "denied" });
    child.stdin.write("go\n");

    expect(await said("denied")).toBe("denied");
    const resized = await said("resized");
    const mark = Number(resized.split(":")[1]);
    await new Promise((resolve) => child.on("exit", resolve));

    const raw = Buffer.from(stdout, "base64").toString("utf8");
    const afterResize = raw.slice(mark);

    // Live, with the refusal's reason, on a 100-column board.
    expect(raw).toContain("\x1b[?1049h");
    expect(raw).toContain("claude-haiku-5-5");
    expect(raw).toContain("BOARDED");
    expect(raw).toContain("DENIED blocked_suspended");
    expect(raw).toContain("sess-pty");
    expect(raw).toContain("$0.50 of $2.00");
    // The resize redrew at 60 columns, where the session column goes.
    expect(afterResize).toContain("TIME      SUB-AGENT     MODEL");

    // Ctrl-C: the alternate screen is left, the cursor shown after its last hiding,
    // and the terminal is back in cooked mode with echo, as `stty -a` reports it.
    const leave = raw.lastIndexOf("\x1b[?1049l");
    expect(leave).toBeGreaterThan(raw.lastIndexOf("\x1b[?1049h"));
    expect(raw.lastIndexOf("\x1b[?25h")).toBeGreaterThan(raw.lastIndexOf("\x1b[?25l"));
    const stty = raw.slice(leave);
    expect(stty).toMatch(/(^|\s)icanon(\s|$)/);
    expect(stty).toMatch(/(^|\s)isig(\s|$)/);
    expect(stty).toMatch(/(^|\s)echo(\s|$)/);
    expect(stty).not.toMatch(/(^|\s)-(icanon|isig|echo)(\s|$)/);

    // And it wrote nothing anywhere it could: no config, no cache, no journal.
    const files = (dir) => fs.readdirSync(dir, { recursive: true });
    expect(files(path.join(home, "home"))).toEqual([]);
    expect(files(path.join(home, "config"))).toEqual([]);
  }, 60_000);
});
