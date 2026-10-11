// One identity per coding tool (1.4.0 candidate 4, owner 2026-10-10; design:
// plans/one-identity-per-tool.md). Named profiles hold a passport and a sidecar
// port; `configure <tool> --dedicated --write` creates the tool its own agent once;
// `sidecar --profiles a,b` serves each profile on its own port with its own passport.
// Identity code, so test-first, and as real CLI processes against a fake gateway.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));
const SEED_A = Buffer.alloc(32, 1).toString("base64url");

let server: Server;
let origin = "";
let created: { name: string; passportPubkey: string; scopes: unknown }[] = [];
let challenges: string[] = [];
const closers: (() => void)[] = [];

beforeEach(async () => {
  created = [];
  challenges = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "POST" && req.url === "/api/control/v1/agents") {
        const parsed = JSON.parse(body);
        created.push(parsed);
        res.end(JSON.stringify({ id: `agent-${created.length}`, name: parsed.name }));
        return;
      }
      if (req.url === "/api/auth/challenge") {
        const payload = JSON.parse(Buffer.from(JSON.parse(body).payload, "base64url").toString());
        challenges.push(payload.passport_id);
        res.end(JSON.stringify({ visa: `visa-for-${payload.passport_id}`, expires_in: 300 }));
        return;
      }
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  origin = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});
afterEach(async () => {
  while (closers.length) closers.pop()!();
  await new Promise<void>((r) => server.close(() => r()));
});

function home(withControlKey = true) {
  const h = mkdtempSync(join(tmpdir(), "pc-profiles-"));
  mkdirSync(join(h, "passcontrol"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(h, "passcontrol", "config"),
    `PASSCONTROL_GATEWAY=${origin}\n${withControlKey ? "PASSCONTROL_API_KEY=pc_test_key\n" : ""}PASSPORT_ID=${Buffer.from(
      new Uint8Array(32).fill(5)
    ).toString("base64url")}\nPASSPORT_SECRET=${SEED_A}\n`,
    { mode: 0o600 }
  );
  return h;
}

function run(args: string[], h: string, env: Record<string, string> = {}, cwd = h) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: h, XDG_CONFIG_HOME: h, NO_COLOR: "1", CI: "1", PASSCONTROL_NO_UPDATE_CHECK: "1", ...env } as unknown as NodeJS.ProcessEnv,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

const profilePath = (h: string, name: string) => join(h, "passcontrol", "profiles", name);
const readProfile = (h: string, name: string) =>
  Object.fromEntries(
    readFileSync(profilePath(h, name), "utf8")
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
  );

describe("configure claude-code --dedicated", () => {
  it("previews without --write and creates nothing", async () => {
    const h = home();
    const r = await run(["configure", "claude-code", "--dedicated"], h);
    expect(r.code).toBe(0);
    expect(created).toHaveLength(0);
    expect(existsSync(profilePath(h, "claude-code"))).toBe(false);
    expect(r.out).toMatch(/8790/);
  });

  it("creates the tool's own agent once, saves its passport in a private profile, and points Claude Code at port 8790", async () => {
    const h = home();
    const r = await run(["configure", "claude-code", "--dedicated", "--write"], h);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(created).toHaveLength(1);
    expect(created[0]!.name).toMatch(/^Claude Code @ /);
    expect(created[0]!.scopes).toEqual([{ provider: "anthropic", models: expect.any(Array) }]);
    const profile = readProfile(h, "claude-code");
    expect(profile.PASSPORT_ID).toBe(created[0]!.passportPubkey);
    expect(profile.PASSPORT_SECRET).toBeTruthy();
    expect(profile.SIDECAR_PORT).toBe("8790");
    expect(statSync(profilePath(h, "claude-code")).mode & 0o777).toBe(0o600);
    expect(statSync(join(h, "passcontrol", "profiles")).mode & 0o777).toBe(0o700);
    expect(r.out + r.err).not.toContain(profile.PASSPORT_SECRET);
    const settings = JSON.parse(readFileSync(join(h, ".claude", "settings.local.json"), "utf8"));
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:8790/api/v1/anthropic");
    expect(r.out).toContain("passcontrol sidecar --profile claude-code");
  });

  it("reuses the profile on a second run instead of creating a second agent", async () => {
    const h = home();
    await run(["configure", "claude-code", "--dedicated", "--write"], h);
    const first = readProfile(h, "claude-code").PASSPORT_ID;
    const again = await run(["configure", "claude-code", "--dedicated", "--write"], h);
    expect(again.code).toBe(0);
    expect(created).toHaveLength(1);
    expect(readProfile(h, "claude-code").PASSPORT_ID).toBe(first);
  });

  it("says plainly that a control API key is needed, and creates nothing without one", async () => {
    const h = home(false);
    const r = await run(["configure", "claude-code", "--dedicated", "--write"], h);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/control/i);
    expect(existsSync(profilePath(h, "claude-code"))).toBe(false);
  });
});

describe("configure codex --dedicated", () => {
  it("gives Codex its own agent on port 8791, scoped to OpenAI", async () => {
    const h = home();
    const r = await run(["configure", "codex", "--dedicated", "--write"], h);
    expect(r.code).toBe(0);
    expect(created[0]!.name).toMatch(/^Codex @ /);
    expect(created[0]!.scopes).toEqual([{ provider: "openai", models: expect.any(Array) }]);
    expect(readProfile(h, "codex").SIDECAR_PORT).toBe("8791");
    const toml = readFileSync(join(h, ".codex", "passcontrol.config.toml"), "utf8");
    expect(toml).toContain("127.0.0.1:8791/api/v1/openai");
  });
});

describe("profiles", () => {
  it("lists each profile's name, passport suffix and port, never the secret", async () => {
    const h = home();
    await run(["configure", "claude-code", "--dedicated", "--write"], h);
    await run(["configure", "codex", "--dedicated", "--write"], h);
    const r = await run(["profile", "list"], h);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/claude-code.*8790/);
    expect(r.out).toMatch(/codex.*8791/);
    expect(r.out).not.toContain(readProfile(h, "codex").PASSPORT_SECRET);
  });

  it.each(["../x", "UPPER", "a b", "", "x".repeat(40)])("refuses a profile name like %j", async (name) => {
    const h = home();
    const r = await run(["sidecar", "--profile", name], h);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/profile/i);
  });

  it("a project's .passcontrol cannot choose a profile", async () => {
    const h = home();
    await run(["configure", "claude-code", "--dedicated", "--write"], h);
    const project = mkdtempSync(join(tmpdir(), "pc-project-"));
    writeFileSync(join(project, ".passcontrol"), "PASSCONTROL_PROFILE=claude-code\n");
    const r = await run(["status", "--no-network", "--json"], h, {}, project);
    expect(JSON.parse(r.out).config.profile ?? null).toBeNull();
  });
});

describe("sidecar --profiles", () => {
  it("serves each profile on its own port, minting with its own passport, in one process", async () => {
    const h = home();
    await run(["configure", "claude-code", "--dedicated", "--write"], h);
    await run(["configure", "codex", "--dedicated", "--write"], h);
    // Free ports for the test, written over the profiles' defaults.
    const ports: number[] = [];
    for (let i = 0; i < 2; i++) {
      const s = createServer();
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      const a = s.address();
      ports.push(typeof a === "object" && a ? a.port : 0);
      await new Promise<void>((r) => s.close(() => r()));
    }
    for (const [name, port] of [["claude-code", ports[0]], ["codex", ports[1]]] as const) {
      const file = profilePath(h, name);
      writeFileSync(file, readFileSync(file, "utf8").replace(/SIDECAR_PORT=\d+/, `SIDECAR_PORT=${port}`), { mode: 0o600 });
    }
    const child = spawn(process.execPath, [CLI, "sidecar", "--profiles", "claude-code,codex", "--no-journal"], {
      env: { PATH: process.env.PATH ?? "", HOME: h, XDG_CONFIG_HOME: h, NO_COLOR: "1", CI: "1", PASSCONTROL_NO_UPDATE_CHECK: "1" } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    closers.push(() => child.kill());
    for (let i = 0; i < 100 && (out.match(/visa warmed/g) ?? []).length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    expect((out.match(/visa warmed/g) ?? []).length).toBe(2);
    expect(new Set(challenges)).toEqual(new Set([readProfile(h, "claude-code").PASSPORT_ID, readProfile(h, "codex").PASSPORT_ID]));
    expect(out).toContain(String(ports[0]));
    expect(out).toContain(String(ports[1]));
  }, 30_000);
});

describe("sidecar --profile", () => {
  it("speaks as the profile's agent, on the profile's port, over the global passport", async () => {
    const h = home();
    await run(["configure", "claude-code", "--dedicated", "--write"], h);
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const a = s.address();
    const port = typeof a === "object" && a ? a.port : 0;
    await new Promise<void>((r) => s.close(() => r()));
    const file = profilePath(h, "claude-code");
    writeFileSync(file, readFileSync(file, "utf8").replace(/SIDECAR_PORT=\d+/, `SIDECAR_PORT=${port}`), { mode: 0o600 });
    challenges = [];
    const child = spawn(process.execPath, [CLI, "sidecar", "--profile", "claude-code", "--no-journal"], {
      env: { PATH: process.env.PATH ?? "", HOME: h, XDG_CONFIG_HOME: h, NO_COLOR: "1", CI: "1", PASSCONTROL_NO_UPDATE_CHECK: "1" } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    closers.push(() => child.kill());
    for (let i = 0; i < 100 && !/visa warmed/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    expect(out).toMatch(/visa warmed/);
    expect(out).toContain(`127.0.0.1:${port}`);
    expect(challenges).toEqual([readProfile(h, "claude-code").PASSPORT_ID]);
  }, 30_000);
});
