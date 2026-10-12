import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

import { createStopGate, HOOK_PATH, selfAnswerState } from "../subscription-gate.mjs";
import { createSidecar } from "../sidecar.mjs";

// Subscription mode: a Claude Pro/Max session talks to
// Anthropic directly, so the gateway never sees its calls and cannot refuse them.
// The kill switch, a suspended agent and a stopped session reach it instead through
// Claude Code's own hooks, which ask the local sidecar before a prompt is sent, before
// a tool runs, and before the next model call of a running turn.
//
// What these tests hold:
//   * a stop the gateway reports blocks all three events, and ends the turn;
//   * the gateway is asked at most once per freshness window per session, because
//     a hook fires on every tool call and /api/v1/self allows 60 a minute;
//   * an unreadable answer fails OPEN (the owner's choice, and the kill switch's
//     convention), with a visible warning that is not repeated on every tool call;
//   * a stop known a moment ago survives a gateway blip: fail-open is for "never
//     knew", not for "knew it was stopped 10 seconds ago".

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const input = (event, extra = {}) => ({
  session_id: "4f6c1d2e-0000-4000-8000-000000000001",
  hook_event_name: event,
  ...extra,
});

function gateWith(answers, options = {}) {
  const calls = [];
  const c = clock();
  const queue = [...answers];
  const gate = createStopGate({
    readSelf: async (session) => {
      calls.push(session);
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    now: c.now,
    dashboardUrl: "http://localhost:3000/dashboard",
    ...options,
  });
  return { gate, calls, clock: c };
}

describe("stop gate: what a stop does to each hook", () => {
  it("lets everything through while the gateway reports the agent running", async () => {
    const { gate } = gateWith([{ state: "open" }]);
    for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolBatch"]) {
      expect(await gate.decide(input(event))).toEqual({});
    }
  });

  it("blocks a prompt before Claude sees it when the kill switch or a suspend is on", async () => {
    const { gate } = gateWith([{ state: "stopped" }]);
    const out = await gate.decide(input("UserPromptSubmit"));
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/suspended|kill switch/);
    expect(out.reason).toContain("http://localhost:3000/dashboard");
    expect(out.continue).toBe(false);
  });

  it("denies a tool call and ends the turn", async () => {
    const { gate } = gateWith([{ state: "stopped" }]);
    const out = await gate.decide(input("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }));
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/suspended|kill switch/);
    expect(out.continue).toBe(false);
    expect(out.stopReason).toBeTruthy();
  });

  it("stops a running turn before its next model call", async () => {
    const { gate } = gateWith([{ state: "stopped" }]);
    const out = await gate.decide(input("PostToolBatch", { tool_calls: [] }));
    expect(out.decision).toBe("block");
    expect(out.continue).toBe(false);
  });

  it("names a stopped session as the session, not the whole agent", async () => {
    const { gate } = gateWith([{ state: "session_stopped" }]);
    const out = await gate.decide(input("UserPromptSubmit"));
    expect(out.decision).toBe("block");
    expect(out.reason).toMatch(/stopped this session/);
    expect(out.reason).not.toMatch(/kill switch/);
  });

  it("answers events it does not gate with nothing, without asking the gateway", async () => {
    const { gate, calls } = gateWith([{ state: "stopped" }]);
    expect(await gate.decide(input("SessionStart"))).toEqual({});
    expect(await gate.decide(input("Notification"))).toEqual({});
    expect(calls).toHaveLength(0);
  });
});

describe("stop gate: how often it asks", () => {
  it("asks once per session per freshness window, however many tools run", async () => {
    const { gate, calls, clock: c } = gateWith([{ state: "open" }], { freshMs: 5_000 });
    for (let i = 0; i < 20; i++) await gate.decide(input("PreToolUse"));
    expect(calls).toHaveLength(1);
    c.advance(5_001);
    await gate.decide(input("PreToolUse"));
    expect(calls).toHaveLength(2);
  });

  it("asks once for concurrent hooks of the same session (parallel tool calls)", async () => {
    const { gate, calls } = gateWith([{ state: "open" }]);
    await Promise.all(Array.from({ length: 8 }, () => gate.decide(input("PreToolUse"))));
    expect(calls).toHaveLength(1);
  });

  it("keeps sessions apart: one session's stop is not another's", async () => {
    const calls = [];
    const gate = createStopGate({
      readSelf: async (session) => {
        calls.push(session);
        return session === "stopped-one" ? { state: "session_stopped" } : { state: "open" };
      },
      dashboardUrl: "http://localhost:3000/dashboard",
    });
    expect((await gate.decide(input("UserPromptSubmit", { session_id: "stopped-one" }))).decision).toBe("block");
    expect(await gate.decide(input("UserPromptSubmit", { session_id: "running-one" }))).toEqual({});
    expect(calls).toEqual(["stopped-one", "running-one"]);
  });

  it("never sends a session id the gateway would not accept as declared", async () => {
    const { gate, calls } = gateWith([{ state: "open" }]);
    await gate.decide(input("PreToolUse", { session_id: "bad id\r\nx-injected: 1" }));
    expect(calls).toEqual([null]);
  });
});

// /api/v1/self allows 60 calls a minute per AGENT, and every session of that agent
// shares them, along with the status line, `watch` and `/passcontrol`. Asking per
// session every 5 s spent 12 a minute per session, so five busy sessions ran the
// bucket dry and every gate check failed open. The agent-wide answer (kill switch,
// suspend) is the one that must be fast, and it is the same for every session: it is
// asked once for all of them. Only a session's own stop is asked per session, less often.
describe("stop gate: one agent-wide check shared by every session", () => {
  const SESSION = (i) => `4f6c1d2e-0000-4000-8000-${String(i).padStart(12, "0")}`;

  function sharedGate(answerFor, options = {}) {
    const calls = [];
    const c = clock();
    const gate = createStopGate({
      readSelf: async (session) => {
        calls.push(session);
        return answerFor(session, c.now());
      },
      now: c.now,
      dashboardUrl: "http://localhost:3000/dashboard",
      ...options,
    });
    return { gate, calls, clock: c };
  }

  it("asks agent-wide once for all sessions, not once per session", async () => {
    const { gate, calls, clock: c } = sharedGate(() => ({ state: "open" }), { freshMs: 5_000, sessionFreshMs: 15_000 });
    for (let i = 0; i < 3; i++) await gate.decide(input("PreToolUse", { session_id: SESSION(i) }));
    expect(calls).toEqual([SESSION(0), SESSION(1), SESSION(2)]);
    c.advance(5_001);
    for (let i = 0; i < 3; i++) await gate.decide(input("PreToolUse", { session_id: SESSION(i) }));
    // One agent-wide question (no session) answers all three.
    expect(calls.slice(3)).toEqual([null]);
  });

  it("keeps ten busy sessions inside the agent's 60-a-minute /self allowance, with room to spare", async () => {
    const N = 10;
    const { gate, calls, clock: c } = sharedGate(() => ({ state: "open" }));
    // Every session fires a hook every 200 ms for a full minute.
    for (let t = 0; t < 60_000; t += 200) {
      for (let i = 0; i < N; i++) await gate.decide(input("PreToolUse", { session_id: SESSION(i) }));
      c.advance(200);
    }
    // 12 agent-wide + 4 per session is the ceiling; the old per-session cache spent 12 per session (120).
    expect(calls.length).toBeLessThanOrEqual(12 + 4 * N);
    expect(calls.length).toBeLessThan(55);
  });

  it("reaches every session within the agent-wide freshness when the kill switch goes on", async () => {
    let killed = false;
    const { gate, clock: c } = sharedGate(() => (killed ? { state: "stopped" } : { state: "open" }), {
      freshMs: 5_000,
      sessionFreshMs: 15_000,
    });
    for (let i = 0; i < 4; i++) expect(await gate.decide(input("PreToolUse", { session_id: SESSION(i) }))).toEqual({});
    killed = true;
    c.advance(5_001);
    for (let i = 0; i < 4; i++) {
      const out = await gate.decide(input("PreToolUse", { session_id: SESSION(i) }));
      expect(out.continue, `session ${i} kept running after the kill switch`).toBe(false);
    }
  });

  it("notices one session's stop within the session freshness, and leaves the others running", async () => {
    let stopped = false;
    const { gate, clock: c } = sharedGate(
      (session) => (stopped && session === SESSION(1) ? { state: "session_stopped" } : { state: "open" }),
      { freshMs: 5_000, sessionFreshMs: 15_000 }
    );
    for (let i = 0; i < 3; i++) await gate.decide(input("PreToolUse", { session_id: SESSION(i) }));
    stopped = true;
    c.advance(15_001);
    expect((await gate.decide(input("PreToolUse", { session_id: SESSION(1) }))).continue).toBe(false);
    expect(await gate.decide(input("PreToolUse", { session_id: SESSION(0) }))).toEqual({});
    expect(await gate.decide(input("PreToolUse", { session_id: SESSION(2) }))).toEqual({});
  });

  it("re-checks a session it last saw behind an agent-wide stop once the agent is running again", async () => {
    let agentStopped = true;
    const sessionStopped = true;
    const { gate, clock: c } = sharedGate(
      (session) => {
        if (agentStopped) return { state: "stopped" };
        return session && sessionStopped ? { state: "session_stopped" } : { state: "open" };
      },
      { freshMs: 5_000, sessionFreshMs: 15_000 }
    );
    expect((await gate.decide(input("PreToolUse", { session_id: SESSION(0) }))).continue).toBe(false);
    agentStopped = false;
    c.advance(5_001);
    // The agent is running again, but this session was stopped on its own: it must stay stopped.
    expect((await gate.decide(input("PreToolUse", { session_id: SESSION(0) }))).continue).toBe(false);
  });

  it("forgets sessions beyond a bound, so a long-lived sidecar does not grow without limit", async () => {
    const { gate, calls } = sharedGate(() => ({ state: "open" }), { maxSessions: 4 });
    for (let i = 0; i < 6; i++) await gate.decide(input("PreToolUse", { session_id: SESSION(i) }));
    // Session 0 was evicted, so it is asked again; session 5 is still held.
    await gate.decide(input("PreToolUse", { session_id: SESSION(0) }));
    await gate.decide(input("PreToolUse", { session_id: SESSION(5) }));
    expect(calls.filter((s) => s === SESSION(0))).toHaveLength(2);
    expect(calls.filter((s) => s === SESSION(5))).toHaveLength(1);
  });
});

describe("stop gate: when the gateway cannot be read (fail-open, visibly)", () => {
  it("lets the action through with a warning when it never knew the state", async () => {
    const { gate } = gateWith([{ state: "unknown", reason: "sidecar_upstream_error" }]);
    const out = await gate.decide(input("PreToolUse"));
    expect(out.continue).not.toBe(false);
    expect(out.hookSpecificOutput).toBeUndefined();
    expect(out.systemMessage).toMatch(/could not check/i);
  });

  it("warns once a minute per session, not on every tool call", async () => {
    const { gate, clock: c } = gateWith([{ state: "unknown", reason: "x" }], { freshMs: 0 });
    expect((await gate.decide(input("PreToolUse"))).systemMessage).toBeTruthy();
    c.advance(10_000);
    expect(await gate.decide(input("PreToolUse"))).toEqual({});
    c.advance(51_000);
    expect((await gate.decide(input("PreToolUse"))).systemMessage).toBeTruthy();
  });

  it("holds a stop it saw recently through a blip in the gateway", async () => {
    const { gate, clock: c } = gateWith([{ state: "stopped" }, { state: "unknown", reason: "timeout" }], {
      freshMs: 5_000,
      maxStaleMs: 60_000,
    });
    expect((await gate.decide(input("PreToolUse"))).continue).toBe(false);
    c.advance(6_000);
    expect((await gate.decide(input("PreToolUse"))).continue).toBe(false);
  });

  it("stops holding it once it is too old to trust, and fails open again", async () => {
    const { gate, clock: c } = gateWith([{ state: "stopped" }, { state: "unknown", reason: "timeout" }], {
      freshMs: 5_000,
      maxStaleMs: 60_000,
    });
    await gate.decide(input("PreToolUse"));
    c.advance(61_000);
    const out = await gate.decide(input("PreToolUse"));
    expect(out.continue).not.toBe(false);
    expect(out.systemMessage).toMatch(/could not check/i);
  });

  it("fails open when readSelf itself throws", async () => {
    const gate = createStopGate({
      readSelf: async () => {
        throw new Error("boom");
      },
      dashboardUrl: "http://localhost:3000/dashboard",
    });
    const out = await gate.decide(input("UserPromptSubmit"));
    expect(out.decision).toBeUndefined();
    expect(out.systemMessage).toMatch(/could not check/i);
  });
});

// Phase 2: the agent's tool rules ride on the same /self answers, so the tool gate
// (cli/tool-gate.mjs) never costs a call of its own.
describe("stop gate: the tool rules that come with each answer", () => {
  const RULES = { state: "ok", document: { rules: [{ tool: "Bash", effect: "deny" }] } };

  it("reads them from a 200, and nothing from a refusal", async () => {
    const ok = new Response(JSON.stringify({ agent_id: "a", tool_rules: RULES }), { status: 200 });
    expect(await selfAnswerState(ok)).toEqual({ state: "open", toolRules: RULES });
    expect(await selfAnswerState(new Response("{}", { status: 200 }))).toEqual({ state: "open" });
    expect(await selfAnswerState(new Response("not json", { status: 200 }))).toEqual({ state: "open" });
  });

  it("keeps the latest rules, and stops trusting them once they are stale", async () => {
    const { gate, clock } = gateWith([{ state: "open", toolRules: RULES }], { maxStaleMs: 60_000 });
    expect(gate.toolRules()).toBeNull();
    await gate.decide(input("PreToolUse"));
    expect(gate.toolRules()).toMatchObject({ read: RULES });
    clock.advance(60_001);
    expect(gate.toolRules()).toBeNull();
  });

  it("reads an open answer without rules as a gateway that has none (one from before Phase 2)", async () => {
    const { gate } = gateWith([{ state: "open" }]);
    await gate.decide(input("PreToolUse"));
    expect(gate.toolRules()).toMatchObject({ read: { state: "none" } });
  });

  it("refreshes the rules at PreToolUse when only refusals have come back since", async () => {
    // A session's stop is answered with a 403, which carries no rules: the agent is
    // known to be running, but its rules have not been read for a while.
    const answers = [{ state: "open", toolRules: RULES }, ...Array(20).fill({ state: "session_stopped" })];
    const { gate, calls, clock } = gateWith(answers, { freshMs: 5_000, sessionFreshMs: 1_000 });
    await gate.decide(input("PreToolUse"));
    const before = calls.length;
    for (let i = 0; i < 6; i += 1) {
      clock.advance(1_000);
      await gate.decide(input("PreToolUse"));
    }
    expect(calls.slice(before)).toContain(null);
  });
});

// ── Through the real sidecar, against a fake gateway ──────────────────────────

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let servers = [];
afterEach(async () => {
  for (const s of servers) if (s.listening) await new Promise((r) => s.close(r));
  servers = [];
});

async function listen(server) {
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function sidecarWithSelf(selfAnswer) {
  const seen = [];
  const gateway = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/api/auth/challenge") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ visa: "fake.visa.token", expires_in: 300 }));
        return;
      }
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const { status, body } = selfAnswer(req);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  const gatewayPort = await listen(gateway);
  const secret = ed25519.utils.randomPrivateKey();
  const sidecar = createSidecar({
    gateway: `http://127.0.0.1:${gatewayPort}`,
    passportId: b64url(ed25519.getPublicKey(secret)),
    passportSecret: b64url(secret),
  });
  const port = await listen(sidecar.server);
  return { port, seen };
}

function postHook(port, body, headers = {}, query = "") {
  return fetch(`http://127.0.0.1:${port}${HOOK_PATH}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("the sidecar's hook endpoint", () => {
  it("asks the gateway's /api/v1/self with a visa and the declared session, and answers 200 JSON", async () => {
    const { port, seen } = await sidecarWithSelf(() => ({ status: 200, body: { agent_id: "a", budget: {} } }));
    const res = await postHook(port, input("PreToolUse"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/v1/self?include=tool_rules");
    expect(seen[0].headers.authorization).toBe("Bearer fake.visa.token");
    expect(seen[0].headers["x-claude-code-session-id"]).toBe("4f6c1d2e-0000-4000-8000-000000000001");
    expect(seen[0].headers["x-passcontrol-proof"]).toBeTruthy();
  });

  it("turns the gateway's opaque 403 into a stop", async () => {
    const { port } = await sidecarWithSelf(() => ({ status: 403, body: { error: "blocked_suspended" } }));
    const out = await (await postHook(port, input("PreToolUse"))).json();
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.continue).toBe(false);
  });

  it("turns a stopped-session 403 into a session stop", async () => {
    const { port } = await sidecarWithSelf(() => ({
      status: 403,
      body: { error: "blocked_suspended", message: "The agent's owner stopped this session (x)." },
    }));
    const out = await (await postHook(port, input("UserPromptSubmit"))).json();
    expect(out.reason).toMatch(/stopped this session/);
  });

  it("fails open on a gateway error, with a warning", async () => {
    const { port } = await sidecarWithSelf(() => ({ status: 500, body: { error: "internal" } }));
    const out = await (await postHook(port, input("PreToolUse"))).json();
    expect(out.continue).not.toBe(false);
    expect(out.systemMessage).toMatch(/could not check/i);
  });

  it("refuses a browser: an Origin header, or a Host that is not this listener", async () => {
    const { port, seen } = await sidecarWithSelf(() => ({ status: 200, body: { budget: {} } }));
    expect((await postHook(port, input("PreToolUse"), { origin: "https://evil.example" })).status).toBe(403);
    const rebound = await new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: HOOK_PATH, method: "POST", headers: { host: `evil.example:${port}`, "content-type": "application/json" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.end(JSON.stringify(input("PreToolUse")));
    });
    expect(rebound).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it("answers POST only, and refuses a body that is not a JSON object", async () => {
    const { port } = await sidecarWithSelf(() => ({ status: 200, body: { budget: {} } }));
    expect((await fetch(`http://127.0.0.1:${port}${HOOK_PATH}`)).status).toBe(405);
    const bad = await fetch(`http://127.0.0.1:${port}${HOOK_PATH}`, { method: "POST", body: "[1,2]" });
    expect(bad.status).toBe(400);
  });

  it("is never forwarded to the gateway as a call", async () => {
    const { port, seen } = await sidecarWithSelf(() => ({ status: 200, body: { budget: {} } }));
    await postHook(port, input("SessionStart"));
    expect(seen).toHaveLength(0);
  });
});

// Phase 2 through the real sidecar: the rules come with /self, the decision is the
// tool gate's, and an `ask_owner` tool is put to the gateway's tool-approvals route.
describe("the sidecar's hook endpoint: tool rules", () => {
  const bashInput = (command) => input("PreToolUse", { tool_name: "Bash", tool_input: { command }, cwd: "/repo" });
  const withRules = (document, approvals = () => ({ status: 200, body: { state: "approved" } })) => (req) => {
    if (req.url.startsWith("/api/v1/tool-approvals")) return approvals(req);
    return { status: 200, body: { agent_id: "a", budget: {}, tool_rules: { state: "ok", document } } };
  };

  it("denies a tool a deny rule names", async () => {
    const { port } = await sidecarWithSelf(withRules({ rules: [{ tool: "Bash", command: "rm -rf *", effect: "deny" }] }));
    const out = await (await postHook(port, bashInput("rm -rf build"), {}, "?t=600")).json();
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.continue).toBeUndefined();
  });

  it("asks the gateway about an ask_owner tool, with the whole input, and lets a yes through", async () => {
    const posted = [];
    const { port, seen } = await sidecarWithSelf(
      withRules({ rules: [{ tool: "Bash", command: "git push*", effect: "ask_owner" }] }, (req) => {
        posted.push(req);
        return { status: 200, body: { state: "approved" } };
      })
    );
    const out = await (await postHook(port, bashInput("cd x && git push"), {}, "?t=600")).json();
    expect(out).toEqual({});
    const call = seen.find((r) => r.url === "/api/v1/tool-approvals");
    expect(call.headers.authorization).toBe("Bearer fake.visa.token");
    expect(call.headers["x-passcontrol-proof"]).toBeTruthy();
    expect(JSON.parse(call.body)).toEqual({
      session: "4f6c1d2e-0000-4000-8000-000000000001",
      tool_name: "Bash",
      tool_input: { command: "cd x && git push" },
      cwd: "/repo",
    });
  });

  it("asks again while the owner has not answered, and denies a no", async () => {
    let n = 0;
    const { port } = await sidecarWithSelf(
      withRules({ rules: [{ tool: "Bash", effect: "ask_owner" }] }, () => ({ status: 200, body: { state: ++n < 3 ? "pending" : "denied" } }))
    );
    const out = await (await postHook(port, bashInput("ls"), {}, "?t=600")).json();
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/said no/);
    expect(n).toBe(3);
  });

  it("refuses an ask_owner tool at once under a Phase 1 hook URL, without asking", async () => {
    const { port, seen } = await sidecarWithSelf(withRules({ rules: [{ tool: "Bash", effect: "ask_owner" }] }));
    const out = await (await postHook(port, bashInput("ls"))).json();
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(seen.some((r) => r.url === "/api/v1/tool-approvals")).toBe(false);
  });

  it("says so when the tool input is too large to put to the owner", async () => {
    const { port } = await sidecarWithSelf(
      withRules({ rules: [{ tool: "Bash", effect: "ask_owner" }] }, () => ({ status: 413, body: { error: "tool_approval_too_large" } }))
    );
    const out = await (await postHook(port, bashInput("ls"), {}, "?t=600")).json();
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/too large to show/);
  });

  it("maps the gateway's refusals onto a deny", async () => {
    for (const [status, body] of [
      [409, { error: "not_ask_owner" }],
      [503, { error: "approval_unavailable" }],
      [403, { error: "blocked_suspended" }],
    ]) {
      const { port } = await sidecarWithSelf(withRules({ rules: [{ tool: "Bash", effect: "ask_owner" }] }, () => ({ status, body })));
      const out = await (await postHook(port, bashInput("ls"), {}, "?t=600")).json();
      expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    }
  });
});

