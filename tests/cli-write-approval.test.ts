// Review C-01: the key `passcontrol login` saves is read-only, so a command that
// changes something asks for a one-command key, approved in the browser, held in
// memory only and revoked when the command ends.
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error plain ESM CLI module
import * as approval from "../cli/write-approval.mjs";

const execFileAsync = promisify(execFile);
const CLI = path.join(process.cwd(), "bin/passcontrol.mjs");
const STORED = `pc_${"r".repeat(43)}`;
const ONE_SHOT = `pc_${"w".repeat(43)}`;

describe("cli/write-approval.mjs", () => {
  afterEach(async () => {
    await approval.releaseWriteKey();
  });

  it("names the command words only, never its arguments", () => {
    expect(approval.commandLabel(["agents", "resume", "8f1e-secret-ish"])).toBe("agents resume");
    expect(approval.commandLabel(["kill", "off"])).toBe("kill off");
    expect(approval.commandLabel([])).toBe("a command");
  });

  it("refuses at once without a terminal: nobody would see the code", async () => {
    const approve = vi.fn();
    await expect(
      approval.obtainWriteKey("https://gw.test", { command: "kill off", interactive: false, approve })
    ).rejects.toThrow(/read-only[\s\S]*terminal/u);
    expect(approve).not.toHaveBeenCalled();
    expect(approval.heldWriteKey("https://gw.test")).toBeNull();
  });

  it("asks the browser once, holds the key for this origin only, and revokes it on release", async () => {
    const approve = vi.fn(async () => ({ api_key: ONE_SHOT }));
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const key = await approval.obtainWriteKey("https://gw.test", {
      command: "kill off", interactive: true, approve, fetchImpl, hostname: "laptop",
    });
    expect(key).toBe(ONE_SHOT);
    expect(approve).toHaveBeenCalledWith("https://gw.test", expect.objectContaining({
      clientName: "one command - kill off - laptop",
      title: "Approve this command",
    }));
    // A second write in the same command reuses it; another origin does not get it.
    await approval.obtainWriteKey("https://gw.test", { interactive: true, approve, fetchImpl });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approval.heldWriteKey("https://other.test")).toBeNull();

    expect(await approval.releaseWriteKey()).toEqual({ released: true });
    expect(fetchImpl).toHaveBeenCalledWith("https://gw.test/api/control/v1/keys/self/revoke", expect.objectContaining({
      method: "POST",
      headers: { authorization: `Bearer ${ONE_SHOT}` },
    }));
    expect(approval.heldWriteKey("https://gw.test")).toBeNull();
    expect(await approval.releaseWriteKey()).toEqual({ released: false });
  });

  it("Ctrl-C while the key is held revokes it, then exits 130; released, it leaves no handler", async () => {
    const before = process.listenerCount("SIGINT");
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await approval.obtainWriteKey("https://gw.test", {
        command: "kill off", interactive: true, fetchImpl, approve: async () => ({ api_key: ONE_SHOT }),
      });
      expect(process.listenerCount("SIGINT")).toBe(before + 1);
      process.emit("SIGINT", "SIGINT");
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(130));
      expect(fetchImpl).toHaveBeenCalledWith("https://gw.test/api/control/v1/keys/self/revoke", expect.anything());
      expect(process.listenerCount("SIGINT")).toBe(before);
    } finally {
      exit.mockRestore();
    }
  });
});

describe("cli/lowered-keys.mjs", () => {
  it("a key login saved read-only is never sent to be lowered; a failed lowering is retried", async () => {
    // @ts-expect-error plain ESM CLI module
    const lowered = await import("../cli/lowered-keys.mjs");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-lowered-"));
    const stateFile = lowered.loweredKeysFile(path.join(dir, "config"));
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 404 }));
    // An older gateway (no route): nothing is noted, so the next command tries again.
    expect(await lowered.lowerStoredKeyOnce({ origin: "https://gw.test", key: STORED, stateFile, fetchImpl })).toEqual({ lowered: false });
    expect(fs.existsSync(stateFile)).toBe(false);
    lowered.rememberReadKey(STORED, stateFile);
    fetchImpl.mockClear();
    expect(await lowered.lowerStoredKeyOnce({ origin: "https://gw.test", key: STORED, stateFile, fetchImpl })).toEqual({ lowered: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fs.readFileSync(stateFile, "utf8")).not.toContain(STORED);
    if (process.platform !== "win32") expect(fs.statSync(stateFile).mode & 0o077).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("`passcontrol kill off` with the read-only key login saved", () => {
  let home: string;
  let server: http.Server;
  let port: number;
  let seen: { method: string; url: string; auth: string }[];
  let killScope: "read" | "write";

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-write-approval-"));
    seen = [];
    killScope = "read";
    server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization ?? "" });
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/control/v1/keys/self/downgrade" && req.method === "POST") {
          killScope = "read";
          return res.end(JSON.stringify({ data: { scope: "read", prefix: "pc_rrrrrrrr" } }));
        }
        if (req.url === "/api/control/v1/kill-switch" && req.method === "PUT") {
          if (killScope === "read") {
            res.writeHead(403);
            return res.end(JSON.stringify({ error: { code: "insufficient_scope", message: "write scope required" } }));
          }
          return res.end(JSON.stringify({ data: { armed: false, affected: 1 } }));
        }
        res.writeHead(404);
        res.end(JSON.stringify({ error: { code: "not_found" } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
    const dir = path.join(home, "config", "passcontrol");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config"), `PASSCONTROL_GATEWAY=http://127.0.0.1:${port}\nPASSCONTROL_API_KEY=${STORED}\n`);
  });

  afterEach(() => {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function run(args: string[]) {
    try {
      const r = await execFileAsync(process.execPath, [CLI, ...args], {
        cwd: home,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, "config"),
          NO_COLOR: "1",
          NODE_ENV: "test",
          PASSCONTROL_FORCE_INSTALLED: "1",
          PASSCONTROL_NO_UPDATE_CHECK: "1",
        },
        timeout: 20_000,
      });
      return { code: 0, out: `${r.stdout}${r.stderr}` };
    } catch (error) {
      const e = error as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  }

  it("is refused without a terminal, says why, and sends the change once", async () => {
    const r = await run(["kill", "off"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/passcontrol kill off.*changes something.*read-only/u);
    expect(seen.filter((s) => s.method === "PUT")).toHaveLength(1);
    expect(seen.every((s) => s.auth === `Bearer ${STORED}`)).toBe(true);
  });

  // Owner 2026-11-15 ("lower old write keys"): a key saved by a login from before this
  // release is lowered BEFORE the first command uses it, so it never makes one more
  // unapproved change. Once per install: the lowered key's hash is remembered.
  it("lowers an old write key before its first use, once, and the change then needs approval", async () => {
    killScope = "write";
    const r = await run(["kill", "off"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/read-only now/u);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      "POST /api/control/v1/keys/self/downgrade",
      "PUT /api/control/v1/kill-switch",
    ]);
    // The second command does not ask again.
    seen.length = 0;
    await run(["kill", "off"]);
    expect(seen.map((s) => s.url)).toEqual(["/api/control/v1/kill-switch"]);
    // Only a hash is kept, never the key.
    const state = fs.readFileSync(path.join(home, "config", "passcontrol", "lowered-keys.json"), "utf8");
    expect(state).not.toContain(STORED);
  });

  it("never touches a key passed in the shell: that is the owner's escape hatch for one write", async () => {
    killScope = "write";
    const r = await execFileAsync(process.execPath, [CLI, "kill", "off"], {
      cwd: home,
      env: {
        PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: path.join(home, "config"), NO_COLOR: "1",
        NODE_ENV: "test", PASSCONTROL_FORCE_INSTALLED: "1", PASSCONTROL_NO_UPDATE_CHECK: "1",
        PASSCONTROL_API_KEY: ONE_SHOT,
      },
      timeout: 20_000,
    });
    expect(`${r.stdout}${r.stderr}`).toMatch(/disarmed/u);
    expect(seen.map((s) => s.url)).toEqual(["/api/control/v1/kill-switch"]);
  });
});
