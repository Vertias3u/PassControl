// The CLI half of an owner's delegations (Bet D; owner 2026-10-10: "start this"):
//   passcontrol agent delegations <agent-id> [--json]        the links a worker has used
//   passcontrol agent revoke-delegation <agent-id> <jti>     kill one link and what is under it
//   passcontrol agent revoke-delegation <agent-id> --all     kill every delegation issued before now
//
// Run as real processes against a fake control API, as tests/cli-sessions.test.ts does.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));
const AGENT = "f9de697b-6b2f-4d29-9978-0ff9547f15f3";
const JTI = "Zq3k9VbX2mN8pL4tR7sW1y";
const KEY = `pc_${"b".repeat(40)}`;
const WORKER = "Wk7mYtq0aJ3n5xR2pL8sV4cE1uF6hG9iK0oP3dQ2bZA";

let server: Server;
let origin = "";
let requests: { method?: string; url?: string; body: string }[] = [];
let immediate = true;

const LISTING = [
  {
    jti: JTI,
    depth: 1,
    parent_jti: null,
    worker_key: WORKER,
    cap_microcents: 1_000_000,
    scope: [{ provider: "anthropic", models: ["claude-haiku-5-5"] }],
    issued_at: "2026-10-10T12:00:00Z",
    expires_at: "2099-10-10T12:10:00Z",
    first_exchanged_at: "2026-10-10T12:00:05Z",
    revoked: false,
  },
  {
    jti: "Aa1Bb2Cc3Dd4Ee5Ff6Gg7H",
    depth: 2,
    parent_jti: JTI,
    worker_key: WORKER,
    cap_microcents: 500_000,
    scope: [{ provider: "anthropic", models: ["claude-haiku-5-5"] }],
    issued_at: "2026-10-10T12:01:00Z",
    expires_at: "2099-10-10T12:05:00Z",
    first_exchanged_at: "2026-10-10T12:01:05Z",
    revoked: true,
  },
];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body });
      res.setHeader("content-type", "application/json");
      if (req.url === `/api/control/v1/agents/${AGENT}/delegations` && req.method === "GET") {
        return res.end(JSON.stringify({ data: LISTING }));
      }
      if (req.url === `/api/control/v1/agents/${AGENT}/delegations/revoke` && req.method === "POST") {
        const parsed = JSON.parse(body || "{}");
        return res.end(JSON.stringify({ data: { id: AGENT, revoked: parsed.all ? "all_before_now" : parsed.jti, immediate } }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: "not_found", message: "Resource not found.", request_id: "r" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  origin = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  requests = [];
  immediate = true;
});

function run(args: string[]) {
  const home = mkdtempSync(join(tmpdir(), "pc-delegations-"));
  return new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: home,
        NO_COLOR: "1",
        CI: "1",
        PASSCONTROL_GATEWAY: origin,
        PASSCONTROL_API_KEY: KEY,
      } as unknown as NodeJS.ProcessEnv,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

describe("passcontrol agent delegations", () => {
  it("prints the agent's delegations as JSON", async () => {
    const r = await run(["agent", "delegations", AGENT, "--json"]);
    expect(r.code).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: "GET", url: `/api/control/v1/agents/${AGENT}/delegations` });
    expect(JSON.parse(r.out)).toEqual(LISTING);
  });

  it("shows each link's status, cap and worker, and says which links can appear", async () => {
    const r = await run(["agent", "delegations", AGENT]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(JTI);
    expect(r.out).toContain("$0.01");
    expect(r.out).toMatch(/active/);
    expect(r.out).toMatch(/revoked/);
    expect(r.out).toContain(WORKER.slice(0, 12));
    // A delegation is made offline: only links a worker has exchanged are known here.
    expect(r.out).toMatch(/only delegations a worker has used/i);
  });

  it("needs an agent id", async () => {
    const r = await run(["agent", "delegations"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Usage: passcontrol agent delegations <agent-id>/);
    expect(requests).toHaveLength(0);
  });
});

describe("passcontrol agent revoke-delegation", () => {
  it("revokes one delegation by jti", async () => {
    const r = await run(["agent", "revoke-delegation", AGENT, JTI]);
    expect(r.code).toBe(0);
    expect(requests.at(-1)).toMatchObject({ method: "POST", url: `/api/control/v1/agents/${AGENT}/delegations/revoke` });
    expect(JSON.parse(requests.at(-1)!.body)).toEqual({ jti: JTI });
    expect(r.out).toContain(JTI);
    expect(r.out).toMatch(/permanent/i);
  });

  it("revokes every delegation issued before now with --all", async () => {
    const r = await run(["agent", "revoke-delegation", AGENT, "--all"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(requests.at(-1)!.body)).toEqual({ all: true });
    expect(r.out).toMatch(/every delegation/i);
  });

  it("says when the gateway could not apply it at once", async () => {
    immediate = false;
    const r = await run(["agent", "revoke-delegation", AGENT, JTI]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/5 minutes/);
  });

  it.each([
    [["agent", "revoke-delegation"]],
    [["agent", "revoke-delegation", AGENT]],
    [["agent", "revoke-delegation", AGENT, JTI, "--all"]],
  ])("refuses an ambiguous request %j without calling the gateway", async (args) => {
    const r = await run(args);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Usage: passcontrol agent revoke-delegation <agent-id> <jti>\|--all/);
    expect(requests).toHaveLength(0);
  });
});
