// What `agent create` and `agent rotate` TELL you to do with a passport.
//
// Item 3 of plans/cloud-premium.md. Both commands ended with "Paste them into
// .passcontrol", which is the self-host ritual — and it is where the two-value
// model is authored. `passcontrol login` can set a machine up without a secret
// ever crossing a clipboard, and neither command mentioned it.
//
// ── The correction this file also pins ──────────────────────────────────────
//
// The plan originally said to hide the secret behind an explicit --print-secret.
// That is unsafe and these tests forbid it. The private key is generated on this
// machine (bin/passcontrol.mjs, `ed25519.utils.randomPrivateKey()`) and discarded
// the moment the command exits; the server has never held it and there is no
// re-reveal path — `agent rotate` mints a NEW key rather than showing the old
// one. A default that neither prints nor stores the secret therefore creates an
// agent whose passport is already lost. So: always printed, unless --write puts
// it somewhere durable first.
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI = path.join(process.cwd(), "bin/passcontrol.mjs");
const FAKE_KEY = `pc_${"k".repeat(43)}`;

function stubControl() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, obj: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.url === "/api/control/v1/agents" && req.method === "POST") {
        return send(200, { id: "agent-123", name: "ci-runner" });
      }
      if (/\/api\/control\/v1\/agents\/[^/]+\/rotate$/u.test(req.url ?? "")) {
        return send(200, { previous_valid_until: "2026-09-01T00:00:00.000Z" });
      }
      return send(404, { error: "not_found" });
    });
  });
  return server;
}

let home: string;
let configFile: string;
let server: http.Server;
let port: number;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-agent-test-"));
  configFile = path.join(home, "config", "passcontrol", "config");
  server = stubControl();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as { port: number }).port;
});

afterEach(() => {
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
});

async function run(args: string[], extraEnv: Record<string, string> = {}) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    // Isolated, for the same reason tests/cli-onboarding.test.ts isolates it:
    // the CLI reads a global config from here, and passing the developer's own
    // lets their machine decide what the command under test sees.
    XDG_CONFIG_HOME: path.join(home, "config"),
    NO_COLOR: "1",
    NODE_ENV: "test",
    PASSCONTROL_FORCE_INSTALLED: "1",
    PASSCONTROL_GATEWAY: `http://127.0.0.1:${port}`,
    PASSCONTROL_API_KEY: FAKE_KEY,
    ...extraEnv,
  };
  const result = await execFileAsync(process.execPath, [CLI, ...args], { env, timeout: 20_000 }).catch(
    (error: { stdout?: string; stderr?: string }) => error
  );
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

describe("agent create stops teaching the paste ritual", () => {
  it("names the no-copy path instead of telling you to paste into a file", async () => {
    const out = await run(["agent", "create", "ci-runner"]);
    expect(out, "the command must have run").toMatch(/created agent/iu);
    // The whole point: a second machine does not need this secret at all.
    expect(out, "it must offer the path where no secret is copied").toMatch(/passcontrol login/u);
    expect(out, "and stop presenting the paste as the default").not.toMatch(/Paste them into/iu);
  });

  it("still prints the secret, because nothing can recover it later", async () => {
    // Anti-regression, and the reason --print-secret was rejected. If this ever
    // goes quiet by default, every agent created non-interactively is born with
    // a passport nobody holds.
    const out = await run(["agent", "create", "ci-runner"]);
    expect(out).toMatch(/PASSPORT_SECRET=[A-Za-z0-9_-]{43}/u);
  });
});

describe("agent create --write keeps the secret off the terminal", () => {
  it("stores it and does not print it", async () => {
    const out = await run(["agent", "create", "ci-runner", "--write"]);
    const written = fs.readFileSync(configFile, "utf8");
    expect(written, "the passport must be durable before it leaves the screen").toMatch(
      /PASSPORT_SECRET=[A-Za-z0-9_-]{43}/u
    );
    expect(out, "and then it has no business being on the terminal").not.toMatch(
      /PASSPORT_SECRET=[A-Za-z0-9_-]{43}/u
    );
  });

  it("refuses to overwrite a passport it cannot give back", async () => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, "PASSPORT_SECRET=already-here\nPROVIDER=groq\n");
    const out = await run(["agent", "create", "ci-runner", "--write"]);
    expect(out).toMatch(/already holds a passport/iu);
    expect(fs.readFileSync(configFile, "utf8"), "the existing passport must survive").toContain(
      "already-here"
    );
  });
});

describe("agent rotate keeps revealing, and says why", () => {
  it("prints the new secret and still names the grace window", async () => {
    // Rotation must NOT write the file: mid-grace-window that would destroy the
    // only copy of the key that is still working. bin/passcontrol.mjs says so at
    // the reveal site, and this pins it.
    const out = await run(["agent", "rotate", "agent-123"]);
    expect(out).toMatch(/PASSPORT_SECRET=[A-Za-z0-9_-]{43}/u);
    expect(out, "the operator must be told the old key still works").toMatch(/OLD key keeps working/u);
    expect(fs.existsSync(configFile), "rotate must not write a config").toBe(false);
  });
});
