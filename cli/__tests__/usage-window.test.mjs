import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

import { readUsageWindow, usageWindowText, WINDOW_PATH } from "../usage-window.mjs";
import { createSidecar } from "../sidecar.mjs";
import { applyEvent, createBoardState, renderBoard } from "../watch.mjs";

// A Pro/Max subscription pays a flat fee, so its real limit is Anthropic's usage
// window: how much of the 5-hour and the 7-day allowance is gone. Claude Code passes
// both to its status-line command on stdin (`rate_limits`, Pro/Max only, after the
// first response; code.claude.com/docs/en/statusline, read 2026-10-11). The status
// line hands them to the sidecar, and `watch` and `/passcontrol` show them.

// The documented example, as Claude Code sends it.
const STATUS_INPUT = {
  session_id: "abc123",
  cost: { total_cost_usd: 0.01234 },
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
  },
};

describe("reading the usage window from Claude Code's status-line input", () => {
  it("keeps the two windows and nothing else", () => {
    expect(readUsageWindow(STATUS_INPUT)).toEqual({
      fiveHour: { usedPct: 23.5, resetsAt: 1738425600 },
      sevenDay: { usedPct: 41.2, resetsAt: 1738857600 },
    });
  });

  it("returns null without rate_limits: an API-key session, or before the first response", () => {
    expect(readUsageWindow({ session_id: "x" })).toBeNull();
    expect(readUsageWindow(null)).toBeNull();
    expect(readUsageWindow("junk")).toBeNull();
  });

  it("keeps one window when only one is present, and drops values out of range", () => {
    expect(readUsageWindow({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 1738425600 } } })).toEqual({
      fiveHour: { usedPct: 12, resetsAt: 1738425600 },
      sevenDay: null,
    });
    expect(readUsageWindow({ rate_limits: { five_hour: { used_percentage: -3 }, seven_day: { used_percentage: "41" } } })).toBeNull();
  });

  it("reads as one short line", () => {
    const text = usageWindowText(readUsageWindow(STATUS_INPUT), { formatTime: () => "21:40" });
    expect(text).toBe("5h 24% (resets 21:40) · 7d 41% (resets 21:40)");
    expect(usageWindowText(readUsageWindow(STATUS_INPUT), { short: true })).toBe("5h 24% · 7d 41%");
  });
});

// ── Through the real sidecar ──────────────────────────────────────────────────

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

async function startSidecar() {
  const gateway = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/api/auth/challenge" ? JSON.stringify({ visa: "fake.visa.token", expires_in: 300 }) : "{}");
  });
  const gatewayPort = await listen(gateway);
  const secret = ed25519.utils.randomPrivateKey();
  const sidecar = createSidecar({
    gateway: `http://127.0.0.1:${gatewayPort}`,
    passportId: b64url(ed25519.getPublicKey(secret)),
    passportSecret: b64url(secret),
  });
  const port = await listen(sidecar.server);
  const events = [];
  sidecar.feed.attach({ write: (line) => events.push(JSON.parse(line)), on: () => {}, writableLength: 0 });
  return { port, sidecar, events };
}

const postWindow = (port, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${WINDOW_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("the sidecar's usage-window endpoint", () => {
  it("holds the latest window, answers it on GET, and tells the boards", async () => {
    const { port, events } = await startSidecar();
    expect((await fetch(`http://127.0.0.1:${port}${WINDOW_PATH}`)).status).toBe(404);
    expect((await postWindow(port, readUsageWindow(STATUS_INPUT))).status).toBe(204);
    const got = await (await fetch(`http://127.0.0.1:${port}${WINDOW_PATH}`)).json();
    expect(got).toMatchObject({ fiveHour: { usedPct: 23.5 }, sevenDay: { usedPct: 41.2 } });
    expect(typeof got.at).toBe("number");
    expect(events.filter((e) => e.type === "window")).toHaveLength(1);
  });

  it("replays the window to a board that attaches later", async () => {
    const { port, sidecar } = await startSidecar();
    await postWindow(port, readUsageWindow(STATUS_INPUT));
    const late = [];
    sidecar.feed.attach({ write: (line) => late.push(JSON.parse(line)), on: () => {}, writableLength: 0 });
    expect(late.map((e) => e.type)).toEqual(["hello", "window"]);
  });

  it("refuses a browser and a body that is not a window", async () => {
    const { port } = await startSidecar();
    expect((await postWindow(port, readUsageWindow(STATUS_INPUT), { origin: "https://evil.example" })).status).toBe(403);
    expect((await postWindow(port, { fiveHour: { usedPct: "lots" } })).status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${port}${WINDOW_PATH}`)).status).toBe(404);
  });
});

describe("the board shows the window", () => {
  it("on the line under the budget", () => {
    const state = createBoardState();
    applyEvent(state, { type: "hello", feed: "passcontrol-watch", run: "r" });
    applyEvent(state, { type: "window", fiveHour: { usedPct: 23.5, resetsAt: 1738425600 }, sevenDay: { usedPct: 41.2, resetsAt: 1738857600 }, at: 1 });
    const lines = renderBoard(state, { width: 120, height: 12, port: 8788, now: 5_000, formatTime: () => "21:00:00" });
    expect(lines[2]).toMatch(/^Window {4}5h 24% \(resets .+\) · 7d 41% \(resets .+\)$/);
  });

  it("ignores a window event that does not hold up", () => {
    const state = createBoardState();
    applyEvent(state, { type: "window", fiveHour: { usedPct: "\u001b[2J" } });
    expect(state.window ?? null).toBeNull();
  });
});
