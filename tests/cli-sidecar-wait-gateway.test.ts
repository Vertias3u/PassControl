// `passcontrol sidecar` started before its gateway is up (sprint T2). 1.4.0 printed
// "✗ could not mint initial visa: fetch failed" and carried on listening: it looked
// fatal, said nothing when the gateway came up, and a REFUSED passport got the same
// treatment, so a sidecar holding a wrong or revoked passport sat there answering
// every call with a 502.
//
// Now:
//   * a gateway that is not answering (no connection, 5xx, 408, 429) is waited for,
//     with backoff, and the sidecar says so, then says when it is up;
//   * a gateway that answers and refuses the passport (any other 4xx) ends the
//     process at once with the gateway's reason. Retrying a refusal can only fail
//     again, and a sidecar that cannot mint must not look like it is running.
// Run as real processes, the way a person starts it.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error plain ESM CLI module
import { isPassportRefusal, warmVisa } from "../cli/sidecar.mjs";

const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));
const SEED = Buffer.alloc(32, 7).toString("base64url");

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

function freePort() {
  return new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function gatewayOn(port: number, answer: (res: import("node:http").ServerResponse) => void) {
  return new Promise<Server>((resolve) => {
    const s = createServer((req, res) => {
      req.resume();
      if (req.url === "/api/auth/challenge") return answer(res);
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    s.listen(port, "127.0.0.1", () => resolve(s));
    closers.push(() => new Promise<void>((r) => s.close(() => r())));
  });
}

const visaAnswer = (res: import("node:http").ServerResponse) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ visa: "fake.visa.token", expires_in: 300 }));
};

function runSidecar(gatewayPort: number) {
  const home = mkdtempSync(join(tmpdir(), "pc-sidecar-wait-"));
  return freePort().then((port) => {
    const child: ChildProcess = spawn(process.execPath, [CLI, "sidecar", "--port", String(port), "--no-journal"], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        XDG_CONFIG_HOME: home,
        PASSCONTROL_GATEWAY: `http://127.0.0.1:${gatewayPort}`,
        PASSPORT_ID: "pid",
        PASSPORT_SECRET: SEED,
        NO_COLOR: "1",
        CI: "1",
      } as unknown as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let exitCode: number | null = null;
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (out += d));
    child.on("exit", (code) => (exitCode = code ?? -1));
    closers.push(() => {
      if (exitCode === null) child.kill();
    });
    return { port, out: () => out, exitCode: () => exitCode };
  });
}

async function until(check: () => boolean, ms = 15_000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return check();
}

describe("a sidecar started before its gateway", () => {
  it("says it is waiting, keeps running, and mints its visa once the gateway is up", async () => {
    const gatewayPort = await freePort();
    const s = await runSidecar(gatewayPort);
    expect(await until(() => /not answering yet/i.test(s.out()))).toBe(true);
    expect(s.out()).not.toMatch(/✗/);
    expect(s.exitCode()).toBeNull();
    await gatewayOn(gatewayPort, visaAnswer);
    expect(await until(() => /visa warmed/i.test(s.out()))).toBe(true);
    expect(s.out()).toMatch(/is answering now/i);
    expect(s.exitCode()).toBeNull();
  }, 30_000);

  it("waits through a gateway that answers 503 while it starts", async () => {
    const gatewayPort = await freePort();
    let ready = false;
    await gatewayOn(gatewayPort, (res) => {
      if (!ready) {
        res.statusCode = 503;
        return res.end("starting");
      }
      visaAnswer(res);
    });
    const s = await runSidecar(gatewayPort);
    expect(await until(() => /not answering yet/i.test(s.out()))).toBe(true);
    ready = true;
    expect(await until(() => /visa warmed/i.test(s.out()))).toBe(true);
    expect(s.exitCode()).toBeNull();
  }, 30_000);
});

describe("a sidecar whose passport the gateway refuses", () => {
  it.each([
    [401, { error: "unknown_passport" }, /unknown_passport/],
    [403, { error: "agent_not_active" }, /suspended or revoked/],
  ])("exits at once on %s, with the gateway's reason", async (status, body, reason) => {
    const gatewayPort = await freePort();
    await gatewayOn(gatewayPort, (res) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    const s = await runSidecar(gatewayPort);
    expect(await until(() => s.exitCode() !== null, 10_000)).toBe(true);
    expect(s.exitCode()).toBe(1);
    expect(s.out()).toMatch(reason);
    expect(s.out()).not.toMatch(/not answering yet/i);
  }, 20_000);
});

describe("warmVisa", () => {
  const quiet = { ok: () => {}, warn: () => {}, fail: () => {} };
  const err = (status?: number) => Object.assign(new Error(status ? `Challenge failed: ${status}` : "fetch failed"), status ? { status } : {});

  it("backs off and caps the wait", async () => {
    const slept: number[] = [];
    let n = 0;
    const getVisa = async () => {
      if (n++ < 8) throw err();
      return "v";
    };
    const warmed = await warmVisa({ getVisa, gateway: "http://g", sleep: async (ms: number) => void slept.push(ms), onRefused: () => {}, log: quiet });
    expect(warmed).toBe(true);
    expect(slept).toEqual([1000, 2000, 4000, 8000, 15000, 30000, 30000, 30000]);
  });

  it("stops at the first refusal and hands it over", async () => {
    let refused: unknown = null;
    const warmed = await warmVisa({
      getVisa: async () => {
        throw err(401);
      },
      gateway: "http://g",
      sleep: async () => {},
      onRefused: (e: unknown) => (refused = e),
      log: quiet,
    });
    expect(warmed).toBe(false);
    expect((refused as { status: number }).status).toBe(401);
  });

  it.each([
    [undefined, false],
    [500, false],
    [502, false],
    [503, false],
    [408, false],
    [429, false],
    [400, true],
    [401, true],
    [403, true],
    [404, true],
  ])("status %s is a refusal: %s", (status, refusal) => {
    expect(isPassportRefusal(err(status as number | undefined))).toBe(refusal);
  });
});
