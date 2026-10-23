// `passcontrol statusline --panel`: what `/passcontrol` shows inside Claude Code (F3,
// 2026-10-10). The plugin's hook runs it and shows its output WITHOUT calling the
// model, so it still answers while the gateway refuses every call: that is the
// moment a person most needs to know why. So it must:
//   * say plainly when calls are being refused, and by what, as far as the gateway
//     says (a stopped session is named; kill and suspend stay one opaque answer);
//   * ask about THIS Claude Code session (the plugin passes its id), since a
//     session stop refuses only that session;
//   * always ask fresh: a cached "fine" from the status line must never answer it;
//   * print and exit 0 whatever happens, like the status line.
// Run as a real process, the way the plugin runs it.
import { spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = fileURLToPath(new URL("../bin/passcontrol.mjs", import.meta.url));
const AGENT = "18eddeb0-d4c8-45f3-8c70-e0063e8f9516";
const GATEWAY = "http://gateway.test:3000";
const SESSION = "4345f899-3d2f-4f58-a021-2765be8b85c2";
const day = (used: number, limit: number) => ({
  kind: "day",
  limit_microcents: limit,
  used_microcents: used,
  remaining_microcents: Math.max(0, limit - used),
  resets_in_seconds: 25_200,
});
const self = (budget: Record<string, unknown>) => ({ agent_id: AGENT, auth: "passport", scope: [], as_of: "2026-10-10T12:00:00.000Z", budget });
const OK = self({ tokens: null, cost: null, period: day(42_000_000, 1_000_000_000) });

let server: Server;
let port = 0;
let seen: IncomingHttpHeaders[] = [];
let urls: string[] = [];
let answer: (res: ServerResponse) => void;
// The sidecar's own usage-window endpoint (subscription mode); unknown by default.
let windowAnswer: (res: ServerResponse) => void;
const json = (status: number, body: unknown) => (res: ServerResponse) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

beforeEach(async () => {
  seen = [];
  urls = [];
  answer = json(200, OK);
  windowAnswer = json(404, { error: "window_unknown" });
  server = createServer((req, res) => {
    urls.push(`${req.method} ${req.url}`);
    if (req.url === "/_passcontrol/window") return windowAnswer(res);
    seen.push(req.headers);
    answer(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address();
  port = typeof a === "object" && a ? a.port : 0;
});

afterEach(() => new Promise<void>((r) => server.close(() => r())));

function run(args: string[], home = mkdtempSync(join(tmpdir(), "pc-panel-")), extraEnv: Record<string, string> = {}) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: home,
      env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: home, NO_COLOR: "1", PASSCONTROL_GATEWAY: GATEWAY, ...extraEnv } as unknown as NodeJS.ProcessEnv,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}
const panel = (extra: string[] = []) => run(["statusline", "--panel", "--port", String(port), ...extra]);

describe("passcontrol statusline --panel", () => {
  it("shows the agent's limits and where to manage it", async () => {
    const r = await panel();
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split("\n");
    expect(lines[0]).toBe("PassControl · agent 18eddeb0");
    expect(r.out).toMatch(/^ {2}Today {7}\$0\.42 of \$10\.00 · \$9\.58 left · resets in 7h$/m);
    expect(r.out).toMatch(new RegExp(`^ {2}Calls {7}through the sidecar on :${port}$`, "m"));
    expect(r.out).toMatch(new RegExp(`^ {2}Agent page  ${GATEWAY}/dashboard/agents/${AGENT}$`, "m"));
    expect(r.err).toBe("");
  });

  it("names every limit the agent has, and says when it has none", async () => {
    answer = json(200, self({
      tokens: { limit: 1_000_000, used: 250_000, remaining: 750_000 },
      cost: { limit_microcents: 5_000_000_000, used_microcents: 1_000_000_000, remaining_microcents: 4_000_000_000 },
      period: null,
    }));
    let r = await panel();
    expect(r.out).toMatch(/^ {2}Lifetime {4}\$10\.00 of \$50\.00 · \$40\.00 left$/m);
    expect(r.out).toMatch(/^ {2}Tokens {6}250k of 1M · 750k left$/m);
    answer = json(200, self({ tokens: null, cost: null, period: null }));
    r = await panel();
    expect(r.out).toMatch(/^ {2}Limit {7}none set$/m);
  });

  it("asks about this Claude Code session, the way Claude Code names it on a call", async () => {
    await panel(["--session", SESSION]);
    expect(seen[0]?.["x-claude-code-session-id"]).toBe(SESSION);
    // An id the gateway would not accept as declared is not sent at all.
    await panel(["--session", "has space; rm -rf"]);
    expect(seen[1]?.["x-claude-code-session-id"]).toBeUndefined();
  });

  it("says this session's calls are refused when its owner stopped it, and that others are not", async () => {
    answer = json(403, { error: "blocked_suspended", message: `PassControl refused this call: the agent's owner stopped this session (${SESSION}).` });
    const r = await panel(["--session", SESSION]);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe("PassControl · REFUSING CALLS from this session");
    expect(r.out).toContain("stopped this session");
    expect(r.out).toContain("new session is not stopped");
    expect(r.out).toContain(`${GATEWAY}/dashboard`);
  });

  it("says every call is refused on the opaque refusal, without claiming which control fired", async () => {
    answer = json(403, { error: "blocked_suspended" });
    const r = await panel();
    expect(r.out.split("\n")[0]).toBe("PassControl · REFUSING CALLS");
    expect(r.out).toMatch(/suspended.*kill switch|kill switch.*suspended/s);
    expect(r.out).not.toContain("stopped this session");
  });

  it("says the limit is reached when nothing is left, since calls are refused until it resets", async () => {
    answer = json(200, self({ tokens: null, cost: null, period: day(1_000_000_000, 1_000_000_000) }));
    const r = await panel();
    expect(r.out.split("\n")[0]).toBe("PassControl · agent 18eddeb0 · LIMIT REACHED");
    expect(r.out).toMatch(/^ {2}Today {7}\$10\.00 of \$10\.00 · \$0\.00 left · resets in 7h$/m);
  });

  it("says the agent is paused in its title, when its owner's pause line stops it (L4c)", async () => {
    answer = json(200, { ...self({ tokens: null, cost: null, period: day(850_000_000, 1_000_000_000) }), pause: { percent: 80, paused: true, limit: "period", lifted_until: null } });
    const r = await panel();
    expect(r.out.split("\n")[0]).toBe("PassControl · agent 18eddeb0 · PAUSED");
    expect(r.out).toMatch(/^ {2}Paused {6}at its 80% line · the owner can let it go on from the agent's page$/m);
  });

  it("says how to start the sidecar when nothing answers", async () => {
    await new Promise<void>((r) => server.close(() => r()));
    const r = await panel();
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe(`PassControl · sidecar not running on port ${port}`);
    expect(r.out).toContain("passcontrol sidecar");
    server = createServer(() => undefined).listen(0);
  });

  it("is never answered from the status line's cache", async () => {
    const home = mkdtempSync(join(tmpdir(), "pc-panel-"));
    await run(["statusline", "--port", String(port)], home);
    answer = json(403, { error: "blocked_suspended" });
    const r = await run(["statusline", "--panel", "--port", String(port)], home);
    expect(seen).toHaveLength(2);
    expect(r.out).toContain("REFUSING CALLS");
  });

  it("never prints a stack trace, whatever comes back", async () => {
    for (const a of [json(500, { error: "boom" }), json(429, { error: "rate_limited" }), (res: ServerResponse) => res.end("not json"), json(200, { agent_id: "x" })]) {
      answer = a;
      const r = await panel();
      expect(r.code).toBe(0);
      expect(r.out.startsWith("PassControl · ")).toBe(true);
      expect(r.out + r.err).not.toMatch(/at .*\.mjs:\d+|Error:/);
    }
  });

  // A dedicated Claude Code agent runs its own sidecar (port 8790), so the default
  // port would name the WRONG agent. Claude Code's own ANTHROPIC_BASE_URL says which
  // sidecar its calls go through, and the plugin's hook inherits it.
  it("asks the sidecar Claude Code actually sends its calls to", async () => {
    const r = await run(["statusline", "--panel"], undefined, { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/v1/anthropic` });
    expect(seen).toHaveLength(1);
    expect(r.out).toMatch(new RegExp(`through the sidecar on :${port}$`, "m"));
    // An explicit --port still wins.
    await run(["statusline", "--panel", "--port", String(port)], undefined, { ANTHROPIC_BASE_URL: "http://127.0.0.1:1/api/v1/anthropic" });
    expect(seen).toHaveLength(2);
  });

  it("says so, and asks nothing, when Claude Code's calls do not go through a local sidecar", async () => {
    const r = await run(["statusline", "--panel"], undefined, { ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(0);
    expect(r.out.split("\n")[0]).toBe("PassControl · not in the path of this session");
    expect(r.out).toContain("api.anthropic.com");
    expect(r.out).toContain("passcontrol configure claude-code");
  });

  // Subscription mode: Claude Code signs in with the
  // person's Pro/Max account and talks to Anthropic directly, so ANTHROPIC_BASE_URL is
  // not set. `configure claude-code --subscription` sets PASSCONTROL_SIDECAR_URL
  // instead, naming the sidecar its hooks and telemetry go to.
  describe("in subscription mode", () => {
    const sub = () => ({ PASSCONTROL_SIDECAR_URL: `http://127.0.0.1:${port}` });

    it("asks the sidecar PASSCONTROL_SIDECAR_URL names, and says calls are reported, not proxied", async () => {
      const r = await run(["statusline", "--panel"], undefined, sub());
      expect(r.code).toBe(0);
      expect(seen).toHaveLength(1);
      expect(r.out).toMatch(/^ {2}Calls {7}reported by Claude Code \(subscription\), not proxied$/m);
      expect(r.out).not.toContain("through the sidecar");
    });

    it("shows the usage window the status line last reported", async () => {
      windowAnswer = json(200, { fiveHour: { usedPct: 23.5, resetsAt: null }, sevenDay: { usedPct: 41.2, resetsAt: null }, at: 1 });
      const r = await run(["statusline", "--panel"], undefined, sub());
      expect(urls).toContain("GET /_passcontrol/window");
      expect(r.out).toMatch(/^ {2}Window {6}5h 24% · 7d 41%$/m);
    });

    it("leaves the window out when none has been reported, or the answer does not hold up", async () => {
      expect((await run(["statusline", "--panel"], undefined, sub())).out).not.toMatch(/Window/);
      windowAnswer = json(200, { fiveHour: { usedPct: "\u001b[2J" } });
      expect((await run(["statusline", "--panel"], undefined, sub())).out).not.toMatch(/Window/);
    });

    it("says calls still go ahead when the sidecar is not running", async () => {
      const r = await run(["statusline", "--panel"], undefined, { PASSCONTROL_SIDECAR_URL: "http://127.0.0.1:1" });
      expect(r.out.split("\n")[0]).toBe("PassControl · sidecar not running on port 1");
      expect(r.out).toContain("go ahead");
      expect(r.out).not.toContain("they fail");
    });

    it("lets a routed ANTHROPIC_BASE_URL win: that session is proxied, not reported", async () => {
      const r = await run(["statusline", "--panel"], undefined, { ...sub(), ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}/api/v1/anthropic` });
      expect(r.out).toMatch(new RegExp(`through the sidecar on :${port}$`, "m"));
      expect(urls).not.toContain("GET /_passcontrol/window");
    });
  });

  it("leaves the one-line status line exactly as it was", async () => {
    const r = await run(["statusline", "--port", String(port)]);
    expect(r.out).toBe("PassControl · $0.42 of $10.00 today\n");
  });
});
