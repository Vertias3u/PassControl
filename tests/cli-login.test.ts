// `passcontrol login` driven end to end against a stub gateway.
//
// tests/cli-login-shape.test.ts greps the source for the two designs that must
// never come back. This file runs the command. The distinction matters here more
// than usual: three of the assertions below are for bugs that a source grep
// cannot see at all — a config write that blanks unrelated keys, a file left
// world-readable, and a private key that would have to appear in a request body
// to leak.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CLI_LOGIN = new URL("../cli/login.mjs", import.meta.url).href;

const RECEIPT_ID = "11111111-2222-4333-8444-555555555555";

/**
 * A REAL Ed25519 receipt, signed here and verified by the real cli/verify.mjs
 * against a JWKS this stub publishes.
 *
 * A canned string would have made the happy-path assertion vacuous: verifyReceipt
 * would return `bad_signature`, login would print the unverified wording, and the
 * test would still pass if the whole verification step were deleted. The point of
 * this feature is the receipt actually verifying, so the test has to actually
 * verify one.
 */
const RECEIPT_KEY = ed25519.utils.randomPrivateKey();
const b64u = (b: Uint8Array | string) =>
  Buffer.from(b as never).toString("base64url").replace(/=+$/u, "");

function jwk() {
  return { kty: "OKP", crv: "Ed25519", x: b64u(ed25519.getPublicKey(RECEIPT_KEY)), kid: "test-kid" };
}

function signedReceipt(issuerOrigin?: string) {
  const header = b64u(JSON.stringify({ alg: "EdDSA", typ: "passcontrol-receipt+jwt", kid: "test-kid" }));
  const claims = b64u(
    JSON.stringify({
      iss: issuerOrigin ?? ISSUER.value,
      sub: "passport-under-test",
      ver: 1,
      provider: "demo",
      model: "demo-1",
      status: "ok",
    })
  );
  const sig = b64u(ed25519.sign(new TextEncoder().encode(`${header}.${claims}`), RECEIPT_KEY));
  return `${header}.${claims}.${sig}`;
}

// The issuer inside the receipt has to equal the origin login verifies against,
// and that origin is a random port chosen per test. Set before the login runs.
const ISSUER = { value: "" };

interface Seen {
  url: string;
  method: string;
  body: string;
  auth: string | null;
}

/** A gateway that approves on the second poll. */
function stubGateway(
  opts: {
    agents?: unknown[];
    verificationUri?: (port: number) => string;
    demo?: "on" | "off";
    receipts?: "on" | "off";
    jws?: string;
  } = {}
) {
  const seen: Seen[] = [];
  let polls = 0;
  let jwsOverride: string | null = opts.jws ?? null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const port = (server.address() as { port: number }).port;
      seen.push({ url: req.url ?? "", method: req.method ?? "", body, auth: req.headers.authorization ?? null });
      const send = (status: number, obj: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (req.url === "/api/auth/device/start") {
        return send(200, {
          device_code: "d".repeat(43),
          user_code: "FKDR8T2W",
          verification_uri: opts.verificationUri?.(port) ?? `http://127.0.0.1:${port}/dashboard/cli`,
          expires_in: 600,
          interval: 1,
        });
      }
      if (req.url === "/api/auth/device/token") {
        polls += 1;
        return polls < 2
          ? send(202, { error: "authorization_pending" })
          : send(200, { api_key: `pc_${"k".repeat(43)}`, prefix: "pc_kkkkkkkk" });
      }
      // `{ data: ... }`, because that is what lib/control/respond.ts actually
      // sends. These stubs used to answer `{ agents: [...] }` and a bare agent
      // object — shapes invented to match the CLI's reader rather than the route,
      // which is how a stub ends up certifying the bug it was written beside.
      if (req.url === "/api/control/v1/agents" && req.method === "GET") {
        return send(200, { data: opts.agents ?? [] });
      }
      if (req.url === "/api/control/v1/agents" && req.method === "POST") {
        return send(201, { data: { id: "agent-123", name: "test-host" } });
      }
      if (/^\/api\/control\/v1\/agents\/[^/]+\/rotate$/u.test(req.url ?? "")) {
        return send(200, { data: { previous_valid_until: "2026-09-01T00:00:00.000Z" } });
      }
      // ── the proof chain ────────────────────────────────────────────────────
      if (req.url === "/api/auth/challenge") {
        return send(200, { visa: "visa-token", expires_in: 300 });
      }
      if (req.url === "/api/v1/demo/chat/completions") {
        // `demo` is env-gated OFF by default, so 404 here is the real behaviour
        // of a self-hosted gateway without PASSCONTROL_DEMO=1 — not an error.
        if (opts.demo === "off") return send(404, { error: "unknown_provider" });
        res.writeHead(200, {
          "content-type": "application/json",
          "x-passcontrol-receipt-id": RECEIPT_ID,
        });
        return res.end(JSON.stringify({
          choices: [{ message: { content: "[demo] hello there" } }],
          usage: { total_tokens: 12 },
          model: "demo-1",
        }));
      }
      if (req.url === `/api/control/v1/receipts/${RECEIPT_ID}`) {
        return opts.receipts === "off"
          ? send(200, { data: { id: RECEIPT_ID, receipt: null, reason: "receipts_not_enabled" } })
          : send(200, { data: { id: RECEIPT_ID, receipt: jwsOverride ?? signedReceipt(), provider: "demo", model: "demo-1" } });
      }
      if (req.url === "/.well-known/jwks.json") {
        return send(200, { keys: [jwk()] });
      }
      return send(404, { error: "not_found" });
    });
  });
  return {
    server,
    seen,
    /** Late-bound: the issuer inside a receipt is a port chosen when the server listens. */
    setJws: (value: string) => {
      jwsOverride = value;
    },
  };
}

let home: string;
let configFile: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ["XDG_CONFIG_HOME", "PASSCONTROL_GATEWAY", "PROVIDER", "MODEL", "PASSPORT_ID", "PASSPORT_SECRET", "PASSCONTROL_API_KEY"]) {
    savedEnv[key] = process.env[key];
  }
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-login-test-"));
  process.env.XDG_CONFIG_HOME = path.join(home, "config");
  configFile = path.join(process.env.XDG_CONFIG_HOME, "passcontrol", "config");
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * Import cli/login.mjs against the CURRENT environment.
 *
 * `vi.resetModules()` is load-bearing, not hygiene. cli/config.mjs reads
 * process.env once at import time and exports a frozen `config` object, and
 * login.mjs imports it with a static specifier — so a cache-busting query on
 * login.mjs alone re-runs login.mjs against the FIRST test's gateway. That made
 * five tests here fail against a server that had already been closed, which
 * looks exactly like a bug in the code under test.
 */
async function importLogin() {
  vi.resetModules();
  return import(`${CLI_LOGIN}?t=${Math.random()}`);
}

/**
 * A clock the test owns, so the poll loop's waiting costs nothing.
 *
 * `pollForGrant` sleeps between polls and gives up after ninety seconds of
 * continuous transport failure. Driven with the real clock those are ninety real
 * seconds, and this ONE file took 119s of a 120s suite — the give-up test alone
 * was 95s of it. Nothing about that duration was under test; the loop compares
 * two numbers.
 *
 * Both halves must be replaced together. `sleep` advances `t` by exactly the
 * requested interval, so backoff, the grace window and the code deadline all
 * still relate to each other the way they do in production — the test asserts on
 * the SAME arithmetic, just not in real time.
 */
function virtualClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    elapsed: () => t - 1_000_000,
  };
}

async function runLogin(port: number, opts: Record<string, unknown> = {}) {
  process.env.PASSCONTROL_GATEWAY = `http://127.0.0.1:${port}`;
  const opened: string[] = [];
  const mod = await importLogin();
  const clock = virtualClock();
  const result = await mod.loginCommand(
    { name: "test-host", ...opts },
    { openUrl: (u: string) => opened.push(u), now: clock.now, sleep: clock.sleep }
  );
  return { result, opened };
}

async function withGateway<T>(
  stub: ReturnType<typeof stubGateway>,
  work: (port: number) => Promise<T>
): Promise<T> {
  await new Promise<void>((r) => stub.server.listen(0, "127.0.0.1", () => r()));
  try {
    return await work((stub.server.address() as { port: number }).port);
  } finally {
    stub.server.close();
  }
}

describe("passcontrol login writes a working config", () => {
  it("polls, redeems, and writes every credential key", async () => {
    const stub = stubGateway();
    const { result, opened } = await withGateway(stub, (port) => runLogin(port).then((r) => r));
    const written = fs.readFileSync(configFile, "utf8");

    expect(written).toMatch(/PASSPORT_ID=[A-Za-z0-9_-]{43}/u);
    expect(written).toMatch(/PASSPORT_SECRET=[A-Za-z0-9_-]{43}/u);
    expect(written).toMatch(/PASSCONTROL_API_KEY=pc_/u);
    expect(written).toMatch(/PASSCONTROL_GATEWAY=http:\/\/127\.0\.0\.1:/u);
    expect(result.agentId).toBe("agent-123");
    // It waited: a 202 on the first poll, a key on the second.
    expect(stub.seen.filter((r) => r.url === "/api/auth/device/token")).toHaveLength(2);
    expect(opened[0], "the browser is sent to a bare approval URL").toMatch(/\/dashboard\/cli$/u);
  });

  it("never puts the passport secret in an outbound request", async () => {
    // The product claim, tested rather than asserted: the private half of the
    // keypair is generated on this machine and the server only ever sees the
    // public half. Checked against EVERY captured request, not just the two that
    // obviously carry key material.
    const stub = stubGateway();
    await withGateway(stub, (port) => runLogin(port));
    const secret = fs.readFileSync(configFile, "utf8").match(/PASSPORT_SECRET=(.+)/u)?.[1] ?? "";
    expect(secret.length).toBeGreaterThan(20);
    const leaking = stub.seen.filter((r) => r.body.includes(secret)).map((r) => r.url);
    expect(leaking, "the private key must never leave the machine").toEqual([]);
    // …and the public half genuinely did go.
    expect(stub.seen.some((r) => r.body.includes("passportPubkey"))).toBe(true);
  });

  it("merges into an existing config instead of blanking it", async () => {
    // writeConfigFile emits EVERY CONFIG_KEY, so a naive three-key write wipes
    // PROVIDER, MODEL and PASSCONTROL_GATEWAY. Right result, wrong side effect,
    // and invisible until the next call runs against the wrong provider.
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, "PROVIDER=groq\nMODEL=llama-3.1-8b-instant\n");
    const stub = stubGateway();
    await withGateway(stub, (port) => runLogin(port));
    const written = fs.readFileSync(configFile, "utf8");
    expect(written).toContain("PROVIDER=groq");
    expect(written).toContain("MODEL=llama-3.1-8b-instant");
    expect(written).toMatch(/PASSPORT_SECRET=[A-Za-z0-9_-]{43}/u);
  });

  it("tightens a config that already existed as 0644", async () => {
    // Node applies the `mode` option only when it CREATES a file, so overwriting
    // a 0644 config left a passport secret world-readable. Needs the explicit
    // chmod, which is why this asserts on a PRE-EXISTING loose file.
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, "PROVIDER=groq\n", { mode: 0o644 });
    fs.chmodSync(configFile, 0o644);
    expect(fs.statSync(configFile).mode & 0o777).toBe(0o644);

    const stub = stubGateway();
    await withGateway(stub, (port) => runLogin(port));
    expect(fs.statSync(configFile).mode & 0o777, "a passport secret may not be world-readable").toBe(0o600);
  });
});

describe("passcontrol login will not destroy a passport by reflex", () => {
  it("asks before replacing an existing PASSPORT_SECRET, and enter means NO", async () => {
    // mergeConfigFile preserves PROVIDER and MODEL but necessarily REPLACES the
    // passport, and PassControl has never held a copy of that private key. `init`
    // has always asked before clobbering a config; a command built to be run
    // casually has to ask at least as loudly — and the reflex answer has to be
    // the one that changes nothing.
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    const original = "PASSPORT_ID=old-id\nPASSPORT_SECRET=old-secret-value\nPROVIDER=groq\n";
    fs.writeFileSync(configFile, original);

    const stub = stubGateway();
    const asked: string[] = [];
    const result = await withGateway(stub, async (port) => {
      process.env.PASSCONTROL_GATEWAY = `http://127.0.0.1:${port}`;
      const mod = await importLogin();
      const clock = virtualClock();
      return mod.loginCommand(
        { name: "test-host" },
        {
          openUrl: () => {},
          now: clock.now,
          sleep: clock.sleep,
          // Empty input — the operator pressed enter. cli/config.mjs's confirmYes
          // honours { default: false }, so this must resolve to "no".
          confirmYes: async (q: string, o: { default?: boolean } = {}) => {
            asked.push(q);
            return o.default !== false;
          },
        }
      );
    });

    expect(asked.some((q) => /replace/iu.test(q)), "it must actually ask").toBe(true);
    expect(fs.readFileSync(configFile, "utf8"), "the old passport must survive").toBe(original);
    expect(result.target, "and it must report that nothing was written").toBeNull();
  });

  it("replaces it when the operator says yes", async () => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, "PASSPORT_SECRET=old-secret-value\nPROVIDER=groq\n");
    const stub = stubGateway();
    await withGateway(stub, async (port) => {
      process.env.PASSCONTROL_GATEWAY = `http://127.0.0.1:${port}`;
      const mod = await importLogin();
      const clock = virtualClock();
      return mod.loginCommand(
        { name: "test-host" },
        { openUrl: () => {}, confirmYes: async () => true, now: clock.now, sleep: clock.sleep }
      );
    });
    const written = fs.readFileSync(configFile, "utf8");
    expect(written).not.toContain("old-secret-value");
    expect(written).toContain("PROVIDER=groq");
  });

  it("does not ask when there is no passport to lose", async () => {
    const stub = stubGateway();
    const asked: string[] = [];
    await withGateway(stub, async (port) => {
      process.env.PASSCONTROL_GATEWAY = `http://127.0.0.1:${port}`;
      const mod = await importLogin();
      const clock = virtualClock();
      return mod.loginCommand(
        { name: "test-host" },
        {
          openUrl: () => {},
          confirmYes: async (q: string) => { asked.push(q); return true; },
          now: clock.now,
          sleep: clock.sleep,
        }
      );
    });
    expect(asked.filter((q) => /replace/iu.test(q)), "a first login must be one command").toEqual([]);
  });
});

describe("passcontrol login works on a machine with no config at all", () => {
  it("defaults to the Cloud gateway, not localhost", async () => {
    // THE bug this command exists to avoid. `login` is the first thing a new user
    // runs — `npm i -g passcontrol && passcontrol login` — so by definition there
    // is no config yet, and cli/config.mjs's DEFAULT_GATEWAY is http://localhost:3000.
    // Inheriting that default sent every fresh install at a port with nothing on
    // it and reported `fetch failed`, which names neither the host nor the fix.
    delete process.env.PASSCONTROL_GATEWAY;
    const mod = await importLogin();
    expect(mod.resolveLoginGateway({}, {})).toBe(mod.CLOUD_GATEWAY);
    expect(mod.CLOUD_GATEWAY).toMatch(/^https:\/\//u);
    expect(mod.resolveLoginGateway({}, {})).not.toContain("localhost");
  });

  it("still honours an explicitly configured gateway", async () => {
    // Only the FALLBACK changes. A self-hoster who set the value — in the shell or
    // in a .passcontrol that cli/config.mjs injected — must still reach their own
    // instance, or this "fix" silently redirects their login to our Cloud.
    const mod = await importLogin();
    expect(mod.resolveLoginGateway({}, { PASSCONTROL_GATEWAY: "https://gw.example" })).toBe(
      "https://gw.example"
    );
  });

  it("lets --gateway win over everything", async () => {
    const mod = await importLogin();
    expect(
      mod.resolveLoginGateway({ gateway: "https://flag.example" }, { PASSCONTROL_GATEWAY: "https://env.example" })
    ).toBe("https://flag.example");
  });

  it("names the host when it cannot reach the gateway", async () => {
    // `fetch failed` is what Node says and it is useless: it names no host, so the
    // operator cannot tell a stopped local stack from a typo from an outage.
    process.env.PASSCONTROL_GATEWAY = "http://127.0.0.1:1";
    const mod = await importLogin();
    await expect(mod.loginCommand({ name: "x" }, { openUrl: () => {} })).rejects.toThrow(
      /127\.0\.0\.1:1/u
    );
  });
});

describe("passcontrol login refuses a bad destination before opening a socket", () => {
  it("rejects a non-bare gateway without making a request", async () => {
    // Port 1 is unbindable and unreachable, so if the guard runs first the error
    // is about the URL; if it runs late the error is a connection failure. Same
    // trick as tests/cli-passport-gateway.test.ts.
    process.env.PASSCONTROL_GATEWAY = "http://127.0.0.1:1/some/path";
    const mod = await importLogin();
    await expect(mod.loginCommand({ name: "x" }, { openUrl: () => {} })).rejects.toThrow(
      /bare HTTPS origin/u
    );
  });
});

describe("the approval URL is built locally, not taken on trust", () => {
  it("ignores a verification_uri that tries to pre-fill the code", async () => {
    // The rejected design, arriving from the server instead of the CLI. A gateway
    // that is wrong or compromised must not be able to choose where the operator's
    // browser goes — and must not be able to reintroduce `#code=` without a single
    // line changing in the CLI.
    const stub = stubGateway({
      verificationUri: (port) => `http://127.0.0.1:${port}/dashboard/cli#code=FKDR8T2W`,
    });
    const { opened } = await withGateway(stub, (port) => runLogin(port));
    expect(opened[0]).not.toContain("#");
    expect(opened[0]).toMatch(/\/dashboard\/cli$/u);
  });

  it("ignores a verification_uri pointing at another origin entirely", async () => {
    const stub = stubGateway({ verificationUri: () => "https://attacker.example/dashboard/cli" });
    const { opened } = await withGateway(stub, (port) => runLogin(port));
    expect(opened[0]).not.toContain("attacker.example");
    expect(opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/dashboard\/cli$/u);
  });
});

describe("a transient blip does not kill a login in progress", () => {
  it("keeps polling after a dropped request", async () => {
    // The operator is already looking at a code and waiting. Killing the login on
    // ONE failed poll means a momentary network blip — or a cold edge function —
    // costs them the whole flow and a fresh code, which is the opposite of what
    // polling is for. Only the deadline may end it.
    let polls = 0;
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const send = (status: number, obj: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        if (req.url === "/api/auth/device/start") {
          return send(200, {
            device_code: "d".repeat(43), user_code: "FKDR8T2W",
            verification_uri: `http://127.0.0.1:${(server.address() as { port: number }).port}/dashboard/cli`,
            expires_in: 600, interval: 1,
          });
        }
        if (req.url === "/api/auth/device/token") {
          polls += 1;
          // Second poll: hang up mid-request. Node surfaces this as a fetch error.
          if (polls === 2) return req.socket.destroy();
          if (polls < 4) return send(202, { error: "authorization_pending" });
          return send(200, { api_key: `pc_${"k".repeat(43)}`, prefix: "pc_kkkkkkkk" });
        }
        if (req.url === "/api/control/v1/agents" && req.method === "GET") return send(200, { agents: [] });
        if (req.url === "/api/control/v1/agents" && req.method === "POST") return send(200, { id: "a1", name: "h" });
        return send(404, { error: "not_found" });
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (server.address() as { port: number }).port;
      process.env.PASSCONTROL_GATEWAY = `http://127.0.0.1:${port}`;
      const mod = await importLogin();
      const clock = virtualClock();
      const result = await mod.loginCommand(
        { name: "blip-host" },
        { openUrl: () => {}, now: clock.now, sleep: clock.sleep }
      );
      expect(result.agentId, "the login must survive the dropped poll").toBe("a1");
      expect(polls).toBeGreaterThanOrEqual(4);
    } finally {
      server.close();
    }
  }, 30_000);
});

describe("a gateway that never comes back is not waited on forever", () => {
  it("gives up with a message naming the host, well before the code expires", async () => {
    // The other half of the retry loop. Surviving a blip must not turn into
    // "Still waiting…" for the full 600s code lifetime, which reads as a frozen
    // command and is what made this test file take sixteen minutes once.
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/api/auth/device/start") {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({
            device_code: "d".repeat(43), user_code: "FKDR8T2W",
            verification_uri: `http://127.0.0.1:${(server.address() as { port: number }).port}/dashboard/cli`,
            // A short expiry keeps the test quick; the grace window is what is
            // under test, and it is the smaller of the two bounds either way.
            expires_in: 600, interval: 1,
          }));
        }
        // Every poll dies mid-flight.
        return req.socket.destroy();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const port = (server.address() as { port: number }).port;
      process.env.PASSCONTROL_GATEWAY = `http://127.0.0.1:${port}`;
      const mod = await importLogin();
      const clock = virtualClock();
      await expect(
        mod.loginCommand(
          { name: "dead-host" },
          { openUrl: () => {}, now: clock.now, sleep: clock.sleep }
        )
      ).rejects.toThrow(new RegExp(`127\\.0\\.0\\.1:${port}`, "u"));

      // Two bounds, and the LOWER one is the half the old wall-clock assertion
      // could not make. "Gave up before 600s" is also true of a loop that quits
      // on the first dropped packet — which would throw away a login over one
      // missing response, the failure the retry loop exists to prevent. Riding
      // out at least the 90s grace is what distinguishes them.
      expect(clock.elapsed(), "it must ride out the grace window").toBeGreaterThanOrEqual(90_000);
      expect(clock.elapsed(), "and still quit well inside the code lifetime").toBeLessThan(300_000);
    } finally {
      server.close();
    }
  }, 30_000);
});

describe("the clipboard is a convenience, never a dependency", () => {
  it("returns false rather than throwing when no clipboard tool exists", async () => {
    const mod = await importLogin();
    // 'linux' selects wl-copy / xclip / xsel, none of which exist on CI here.
    await expect(mod.copyToClipboard("FKDR8T2W", { platform: "linux" })).resolves.toBe(false);
  });
});

// ── The remedy has to name the place the value actually lives ────────────────
//
// Reported from a real machine on 2026-08-28, against a CORRECT 0.7.1: the user
// has no PASSCONTROL_GATEWAY in their shell, but `~/.config/passcontrol/config`
// still holds `PASSCONTROL_GATEWAY=http://localhost:3000` from the day they ran
// the local stack. cli/config.mjs injects file values into process.env at import,
// so resolveLoginGateway sees an "environment" value and login correctly aimed at
// localhost — and then told them to *unset an environment variable that is not
// set*. Following that instruction changes nothing, which reads as a broken CLI.
//
// The precedence itself is right and must not change: a self-hoster who
// configured a gateway has to keep reaching it. What was wrong was one line of
// prose. cli/config.mjs already draws exactly this distinction for credentials —
// `configInjectedKeys` exists so "a file said so" and "the operator said so" are
// not the same statement — and this is the same distinction, applied to advice.
describe("an unreachable gateway says WHERE the origin came from", () => {
  function withGlobalConfig(body: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-cfg-"));
    fs.mkdirSync(path.join(dir, "passcontrol"), { recursive: true });
    fs.writeFileSync(path.join(dir, "passcontrol", "config"), body);
    process.env.XDG_CONFIG_HOME = dir;
    return path.join(dir, "passcontrol", "config");
  }

  it("names the config FILE, and does not tell you to unset a variable you never set", async () => {
    delete process.env.PASSCONTROL_GATEWAY;
    const file = withGlobalConfig("PASSCONTROL_GATEWAY=http://127.0.0.1:1\n");
    const mod = await importLogin();

    const error = await mod
      .loginCommand({ name: "x" }, { openUrl: () => {} })
      .then(() => null, (e: Error) => e);

    expect(error, "an unreachable gateway must throw").toBeTruthy();
    // The assertion with teeth: the PATH is present. Asserting only the absence
    // of the bad advice would pass if the bullet were simply deleted, which helps
    // nobody — the operator still would not know which file to edit.
    expect(error.message).toContain(file);
    expect(error.message).not.toMatch(/Unset PASSCONTROL_GATEWAY/u);
  });

  it("still says 'shell' when the operator really did export it", async () => {
    // The other half, and the case that makes the `configInjectedKeys` check
    // load-bearing rather than decorative: the config file ALSO sets a gateway,
    // and the shell wins over it (applyConfigSourcesToEnv only fills keys that
    // are undefined). Naming the file here would send the operator to edit a line
    // whose value never took effect — the same failure as the bug this fixes,
    // with the operands swapped.
    //
    // Written this way deliberately. A version of this test whose config file
    // mentioned no gateway passed with the injected check DELETED, because the
    // file lookup then found nothing and fell through to the right answer by
    // accident. Mutation-tested: removing the check turns this red.
    withGlobalConfig("PROVIDER=anthropic\nPASSCONTROL_GATEWAY=http://from-the-file:9\n");
    process.env.PASSCONTROL_GATEWAY = "http://127.0.0.1:1";
    const mod = await importLogin();

    const error = await mod
      .loginCommand({ name: "x" }, { openUrl: () => {} })
      .then(() => null, (e: Error) => e);

    expect(error.message).toMatch(/shell/u);
    expect(error.message).not.toMatch(/passcontrol\/config/u);
  });

  it("names the PROJECT config when both define the key — last write wins", async () => {
    // applyConfigSourcesToEnv pushes global then project and Object.assign()es in
    // order, so the project file's value is the one that reached the environment.
    // A `.find()` over the sources returns the GLOBAL path and would name a file
    // whose value was overwritten — plausible, actionable, and wrong.
    const mod = await importLogin();
    const sources = [
      { type: "global", path: "/g/passcontrol/config", values: { PASSCONTROL_GATEWAY: "http://g" } },
      { type: "project", path: "/p/.passcontrol", values: { PASSCONTROL_GATEWAY: "http://p" } },
    ];
    const source = mod.gatewaySource({}, { PASSCONTROL_GATEWAY: "http://p" }, {
      sources,
      injected: new Set(["PASSCONTROL_GATEWAY"]),
    });
    expect(source.from).toBe("file");
    expect(source.path).toBe("/p/.passcontrol");
  });

  it("blames nothing when the default Cloud origin is the unreachable one", async () => {
    // With no flag, no env and no file there is no line to edit, so advice that
    // says "edit your config" would be a wild goose chase on the one path where
    // the operator did nothing wrong.
    const mod = await importLogin();
    expect(mod.gatewaySource({}, {}, { sources: [], injected: new Set() }).from).toBe("default");
    expect(mod.gatewaySource({ gateway: "https://x.example" }, {}, { sources: [], injected: new Set() }).from).toBe("flag");
  });
});

// ── item 1 of plans/cloud-premium.md ─────────────────────────────────────────
//
// `login` used to end with homework — `Try it: passcontrol call "hi"`. It now
// ends with the product working: a visa minted from the passport it just wrote,
// one governed call through the keyless `demo` provider, and the signed receipt
// for that call verified against the gateway's own JWKS, on this machine.
//
// Every assertion below is about a DEGRADATION as much as the happy path,
// because the login is already complete and written by the time the proof runs.
// A proof that can fail a login is worse than no proof at all.
describe("login ends by proving the agent works", () => {
  async function login(
    stubOpts: Parameters<typeof stubGateway>[0] = {},
    loginOpts: Record<string, unknown> = {}
  ) {
    const stub = stubGateway(stubOpts);
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.join(" "));
    });
    try {
      const result = await withGateway(stub, async (port) => {
        ISSUER.value = `http://127.0.0.1:${port}`;
        process.env.PASSCONTROL_GATEWAY = ISSUER.value;
        const mod = await importLogin();
        const clock = virtualClock();
        return mod.loginCommand(
          { name: "test-host", ...loginOpts },
          { openUrl: () => {}, now: clock.now, sleep: clock.sleep }
        );
      });
      return { result, out: lines.join("\n"), seen: stub.seen };
    } finally {
      spy.mockRestore();
    }
  }

  it("mints a visa, makes a governed call, and verifies the receipt it gets back", async () => {
    const { result, out } = await login();

    expect(result.proof?.visa, "the passport it just wrote must authenticate").toBe(true);
    expect(result.proof?.call, "and it must be able to make one governed call").toBe(true);
    // The assertion this whole feature exists for. `verified` means cli/verify.mjs
    // checked a real Ed25519 signature against the JWKS the gateway published —
    // not that a receipt id came back.
    expect(result.proof?.receipt).toBe("verified");
    expect(out).toMatch(/receipt verified/iu);
    // And the operator is handed the command a stranger can run.
    expect(out).toMatch(/passcontrol verify receipt /u);
  });

  it("gives the agent a demo scope, because a new tenant has no provider key", async () => {
    const { seen } = await login();
    const create = seen.find((r) => r.url === "/api/control/v1/agents" && r.method === "POST");
    const scopes = JSON.parse(create?.body ?? "{}").scopes ?? [];
    // Without this the proof call is refused at the scope gate, and a brand-new
    // Cloud account has nothing else it can legally call: there is no provider
    // key in Vault yet.
    expect(scopes, "the keyless demo provider must be in scope").toContainEqual(
      expect.objectContaining({ provider: "demo" })
    );
    expect(scopes, "and the real provider must still be there").toContainEqual(
      expect.objectContaining({ provider: "anthropic" })
    );
  });

  it("still writes a working config when the gateway has no demo provider", async () => {
    // A self-hosted gateway without PASSCONTROL_DEMO=1 answers 404 here. That is
    // a correctly configured gateway, not a broken login.
    const { result, out } = await login({ demo: "off" });
    expect(result.target, "the config must still be written").not.toBeNull();
    expect(result.proof?.visa, "the visa half still proves the passport").toBe(true);
    expect(result.proof?.call).toBe(false);
    expect(fs.readFileSync(configFile, "utf8")).toMatch(/PASSPORT_SECRET=[A-Za-z0-9_-]{43}/u);
    expect(out).not.toMatch(/receipt verified/iu);
  });

  it("still writes a working config when the deployment signs no receipts", async () => {
    // No INSTANCE_SIGNING_KEY: the row comes back with reason
    // `receipts_not_enabled`. The call still happened and still governed.
    const { result } = await login({ receipts: "off" });
    expect(result.target).not.toBeNull();
    expect(result.proof?.call).toBe(true);
    expect(result.proof?.receipt).toBe("unavailable");
  });

  it("says so when a receipt does NOT verify, which is what makes the happy path mean anything", async () => {
    // Signed by a key the gateway does not publish. Without this case the test
    // above is vacuous: replacing the whole verification step with a hardcoded
    // "verified" would keep it green, and the one claim this feature makes —
    // that the signature was actually checked — would be unguarded.
    const wrongKey = ed25519.utils.randomPrivateKey();
    const header = b64u(JSON.stringify({ alg: "EdDSA", typ: "passcontrol-receipt+jwt", kid: "test-kid" }));
    const forge = (iss: string) => {
      const claims = b64u(JSON.stringify({ iss, sub: "x", ver: 1 }));
      const sig = b64u(ed25519.sign(new TextEncoder().encode(`${header}.${claims}`), wrongKey));
      return `${header}.${claims}.${sig}`;
    };
    // The issuer must match, or this would fail as `untrusted_issuer` and prove
    // nothing about the signature check.
    const stub = stubGateway({ jws: "placeholder" });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => lines.push(a.join(" ")));
    let result: { proof?: { receipt?: string }; target?: string | null } = {};
    try {
      result = await withGateway(stub, async (port) => {
        ISSUER.value = `http://127.0.0.1:${port}`;
        process.env.PASSCONTROL_GATEWAY = ISSUER.value;
        stub.setJws(forge(ISSUER.value));
        const mod = await importLogin();
        const clock = virtualClock();
        return mod.loginCommand(
          { name: "test-host" },
          { openUrl: () => {}, now: clock.now, sleep: clock.sleep }
        );
      });
    } finally {
      spy.mockRestore();
    }

    expect(result.proof?.receipt, "a bad signature must not read as verified").toBe("unverified");
    // And it still must not cost the operator their login.
    expect(result.target).not.toBeNull();
  });

  it("never sends the passport secret, not even to prove it works", async () => {
    // The proof adds three outbound requests, and one of them is a signature
    // made WITH the private key. The signature travels; the key does not.
    const { seen } = await login();
    const secret = fs.readFileSync(configFile, "utf8").match(/PASSPORT_SECRET=(.+)/u)?.[1] ?? "";
    expect(secret.length, "the test must have a secret to look for").toBeGreaterThan(20);
    for (const request of seen) {
      expect(request.body, `${request.method} ${request.url} carried the private key`).not.toContain(secret);
    }
  });
});
// ── The branch that could not run ───────────────────────────────────────────
//
// `login` offers to reuse an existing agent, warns that reuse means ROTATION,
// and defaults to creating a new one instead. None of that had a test, and none
// of it executed: the agent list was read as `response.agents` while every
// control route answers `{ data: ... }`, so the list was permanently empty and
// the whole branch was unreachable.
//
// It was invisible because the stub had been written to match the CLI's reader
// rather than the route — a stub inventing the shape it is asked about certifies
// whatever the code already does. The stubs above now answer `{ data: ... }`,
// which is what lib/control/respond.ts actually sends.
describe("login offers an existing agent, and warns what reuse costs", () => {
  const AGENTS = [{ id: "a1", name: "prod-summarizer", passport_pubkey: "old-key" }];

  async function loginWith(answer: string, createNewInstead: boolean) {
    const stub = stubGateway({ agents: AGENTS });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => lines.push(a.join(" ")));
    try {
      const result = await withGateway(stub, async (port) => {
        ISSUER.value = `http://127.0.0.1:${port}`;
        process.env.PASSCONTROL_GATEWAY = ISSUER.value;
        const mod = await importLogin();
        const clock = virtualClock();
        return mod.loginCommand(
          { name: "test-host" },
          {
            openUrl: () => {},
            now: clock.now,
            sleep: clock.sleep,
            promptLine: async () => answer,
            confirmYes: async (q: string, o: { default?: boolean } = {}) =>
              /NEW agent/u.test(q) ? createNewInstead : o.default !== false,
          }
        );
      });
      return { result, out: lines.join("\n"), seen: stub.seen };
    } finally {
      spy.mockRestore();
    }
  }

  it("names the existing agents at all — the list must not be empty", async () => {
    const { out } = await loginWith("", true);
    expect(out, "the workspace's agents must be visible to the operator").toMatch(/1 agent/u);
  });

  it("warns that reuse rotates, and defaults to creating a new agent", async () => {
    const { result, out, seen } = await loginWith("a1", true);
    expect(out, "rotation is destructive elsewhere and must be said out loud").toMatch(/rotates it/u);
    // Enter on that prompt means "yes, make a new one" — the safe answer.
    expect(seen.some((r) => /\/rotate$/u.test(r.url)), "nothing may be rotated by default").toBe(false);
    expect(result.agentId).toBe("agent-123");
  });

  it("rotates only when the operator declines the new agent", async () => {
    const { seen } = await loginWith("a1", false);
    expect(seen.some((r) => r.url === "/api/control/v1/agents/a1/rotate")).toBe(true);
  });
});
