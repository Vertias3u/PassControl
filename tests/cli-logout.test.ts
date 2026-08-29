// `passcontrol logout` — item 4 of plans/cloud-premium.md.
//
// There was no way to undo a login. No `logout`, no alias, and no CLI path to
// revoke a control key at all (`revokeApiKey` is a dashboard action). The manual
// equivalent was two halves that had to both be remembered: revoke the key in
// Settings, and delete the config. Doing only one leaves either a live
// write-scoped key on the tenant or a passport secret on disk.
//
// Three properties are asserted below, and the second is the one that is easy to
// get wrong:
//
//   1. the local half ALWAYS happens — a server error must not leave credentials
//      on disk after the command has said it is logging you out;
//   2. blanking the credentials must not blank PROVIDER / MODEL / the gateway,
//      which are not credentials and which the operator did not ask to lose;
//   3. the agent is left ALONE unless asked, because clearing the config
//      destroys the only copy of its private key and a copy may live elsewhere.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const CLI_LOGOUT = new URL("../cli/logout.mjs", import.meta.url).href;
const KEY = `pc_${"k".repeat(43)}`;
const PASSPORT = "P".repeat(43);

interface Seen {
  url: string;
  method: string;
}

function stubGateway(opts: { revoke?: "ok" | "fail" | "already"; agents?: unknown[] } = {}) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      seen.push({ url: req.url ?? "", method: req.method ?? "" });
      const send = (status: number, obj: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      // The real envelope from lib/control/respond.ts. See the note in
      // tests/cli-login.test.ts: answering `{ agents: [...] }` here is what let
      // logout ship unable to find any agent at all.
      if (req.url === "/api/control/v1/agents" && req.method === "GET") {
        return send(200, {
          data: opts.agents ?? [{ id: "agent-123", name: "test-host", passport_pubkey: PASSPORT }],
        });
      }
      if (/\/api\/control\/v1\/agents\/[^/]+\/revoke$/u.test(req.url ?? "")) {
        return send(200, { ok: true });
      }
      if (req.url === "/api/control/v1/keys/self/revoke") {
        if (opts.revoke === "fail") return send(500, { error: "query_failed" });
        if (opts.revoke === "already") return send(409, { error: "already_revoked" });
        return send(200, { data: { revoked_at: "2026-08-28T00:00:00.000Z", prefix: "pc_kkkkkkkk" } });
      }
      return send(404, { error: "not_found" });
    });
  });
  return { server, seen };
}

let home: string;
let configFile: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "XDG_CONFIG_HOME",
  "PASSCONTROL_GATEWAY",
  "PROVIDER",
  "MODEL",
  "PASSPORT_ID",
  "PASSPORT_SECRET",
  "PASSCONTROL_API_KEY",
];

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // The shell must not supply what the file is supposed to. cli/config.mjs only
  // injects a config value for a key that is `undefined`, so a leftover
  // PASSPORT_SECRET here would mask a config file this test never blanked.
  for (const key of ENV_KEYS) delete process.env[key];
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-logout-test-"));
  process.env.XDG_CONFIG_HOME = path.join(home, "config");
  configFile = path.join(process.env.XDG_CONFIG_HOME, "passcontrol", "config");
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

async function importLogout() {
  vi.resetModules();
  return import(`${CLI_LOGOUT}?t=${Math.random()}`);
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

function writeConfig(port: number, extra = "") {
  fs.writeFileSync(
    configFile,
    `PASSCONTROL_GATEWAY=http://127.0.0.1:${port}\n` +
      `PASSPORT_ID=${PASSPORT}\n` +
      `PASSPORT_SECRET=${"s".repeat(43)}\n` +
      `PASSCONTROL_API_KEY=${KEY}\n` +
      `PROVIDER=groq\nMODEL=llama-3.3-70b\n${extra}`
  );
}

async function logout(
  stubOpts: Parameters<typeof stubGateway>[0] = {},
  opts: Record<string, unknown> = {},
  deps: Record<string, unknown> = {}
) {
  const stub = stubGateway(stubOpts);
  const asked: string[] = [];
  const result = await withGateway(stub, async (port) => {
    writeConfig(port);
    const mod = await importLogout();
    return mod.logoutCommand({ yes: true, ...opts }, {
      confirmYes: async (q: string, o: { default?: boolean } = {}) => {
        asked.push(q);
        return o.default !== false;
      },
      ...deps,
    });
  });
  return { result, asked, seen: stub.seen, after: fs.readFileSync(configFile, "utf8") };
}

describe("logout clears the machine and the key together", () => {
  it("revokes the control key and blanks every credential", async () => {
    const { result, seen, after } = await logout();

    expect(seen.map((r) => r.url)).toContain("/api/control/v1/keys/self/revoke");
    expect(result.keyRevoked).toBe(true);
    for (const key of ["PASSPORT_ID", "PASSPORT_SECRET", "PASSCONTROL_API_KEY"]) {
      expect(after, `${key} must be blank`).toMatch(new RegExp(`^${key}=$`, "mu"));
    }
  });

  it("keeps what is not a credential", async () => {
    // mergeConfigFile spreads over the existing values, but writeConfigFile
    // emits EVERY key — so a three-key write with the wrong helper silently
    // wipes the provider, the model and the gateway, and the next command fails
    // against a config that looks fine.
    const { after } = await logout();
    expect(after).toContain("PROVIDER=groq");
    expect(after).toContain("MODEL=llama-3.3-70b");
    expect(after).toMatch(/PASSCONTROL_GATEWAY=http:\/\/127\.0\.0\.1:\d+/u);
  });

  it("clears the machine even when the server refuses to revoke", async () => {
    // The operator asked to log out. Leaving a passport secret on disk because a
    // revoke returned 500 would be the CLI deciding, on its own, that a partial
    // logout is better than a local one. It is not.
    const { result, after } = await logout({ revoke: "fail" });
    expect(result.keyRevoked, "and it must not claim otherwise").toBe(false);
    expect(after).toMatch(/^PASSPORT_SECRET=$/mu);
    expect(result.warnings.join(" "), "the live key must be called out").toMatch(/Settings/u);
  });
});

describe("logout leaves the agent alone unless told", () => {
  it("asks, and a bare enter keeps the agent", async () => {
    const { result, asked, seen } = await logout({}, {}, {
      // Enter on a { default: false } prompt.
      confirmYes: async (_q: string, o: { default?: boolean } = {}) => o.default !== false,
    });
    expect(result.agent?.name, "it must resolve which agent this passport is").toBe("test-host");
    expect(result.agentRevoked).toBe(false);
    expect(seen.some((r) => /\/revoke$/u.test(r.url) && r.url.includes("agents"))).toBe(false);
    void asked;
  });

  it("revokes it when asked outright", async () => {
    const { result, seen } = await logout({}, { revokeAgent: true });
    expect(result.agentRevoked).toBe(true);
    expect(seen.some((r) => r.url === "/api/control/v1/agents/agent-123/revoke")).toBe(true);
  });

  it("never asks when --keep-agent said not to", async () => {
    const { result, asked } = await logout({}, { keepAgent: true });
    expect(asked.filter((q) => /revoke/iu.test(q))).toEqual([]);
    expect(result.agentRevoked).toBe(false);
  });
});

describe("logout on a machine that is not logged in", () => {
  it("says so instead of pretending it did something", async () => {
    fs.writeFileSync(configFile, "PROVIDER=groq\n");
    const mod = await importLogout();
    const result = await mod.logoutCommand({}, { confirmYes: async () => false });
    expect(result.target, "there is nothing to clear").toBeNull();
    expect(result.keyRevoked).toBe(false);
  });
});

describe("logout asks before destroying a passport it cannot give back", () => {
  // Written because it happened. A `logout` run as a smoke test against the real
  // config — one character away from `login`, and the only one of the pair that
  // asks nothing — blanked a working Cloud passport instantly. The key was
  // generated on that machine and the server has never held it, so there was
  // nothing to restore.
  it("a bare enter leaves the credentials alone", async () => {
    const stub = stubGateway();
    const result = await withGateway(stub, async (port) => {
      writeConfig(port);
      const mod = await importLogout();
      // No `yes`, and confirmYes honours { default: false } — the operator
      // pressed enter.
      return mod.logoutCommand({}, { confirmYes: async (_q: string, o: { default?: boolean } = {}) => o.default !== false });
    });

    expect(result.cancelled).toBe(true);
    const after = fs.readFileSync(configFile, "utf8");
    expect(after, "the passport must survive a bare enter").toMatch(/PASSPORT_SECRET=s{43}/u);
    // "No" must mean nothing happened — not "nothing local happened, but your
    // control key is gone". The prompt runs ahead of every server call.
    expect(stub.seen, "a declined logout must cost zero requests").toEqual([]);
    expect(result.keyRevoked).toBe(false);
    expect(result.agentRevoked).toBe(false);
  });

  it("clears it when the operator says yes", async () => {
    const stub = stubGateway();
    await withGateway(stub, async (port) => {
      writeConfig(port);
      const mod = await importLogout();
      return mod.logoutCommand({}, { confirmYes: async () => true });
    });
    expect(fs.readFileSync(configFile, "utf8")).toMatch(/^PASSPORT_SECRET=$/mu);
  });

  it("does not ask when there is no passport to lose", async () => {
    const stub = stubGateway();
    const asked: string[] = [];
    await withGateway(stub, async (port) => {
      fs.writeFileSync(
        configFile,
        `PASSCONTROL_GATEWAY=http://127.0.0.1:${port}\nPASSPORT_SECRET=\nPASSCONTROL_API_KEY=${KEY}\nPROVIDER=groq\n`
      );
      const mod = await importLogout();
      return mod.logoutCommand({}, {
        confirmYes: async (q: string) => {
          asked.push(q);
          return false;
        },
      });
    });
    expect(asked.filter((q) => /clear it/iu.test(q)), "a no-op must be one command").toEqual([]);
  });
});

describe("logout reads the revoke route's own answers", () => {
  it("treats an already-revoked key as revoked, not as still live", async () => {
    // The route conflates missing and already-revoked on purpose, so another
    // tenant's id stays indistinguishable from absence — and it answers 409 for
    // a key of yours that is already gone. Warning "STILL LIVE" there sends the
    // operator to Settings to revoke something that is not there, and teaches
    // them to ignore the message on the one occasion it matters.
    const { result } = await logout({ revoke: "already" });
    expect(result.keyRevoked).toBe(true);
    expect(result.warnings.join(" ")).not.toMatch(/STILL LIVE/u);
  });
});
