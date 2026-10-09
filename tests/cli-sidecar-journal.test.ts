// The sidecar's journal (sprint Q6, D3): the user's OWN list of the receipt ids
// their calls produced, which is what makes a session seal checkable (Q4's check 4).
// Without it a seal is no stronger than a statement.
//
// It records ids, times and HTTP statuses, and nothing else: no prompts, no
// models, no headers. One file per sidecar run, owner-only. On by default,
// `--no-journal` turns it off. A journal failure never breaks a call.
//
// The sidecar also stamps every forwarded request with its run id
// (`x-passcontrol-run`): the fallback session for a client that declares none.
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// @ts-expect-error plain ESM CLI module
import { createSidecar } from "../cli/sidecar.mjs";
// @ts-expect-error plain ESM CLI module
import { defaultJournalDir, openJournal } from "../cli/journal.mjs";

const SEED = Buffer.alloc(32, 3).toString("base64url");
const RECEIPT = "3760d663-a0ad-4527-adc7-f50b530d357c";

type Seen = { url: string; headers: IncomingMessage["headers"] };
let gateway: Server;
let gatewayOrigin = "";
let seen: Seen[] = [];
let receiptHeader: string | null = RECEIPT;
let streamed = false;
const closers: (() => Promise<void>)[] = [];

const listen = (s: Server) =>
  new Promise<string>((resolve) =>
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      resolve(`http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`);
    })
  );
const close = (s: Server) => new Promise<void>((resolve) => s.close(() => resolve()));

beforeEach(async () => {
  seen = [];
  receiptHeader = RECEIPT;
  streamed = false;
  gateway = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    req.resume();
    if (req.url === "/api/auth/challenge") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ visa: "fake.visa.token", expires_in: 300 }));
      return;
    }
    const headers: Record<string, string> = { "content-type": streamed ? "text/event-stream" : "application/json" };
    if (receiptHeader !== null) headers["x-passcontrol-receipt-id"] = receiptHeader;
    res.writeHead(200, headers);
    if (streamed) {
      res.write("data: {}\n\n");
      setTimeout(() => res.end("data: [DONE]\n\n"), 20);
    } else {
      res.end("{}");
    }
  });
  gatewayOrigin = await listen(gateway);
});

afterEach(async () => {
  while (closers.length) await closers.pop()!();
  await close(gateway);
});

async function sidecar(journal: unknown, runId = "run-test-1") {
  const { server } = createSidecar({ gateway: gatewayOrigin, passportId: "pid", passportSecret: SEED, port: 0, journal, runId, onRefusal: () => {} });
  const origin = await listen(server);
  closers.push(() => close(server));
  return origin;
}

const post = (origin: string, headers: Record<string, string> = {}) =>
  fetch(`${origin}/api/v1/anthropic/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "ignored", ...headers },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "a secret prompt" }] }),
  }).then(async (r) => ({ status: r.status, text: await r.text() }));

const lines = (file: string) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const tempDir = () => mkdtempSync(join(tmpdir(), "pc-journal-"));

describe("the journal file", () => {
  it("records the receipt id, time and status of each relayed call, and nothing else", async () => {
    const dir = tempDir();
    const journal = openJournal({ dir, runId: "run-test-1" });
    const origin = await sidecar(journal);
    expect((await post(origin)).status).toBe(200);
    const [file] = readdirSync(dir);
    const entries = lines(join(dir, file!));
    expect(entries).toHaveLength(1);
    // `ses`: the session the call declared, so a seal is checked against its own
    // session's calls only (cli/declared-session.mjs); with none, this run's id.
    expect(Object.keys(entries[0]).sort()).toEqual(["id", "s", "ses", "t"]);
    expect(entries[0]).toMatchObject({ id: RECEIPT, s: 200, ses: "run-test-1" });
    expect(typeof entries[0].t).toBe("number");
    expect(readFileSync(join(dir, file!), "utf8")).not.toContain("secret prompt");
  });

  it("records the session a Claude Code call declared", async () => {
    const dir = tempDir();
    const journal = openJournal({ dir, runId: "run-test-1" });
    const origin = await sidecar(journal);
    expect((await post(origin, { "x-claude-code-session-id": "cc-session-1" })).status).toBe(200);
    const [file] = readdirSync(dir);
    expect(lines(join(dir, file!))[0]).toMatchObject({ ses: "cc-session-1" });
  });

  it("is owner-only: the file 0600 inside a 0700 directory", async () => {
    const dir = join(tempDir(), "journal");
    const journal = openJournal({ dir, runId: "run-test-1" });
    await post(await sidecar(journal));
    const [file] = readdirSync(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, file!)).mode & 0o777).toBe(0o600);
  });

  it("names one file per run, by start time and run id", async () => {
    const dir = tempDir();
    const journal = openJournal({ dir, runId: "run-test-1", now: () => Date.UTC(2026, 9, 8, 3, 21, 0) });
    await post(await sidecar(journal));
    expect(readdirSync(dir)).toEqual(["2026-10-08T03-21-00Z-run-test-1.jsonl"]);
    expect(journal.path).toBe(join(dir, "2026-10-08T03-21-00Z-run-test-1.jsonl"));
  });

  it("creates nothing until a call produces a receipt", async () => {
    const dir = join(tempDir(), "journal");
    openJournal({ dir, runId: "run-test-1" });
    receiptHeader = null;
    await post(await sidecar(openJournal({ dir, runId: "run-test-2" })));
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("records a streamed call", async () => {
    streamed = true;
    const dir = tempDir();
    await post(await sidecar(openJournal({ dir, runId: "run-test-1" })));
    expect(lines(join(dir, readdirSync(dir)[0]!))).toMatchObject([{ id: RECEIPT, s: 200 }]);
  });

  // (A control character cannot arrive at all: Node refuses to send or parse one in a header.)
  it.each(["x".repeat(129), "has space", "a/b", "<x>", ""])("does not record a receipt id it cannot trust the shape of: %j", async (bad) => {
    receiptHeader = bad;
    const dir = tempDir();
    await post(await sidecar(openJournal({ dir, runId: "run-test-1" })));
    expect(readdirSync(dir)).toEqual([]);
  });

  it("never breaks a call when the journal cannot be written, and says so once", async () => {
    const dir = tempDir();
    chmodSync(dir, 0o500);
    const errors: unknown[] = [];
    const journal = openJournal({ dir: join(dir, "nope"), runId: "run-test-1", onError: (e: unknown) => errors.push(e) });
    const origin = await sidecar(journal);
    expect((await post(origin)).status).toBe(200);
    expect((await post(origin)).status).toBe(200);
    expect(errors).toHaveLength(1);
    chmodSync(dir, 0o700);
  });

  it("defaults under the CLI config directory", () => {
    expect(defaultJournalDir({ XDG_CONFIG_HOME: "/x" })).toBe("/x/passcontrol/journal");
  });
});

describe("the run id", () => {
  it("is stamped on every forwarded request, journal or not", async () => {
    const origin = await sidecar(null, "run-abc");
    await post(origin);
    const call = seen.find((s) => s.url.startsWith("/api/v1/"))!;
    expect(call.headers["x-passcontrol-run"]).toBe("run-abc");
  });

  it("replaces one the client sent: only the sidecar names its own run", async () => {
    const origin = await sidecar(null, "run-abc");
    await post(origin, { "x-passcontrol-run": "forged" });
    expect(seen.find((s) => s.url.startsWith("/api/v1/"))!.headers["x-passcontrol-run"]).toBe("run-abc");
  });
});

describe("`passcontrol sidecar --no-journal`", () => {
  const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));

  async function freePort() {
    const s = createServer();
    const url = await listen(s);
    await close(s);
    return Number(new URL(url).port);
  }

  async function runSidecar(extra: string[]) {
    const home = tempDir();
    const port = await freePort();
    const child = spawn(process.execPath, [CLI, "sidecar", "--port", String(port), ...extra], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: home,
        PASSCONTROL_GATEWAY: gatewayOrigin,
        PASSPORT_ID: "pid",
        PASSPORT_SECRET: SEED,
        NO_COLOR: "1",
        CI: "1",
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    closers.push(async () => {
      child.kill();
    });
    const origin = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50 && !out.includes("Listening on"); i++) await new Promise((r) => setTimeout(r, 100));
    await post(origin);
    return { home, out: () => out };
  }

  it("journals by default and says where", async () => {
    const { home, out } = await runSidecar([]);
    const dir = join(home, "passcontrol", "journal");
    expect(readdirSync(dir)).toHaveLength(1);
    expect(out()).toContain(dir);
  });

  it("writes nothing with --no-journal, and says the journal is off", async () => {
    const { home, out } = await runSidecar(["--no-journal"]);
    expect(existsSync(join(home, "passcontrol", "journal"))).toBe(false);
    expect(out()).toMatch(/journal: off/i);
  });
});

