import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";

import http from "node:http";
import { applyEvent, clean, createBoardState, fetchBudget, formatMs, LEAVE, openFeed, plainLine, renderBoard, retryDelay, runWatch, visibleLength } from "../watch.mjs";

// The board's renderer is pure (state, size, clock → lines), so its frames are pinned
// here exactly. The terminal handling around it is pinned under a real pty in
// watch-pty.test.mjs.

const T = Date.UTC(2026, 9, 11, 14, 3, 0);
const utc = (at) => new Date(at).toISOString().slice(11, 19);
const SES = "3f9a2c1d-0000-4000-8000-000000000001";

function board() {
  const s = createBoardState();
  applyEvent(s, { type: "hello", feed: "passcontrol-watch", v: 1, run: "run-1" });
  const ev = (seq, o) =>
    applyEvent(s, {
      type: "call",
      seq,
      at: T + seq * 1000,
      ses: SES,
      agent: null,
      parent: null,
      model: "claude-sonnet-5-5",
      provider: "anthropic",
      outcome: "boarded",
      code: null,
      status: 200,
      ttfb: 300,
      ms: 4210,
      ...o,
    });
  ev(1, {});
  ev(2, { agent: "a0000000000000002", model: "claude-haiku-5-5", ms: 812 });
  ev(3, { agent: "a0000000000000003", parent: "a0000000000000002", outcome: "denied", code: "subagent_cap", status: 403, ms: 14 });
  ev(4, { outcome: "error", status: 529, ms: 1200, model: "claude-opus-5-5" });
  ev(5, { ses: "run-1", agent: "researcher", model: null, ms: null });
  s.budget = {
    kind: "ok",
    checkedAt: T,
    self: { budget: { period: { kind: "day", used_microcents: 123_000_000, limit_microcents: 2_000_000_000, remaining_microcents: 1_877_000_000, resets_in_seconds: 7 * 3600 } } },
  };
  return s;
}

const render = (s, width, height, extra = {}) => renderBoard(s, { width, height, port: 8788, now: T + 9000, formatTime: utc, ...extra });

describe("the board, rendered", () => {
  it("draws the whole board at 100×10: budget bar, column heads, newest call first", () => {
    expect(render(board(), 100, 10)).toEqual([
      "PassControl watch · sidecar :8788 · live · 5 calls: 3 boarded, 1 denied, 1 error",
      "Today     [█░░░░░░░░░░░░░░░░░░░░░░░] $1.23 of $20.00 · $18.77 left · resets in 7h · checked 14:03:00",
      "",
      "TIME      SESSION   SUB-AGENT     MODEL                         STATUS                       LATENCY",
      "14:03:05  (run)     researcher    —                             BOARDED                       4.00s…",
      "14:03:04  3f9a2c1d  main          claude-opus-5-5               ERROR 529                      1.20s",
      "14:03:03  3f9a2c1d  ↳a0000…00003  claude-sonnet-5-5             DENIED subagent_cap             14ms",
      "14:03:02  3f9a2c1d  a00000…00002  claude-haiku-5-5              BOARDED                        812ms",
      "14:03:01  3f9a2c1d  main          claude-sonnet-5-5             BOARDED                        4.21s",
      "q quit · newest first · read-only · calls that skip this sidecar are not shown",
    ]);
  });

  it("at 60 columns drops the session column first, and the budget's checked time", () => {
    const lines = render(board(), 60, 10);
    expect(lines[1]).toBe("Today     [░░░░░░░░] $1.23 of $20.00 · $18.77 left · resets");
    expect(lines[3]).toBe("TIME      SUB-AGENT     MODEL          STATUS        LATENCY");
    expect(lines[6]).toBe("14:03:03  ↳a0000…00003  claude-sonne…  DENIED suba…     14ms");
  });

  it("at 70 columns the model and the reason get the session column's room", () => {
    const lines = render(board(), 70, 10);
    expect(lines[3]).toBe("TIME      SUB-AGENT     MODEL               STATUS             LATENCY");
    expect(lines[6]).toBe("14:03:03  ↳a0000…00003  claude-sonnet-5-5   DENIED subagent_…     14ms");
  });

  it("shows only as many calls as fit, newest kept", () => {
    const lines = render(board(), 100, 7);
    expect(lines).toHaveLength(7);
    expect(lines[4]).toMatch(/^14:03:05/);
    expect(lines[5]).toMatch(/^14:03:04/);
    expect(lines[6]).toMatch(/^q quit/);
  });

  it("is never wider or taller than the terminal, at any size", () => {
    const s = board();
    s.budget.self.budget.period.used_microcents = 2_000_000_000;
    s.budget.self.budget.period.remaining_microcents = 0;
    for (let width = 1; width <= 220; width += 7) {
      for (const height of [1, 3, 6, 8, 24, 60]) {
        for (const color of [false, true]) {
          const lines = render(s, width, height, { color });
          expect(lines, `${width}×${height}`).toHaveLength(height);
          for (const line of lines) expect(visibleLength(line), `${width}×${height}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("asks for a bigger window rather than drawing a torn one", () => {
    expect(render(board(), 39, 6)[0]).toBe("Window too small (min 40×6)");
    expect(render(board(), 80, 5)[0]).toBe("Window too small (min 40×6)");
  });

  it("why the board is not live gets a line of its own, whole", () => {
    const s = board();
    s.feed = { state: "down", message: "whatever answers on :8788 serves no watch feed · a sidecar started before `watch` existed needs a restart" };
    const lines = render(s, 120, 10);
    expect(lines[0]).toContain("· not connected ·");
    expect(lines[2]).toBe(s.feed.message);
    expect(lines[4]).toMatch(/^14:03:05/);
  });

  it("says where to point an agent while no calls have come", () => {
    const s = createBoardState();
    applyEvent(s, { type: "hello", feed: "passcontrol-watch", v: 1, run: "r" });
    const lines = render(s, 100, 8);
    expect(lines[0]).toContain("no calls yet");
    expect(lines[4]).toContain("http://127.0.0.1:8788/api/v1/anthropic");
  });

  it("colours the outcome, and only with colour on", () => {
    const plain = render(board(), 100, 10).join("\n");
    expect(plain).not.toContain("\x1b");
    const coloured = render(board(), 100, 10, { color: true }).join("\n");
    expect(coloured).toContain("\x1b[31mDENIED subagent_cap");
    expect(coloured).toContain("\x1b[32mBOARDED");
    expect(coloured).toContain("\x1b[33mERROR 529");
  });
});

describe("the budget line", () => {
  const withBudget = (budget) => {
    const s = board();
    s.budget = budget;
    return render(s, 100, 10)[1];
  };

  it("before the first answer", () => {
    expect(withBudget(null)).toBe("Budget    checking…");
  });

  it("a stopped agent is a banner, in the panel's words", () => {
    expect(withBudget({ kind: "stopped" })).toBe("REFUSING CALLS · its owner suspended this agent, or the kill switch is on");
  });

  it("unavailable says why", () => {
    expect(withBudget({ kind: "unavailable", reason: "sidecar not running" })).toBe("Budget    unavailable (sidecar not running)");
  });

  it("a spent limit is full and says LIMIT REACHED", () => {
    const line = withBudget({
      kind: "ok",
      checkedAt: T,
      self: { budget: { period: { kind: "day", used_microcents: 2_000_000_000, limit_microcents: 2_000_000_000, remaining_microcents: 0 } } },
    });
    // 101 columns with its checked time, so at 100 that part goes.
    expect(line).toBe("Today     [████████████████████████] $20.00 of $20.00 · $0.00 left · LIMIT REACHED");
  });

  it("no limit draws no bar", () => {
    expect(withBudget({ kind: "ok", checkedAt: T, self: { budget: {} } })).toBe("Limit     none set · checked 14:03:00");
  });

  it("a token limit draws its own fraction", () => {
    const line = withBudget({ kind: "ok", checkedAt: T, self: { budget: { tokens: { used: 500, limit: 1000, remaining: 500 } } } });
    expect(line).toBe("Tokens    [████████████░░░░░░░░░░░░] 500 of 1k · 500 left · checked 14:03:00");
  });
});

describe("nothing from the socket reaches the terminal raw", () => {
  it("clean() strips C0, C1, DEL, zero-width and bidi controls", () => {
    const evil = "a\u001b[2Jb\u009bc\u007fd\u202ee\u2066f\u200bg\u2028h\ufeffi\u0007j";
    // Without its ESC, "[2J" is printable text that does nothing.
    expect(clean(evil)).toBe("a[2Jbcdefghij");
  });

  it("an event whose fields are not ids is shown without them", () => {
    const s = createBoardState();
    applyEvent(s, { type: "hello", feed: "passcontrol-watch", v: 1, run: "r" });
    applyEvent(s, {
      type: "call",
      seq: 1,
      at: T,
      ses: "\u001b]0;pwned\u0007",
      agent: "\u001b[31mred",
      parent: null,
      model: "x\u001b[2J",
      provider: "anthropic",
      outcome: "\u001b[5mBOARDED",
      code: "\u001b[2J",
      status: 200,
      ms: 5,
    });
    const out = render(s, 100, 8, { color: false }).join("\n");
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("pwned");
    expect(s.rows[0]).toMatchObject({ ses: null, agent: null, model: null, outcome: "error", code: null });
  });

  it("the renderer strips controls even from a state that skipped the event checks", () => {
    const s = board();
    s.rows[0].model = "claude\u001b[2J\u009b31m";
    s.rows[1].code = "x\u001b]0;t\u0007";
    s.rows[1].outcome = "denied";
    s.budget = { kind: "unavailable", reason: "\u001b[2Jgone" };
    const out = render(s, 120, 10, { color: false }).join("\n");
    // Our own SGR codes are off (color: false), so no escape byte at all may remain.
    expect(out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
  });
});

describe("state", () => {
  it("a new sidecar run clears the old run's rows", () => {
    const s = board();
    applyEvent(s, { type: "hello", feed: "passcontrol-watch", v: 1, run: "run-2" });
    expect(s.rows).toEqual([]);
    expect(s.run).toBe("run-2");
  });

  it("a reconnect to the same run keeps its rows and does not duplicate a replayed call", () => {
    const s = board();
    applyEvent(s, { type: "hello", feed: "passcontrol-watch", v: 1, run: "run-1" });
    applyEvent(s, { type: "call", seq: 2, at: T, outcome: "boarded", status: 200, ms: 812 });
    expect(s.rows).toHaveLength(5);
  });

  it("an end event gives a streaming call its total", () => {
    const s = board();
    applyEvent(s, { type: "end", seq: 5, ms: 6400 });
    expect(render(s, 100, 10)[4]).toMatch(/6\.40s$/);
  });

  it("drops events with no usable sequence number", () => {
    const s = board();
    for (const seq of [0, -1, 1.5, "3", null]) applyEvent(s, { type: "call", seq, outcome: "boarded", status: 200 });
    expect(s.rows).toHaveLength(5);
  });

  it.each([
    [0, "0ms"],
    [999, "999ms"],
    [1000, "1.00s"],
    [9_994, "9.99s"],
    [12_340, "12.3s"],
    [63_000, "1m03s"],
  ])("formatMs(%d) is %s", (ms, text) => {
    expect(formatMs(ms)).toBe(text);
  });

  it("plainLine is the board's row, uncoloured", () => {
    const s = board();
    expect(plainLine(s.rows[2], { run: s.run, formatTime: utc })).toBe(
      "14:03:03  3f9a2c1d  ↳a0000…00003  claude-sonnet-5-5             DENIED subagent_cap             14ms"
    );
  });
});

describe("the budget is asked for, held in memory, and never written", () => {
  it("fetchBudget reads /api/v1/self through the sidecar and writes nothing", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pc-watch-home-"));
    const asked = [];
    const result = await fetchBudget({
      port: 8799,
      now: () => T,
      fetch: async (url) => {
        asked.push(url);
        return new Response(JSON.stringify({ budget: { tokens: { used: 1, limit: 2, remaining: 1 } } }), { status: 200 });
      },
    });
    expect(asked).toEqual(["http://127.0.0.1:8799/api/v1/self"]);
    expect(result).toMatchObject({ kind: "ok", checkedAt: T });
    expect(fs.readdirSync(home)).toEqual([]);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.each([
    [403, { kind: "stopped" }],
    [429, { kind: "unavailable" }],
    [500, { kind: "unavailable", reason: "HTTP 500" }],
  ])("HTTP %d", async (status, expected) => {
    const result = await fetchBudget({ port: 1, fetch: async () => new Response("{}", { status }) });
    expect(result).toMatchObject(expected);
  });

  it("a sidecar that is not running", async () => {
    const result = await fetchBudget({ port: 1, fetch: async () => { throw new TypeError("fetch failed"); } });
    expect(result).toEqual({ kind: "unavailable", reason: "sidecar not running" });
  });
});

describe("runWatch's terminal handling, without a terminal", () => {
  function fakeTty() {
    const out = new EventEmitter();
    out.isTTY = true;
    out.columns = 100;
    out.rows = 12;
    out.written = "";
    out.write = (chunk) => {
      out.written += chunk;
      return true;
    };
    const input = new EventEmitter();
    input.rawModes = [];
    input.setRawMode = (on) => input.rawModes.push(on);
    input.resume = () => {};
    input.pause = () => {};
    return { out, input, signals: new EventEmitter() };
  }
  const offline = async () => {
    throw new TypeError("fetch failed");
  };

  it.each([
    ["q", "q"],
    ["Ctrl-C as a key", "\x03"],
  ])("%s restores the screen, the cursor and cooked mode", async (_name, key) => {
    const { out, input, signals } = fakeTty();
    const done = runWatch({ port: 1, out, input, signals, fetch: offline, color: false });
    expect(out.written.startsWith("\x1b[?1049h\x1b[?25l")).toBe(true);
    expect(input.rawModes).toEqual([true]);
    input.emit("data", Buffer.from(key));
    expect(await done).toBe(0);
    expect(out.written.endsWith(LEAVE)).toBe(true);
    expect(input.rawModes).toEqual([true, false]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("exit")).toBe(0);
  });

  it("SIGTERM restores the terminal too", async () => {
    const { out, input, signals } = fakeTty();
    const done = runWatch({ port: 1, out, input, signals, fetch: offline, color: false });
    signals.emit("SIGTERM");
    expect(await done).toBe(0);
    expect(out.written.endsWith(LEAVE)).toBe(true);
  });

  it("a resize redraws at the new size", async () => {
    const { out, input, signals } = fakeTty();
    const done = runWatch({ port: 1, out, input, signals, fetch: offline, color: false });
    await new Promise((r) => setTimeout(r, 100));
    out.written = "";
    out.columns = 60;
    out.emit("resize");
    await new Promise((r) => setTimeout(r, 120));
    expect(out.written).toContain("TIME      SUB-AGENT");
    input.emit("data", "q");
    await done;
  });

  it("an unreachable sidecar is said on the board, not thrown", async () => {
    const { out, input, signals } = fakeTty();
    const done = runWatch({ port: 1, out, input, signals, fetch: offline, color: false });
    await new Promise((r) => setTimeout(r, 300));
    expect(out.written).toContain("no sidecar on :1 yet");
    input.emit("data", "q");
    expect(await done).toBe(0);
  });
});

describe("whatever else answers on the port", () => {
  // A sidecar from before `watch` forwards /_passcontrol/watch to the gateway like any
  // path; the dashboard's middleware redirects it to /login, and fetch follows, so the
  // board gets the login page: 200 text/html (seen against the dev gateway, 2026-10-11).
  async function serve(handler) {
    const server = http.createServer(handler);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    let hits = 0;
    server.on("request", () => (hits += 1));
    return { port: server.address().port, hits: () => hits, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
  }
  const kindFrom = (port) =>
    new Promise((resolve) => openFeed({ port, onEvent: () => {}, onError: (e) => resolve(e.kind) }));

  it.each([
    ["the login page an old sidecar relays", 200, "text/html; charset=utf-8", "<html>login</html>", "not-feed"],
    ["a 404 page", 404, "text/html", "<html>nope</html>", "not-feed"],
    ["JSON that is not a feed", 200, "application/json", '{"ok":true}', "not-feed"],
    ["ndjson with no hello", 200, "application/x-ndjson", '{"type":"call","seq":1}\n', "not-feed"],
    ["a feed that is off", 404, "application/json", '{"error":"watch_off"}', "off"],
    ["a refused feed", 403, "application/json", '{"error":"watch_refused"}', "refused"],
    ["a busy feed", 503, "application/json", '{"error":"watch_busy"}', "busy"],
  ])("%s is %s", async (_name, status, type, body, kind) => {
    const s = await serve((req, res) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    });
    expect(await kindFrom(s.port)).toBe(kind);
    await s.close();
  });

  it("nothing listening is unreachable", async () => {
    const s = await serve(() => {});
    const { port } = s;
    await s.close();
    expect(await kindFrom(port)).toBe("unreachable");
  });

  it("asks a wrong answer again once a minute, a missing sidecar quickly", () => {
    expect(retryDelay({ kind: "not-feed" }, 0)).toBe(60_000);
    expect(retryDelay({ kind: "not-feed" }, 9)).toBe(60_000);
    expect(retryDelay({ kind: "off" }, 0)).toBe(60_000);
    expect(retryDelay({ kind: "refused" }, 0)).toBe(60_000);
    expect(retryDelay({ kind: "busy" }, 0)).toBe(10_000);
    expect(retryDelay({ kind: "unreachable" }, 0)).toBe(500);
    expect(retryDelay({ kind: "unreachable" }, 50)).toBe(5000);
    expect(retryDelay({ kind: "closed" }, 1)).toBe(1000);
  });

  it("the board says to restart an old sidecar, and does not keep asking", async () => {
    const s = await serve((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>login</html>");
    });
    const out = new EventEmitter();
    Object.assign(out, { isTTY: true, columns: 120, rows: 12, written: "", write: (c) => ((out.written += c), true) });
    const input = Object.assign(new EventEmitter(), { setRawMode: () => {}, resume: () => {}, pause: () => {} });
    const done = runWatch({ port: s.port, out, input, signals: new EventEmitter(), fetch: async () => new Response("{}", { status: 500 }), color: false });
    await new Promise((r) => setTimeout(r, 1500));
    expect(out.written).toContain("a sidecar started before `watch` existed needs a restart");
    expect(s.hits()).toBe(1);
    input.emit("data", "q");
    await done;
    await s.close();
  });

  it("not on a terminal, it prints why it is not connected, once", async () => {
    const s = await serve((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>login</html>");
    });
    const out = Object.assign(new EventEmitter(), { isTTY: false, written: "", write: (c) => ((out.written += c), true) });
    const signals = new EventEmitter();
    const done = runWatch({ port: s.port, out, input: new EventEmitter(), signals, fetch: async () => new Response("{}", { status: 500 }), color: false });
    await new Promise((r) => setTimeout(r, 400));
    expect(out.written.split("\n").filter((l) => l.includes("needs a restart"))).toHaveLength(1);
    expect(out.written).not.toContain("\x1b");
    signals.emit("SIGTERM");
    await done;
    await s.close();
  });
});
