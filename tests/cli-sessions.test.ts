// The CLI half of session receipts (sprint Q7):
//   passcontrol sessions [--agent <id>]              list declared sessions
//   passcontrol seal <session> --agent <id> [--out]  seal one, save seal + bundle (0600)
//   passcontrol verify session <file> --journal <f>  the four checks, offline
//
// Run as real processes. `verify session` is the command a user runs against their
// own journal, so it is tested the way they run it.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bytesToBase64url } from "@/lib/encoding";
import { loadInstanceSigner, publicJwk } from "@/lib/crypto/instanceKey";
import { RECEIPT_TYP, signCompactJws } from "@/lib/crypto/jws";
import { buildSessionClaims, signSessionSeal } from "@/lib/session-seal";

const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));
const AGENT = "f9de697b-6b2f-4d29-9978-0ff9547f15f3";
const SES = "40096fd5-6963-4d1a-9695-f7cb2302600d";
const KEY = `pc_${"b".repeat(40)}`;

let server: Server;
let origin = "";
let lastControl: { method?: string; url?: string; auth?: string; body?: string } = {};
let sealed = { id: "", seal: "", bundle: [] as string[] };
// How the seal route answers: a stored seal, Next's own 404 page (a self-hosted
// gateway, where sealing is pruned as a hosted capability), or the route's JSON 404.
let sealMode: "ok" | "no-route" | "not-found" = "ok";

process.env.INSTANCE_SIGNING_KEY = bytesToBase64url(new Uint8Array(32).fill(8));

function receipt(id: string, t0: number, agt?: string) {
  const s = loadInstanceSigner()!;
  return signCompactJws({
    typ: RECEIPT_TYP, kid: s.kid, seed: s.seed,
    claims: {
      iss: origin, sub: "p", jti: id, iat: 1, agid: AGENT, prov: "anthropic", mdl: "claude-haiku-4-5",
      mth: "POST", path: "v1/messages", use: { in: 1, out: 1 }, cost: 250, res: { status: "ok", http: 200 },
      t0, lat: 1, ver: 1, ctx: { src: "declared", cli: "claude-code", ses: SES, ...(agt ? { agt } : {}) },
    },
  });
}

beforeAll(async () => {
  const s = loadInstanceSigner()!;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/.well-known/jwks.json") return res.end(JSON.stringify({ keys: [publicJwk(s.publicKey)] }));
      lastControl = { method: req.method, url: req.url, auth: req.headers.authorization, body };
      if (req.url?.startsWith("/api/control/v1/sessions/") && req.method === "POST") {
        if (sealMode === "no-route") {
          res.statusCode = 404;
          res.setHeader("content-type", "text/html");
          return res.end("<!DOCTYPE html><html><body>404: This page could not be found.</body></html>");
        }
        if (sealMode === "not-found") {
          res.statusCode = 404;
          return res.end(JSON.stringify({ error: { code: "not_found", message: "Resource not found.", request_id: "r" } }));
        }
        return res.end(JSON.stringify({ data: sealed }));
      }
      if (req.url?.startsWith("/api/control/v1/sessions")) {
        return res.end(JSON.stringify({ data: [{ agent_id: AGENT, session_id: SES, client_kind: "claude-code", calls: 2, subagents: 1, refused: 0, cost_microcents: 500, unpriced: 0, unknown_cost: 0, first_at: "2026-10-08T00:13:49Z", last_at: "2026-10-08T00:13:52Z" }] }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: { code: "not_found" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  origin = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
  process.env.PASSCONTROL_ISSUER = origin;
  const rows = [
    { receipt: receipt("r1", 1_791_000_000_000), cost_microcents: 250, unpriced: false },
    { receipt: receipt("r2", 1_791_000_001_000, "a1"), cost_microcents: 250, unpriced: false },
  ];
  const { claims, bundle } = buildSessionClaims({ issuer: origin, sealId: "seal-1", agentId: AGENT, sessionId: SES, src: "claude-code", rows });
  sealed = { id: "seal-1", seal: signSessionSeal(claims)!, bundle };
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

function run(args: string[], env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "pc-sessions-"));
  return new Promise<{ code: number; out: string; home: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: home,
      env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1", CI: "1", ...env } as unknown as NodeJS.ProcessEnv,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out, home }));
  });
}

const files = (journalIds: string[] | null) => {
  const dir = mkdtempSync(join(tmpdir(), "pc-seal-"));
  const sealFile = join(dir, "seal.json");
  writeFileSync(sealFile, JSON.stringify({ seal: sealed.seal, bundle: sealed.bundle }));
  const journalFile = join(dir, "journal.jsonl");
  if (journalIds) writeFileSync(journalFile, journalIds.map((id) => JSON.stringify({ id, t: 1, s: 200 })).join("\n") + "\n");
  return { sealFile, journalFile };
};

describe("passcontrol verify session", () => {
  it("passes all four checks against a matching journal", async () => {
    const { sealFile, journalFile } = files(["r1", "r2"]);
    const r = await run(["verify", "session", sealFile, "--journal", journalFile, "--issuer", origin]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Session seal is valid.");
    expect(r.out).toMatch(/✓ .*signature/i);
    expect(r.out).toMatch(/✓ .*bundle/i);
    expect(r.out).toMatch(/✓ .*receipts/i);
    expect(r.out).toMatch(/✓ .*journal/i);
    expect(r.out).toContain("declared by the client");
  });

  it("fails on a journaled call the seal left out, and calls it missing, never tampering", async () => {
    const { sealFile, journalFile } = files(["r1", "r2", "r-left-out"]);
    const r = await run(["verify", "session", sealFile, "--journal", journalFile, "--issuer", origin]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("r-left-out");
    expect(r.out.toLowerCase()).toContain("missing");
    expect(r.out.toLowerCase()).not.toContain("tamper");
  });

  it("without a journal: valid, and says it is no stronger than a statement", async () => {
    const { sealFile } = files(null);
    const r = await run(["verify", "session", sealFile, "--issuer", origin]);
    expect(r.code).toBe(0);
    expect(r.out.toLowerCase()).toContain("no journal");
  });

  it("a journal several sessions share: other sessions' calls are not missing", async () => {
    // One sidecar run serves many sessions (2026-10-08 E2E). Their lines name their
    // session, and only this seal's session is checked.
    const dir = mkdtempSync(join(tmpdir(), "pc-seal-"));
    const sealFile = join(dir, "seal.json");
    writeFileSync(sealFile, JSON.stringify({ seal: sealed.seal, bundle: sealed.bundle }));
    const journalFile = join(dir, "journal.jsonl");
    const line = (id: string, ses: string) => JSON.stringify({ id, t: 1, s: 200, ses });
    writeFileSync(journalFile, [line("r1", SES), line("r2", SES), line("r-elsewhere", "another-session")].join("\n") + "\n");
    const r = await run(["verify", "session", sealFile, "--journal", journalFile, "--issuer", origin]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 call(s) from other sessions");
    expect(r.out).not.toContain("r-elsewhere");
  });

  it("reports bundle receipts the journal never saw without failing", async () => {
    const { sealFile, journalFile } = files(["r1"]);
    const r = await run(["verify", "session", sealFile, "--journal", journalFile, "--issuer", origin]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("r2");
  });

  it("refuses a file that is not a seal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pc-seal-"));
    writeFileSync(join(dir, "x.json"), "{}");
    const r = await run(["verify", "session", join(dir, "x.json"), "--issuer", origin]);
    expect(r.code).toBe(1);
  });
});

describe("passcontrol seal and sessions", () => {
  const env = () => ({ PASSCONTROL_GATEWAY: origin, PASSCONTROL_API_KEY: KEY });

  it("seal saves seal and bundle to an owner-only file", async () => {
    const r = await run(["seal", SES, "--agent", AGENT], env());
    expect(r.code).toBe(0);
    expect(lastControl).toMatchObject({ method: "POST", url: `/api/control/v1/sessions/${SES}/seal`, auth: `Bearer ${KEY}` });
    expect(JSON.parse(lastControl.body!)).toEqual({ agent_id: AGENT });
    const file = join(r.home, `session-${SES}.seal.json`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ seal: sealed.seal, bundle: sealed.bundle });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(r.out).toContain("passcontrol verify session");
  });

  it("seal names the seal's own issuer in the verify command, not the gateway it called", async () => {
    // A gateway's address and the issuer it signs as can differ (self-host behind a
    // proxy; the local stack's :3001 next to :3000). The issuer is the one to trust.
    const saved = sealed;
    const rows = [{ receipt: receipt("r1", 1_791_000_000_000), cost_microcents: 250, unpriced: false }];
    const { claims, bundle } = buildSessionClaims({ issuer: "https://issuer.example", sealId: "seal-2", agentId: AGENT, sessionId: SES, src: "claude-code", rows });
    sealed = { id: "seal-2", seal: signSessionSeal(claims)!, bundle };
    try {
      const r = await run(["seal", SES, "--agent", AGENT], env());
      expect(r.out).toContain("--issuer https://issuer.example");
      expect(r.out).not.toContain(`--issuer ${origin}`);
    } finally {
      sealed = saved;
    }
  });

  it("seal against a gateway that does not seal sessions says so, and writes nothing", async () => {
    // Sealing is a hosted capability (owner, P3, 2026-10-08), but the CLI ships to
    // self-hosters too. A raw "404 <html>" would read as a broken CLI.
    sealMode = "no-route";
    try {
      const r = await run(["seal", SES, "--agent", AGENT], env());
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("does not seal sessions");
      expect(r.out).toContain("passcontrol verify session");
      expect(r.out).not.toContain("<html");
      expect(existsSync(join(r.home, `session-${SES}.seal.json`))).toBe(false);
    } finally {
      sealMode = "ok";
    }
  });

  it("seal of a session the gateway does not have says that, not that sealing is missing", async () => {
    sealMode = "not-found";
    try {
      const r = await run(["seal", SES, "--agent", AGENT], env());
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("No session");
      expect(r.out).not.toContain("does not seal sessions");
    } finally {
      sealMode = "ok";
    }
  });

  it("seal needs --agent", async () => {
    const r = await run(["seal", SES], env());
    expect(r.code).not.toBe(0);
  });

  it("sessions lists the declared sessions", async () => {
    const r = await run(["sessions", "--agent", AGENT, "--json"], env());
    expect(r.code).toBe(0);
    expect(lastControl.url).toBe(`/api/control/v1/sessions?agent_id=${AGENT}&limit=20`);
    expect(JSON.parse(r.out)[0].session_id).toBe(SES);
  });
});
