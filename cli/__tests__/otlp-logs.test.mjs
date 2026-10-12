import fs from "node:fs";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

import { OTLP_LOGS_PATH, readClaudeCodeEvents } from "../otlp-logs.mjs";
import { createSidecar } from "../sidecar.mjs";
import { applyEvent, createBoardState, renderBoard } from "../watch.mjs";

// Subscription mode's eyes: Claude Code reports each
// model call it makes as an OpenTelemetry log record, and the sidecar receives them on
// its loopback listener. The fixture is a REAL export, captured from Claude Code
// 2.1.296 on a Pro login on 2026-10-11 (OTLP http/json) with the identity values
// replaced: a hand-tidied shape is exactly the kind of fixture that passes while the
// real one does not (CLAUDE.md, the req.url trap).
//
// Every record carries the user's email, account and organisation ids. They must
// never reach the feed, the board or anything else: the parser copies an allowlist
// of fields, and these tests check the whole output for the identity values.

const FIXTURE = JSON.parse(
  fs.readFileSync(new URL("./fixtures/otlp-logs-claude-code-2.1.296.json", import.meta.url), "utf8")
);
const SESSION = "11111111-1111-4111-8111-111111111111";
const IDENTITY = ["owner@example.test", "00000000-0000-4000-8000-0000000000aa", "user_00000000000000000000000000", "00000000-0000-4000-8000-0000000000bb", "0".repeat(64)];

const clone = (v) => JSON.parse(JSON.stringify(v));

/** A log record built the way the fixture's are, for shapes the capture did not include. */
function withRecord(attributes, body = "claude_code.api_error") {
  const batch = clone(FIXTURE);
  batch.resourceLogs[0].scopeLogs[0].logRecords = [
    {
      timeUnixNano: "1791748606620000000",
      body: { stringValue: body },
      attributes: [{ key: "session.id", value: { stringValue: SESSION } }, ...attributes],
    },
  ];
  return batch;
}

describe("reading Claude Code's log export", () => {
  it("turns the real api_request record into one call", () => {
    const events = readClaudeCodeEvents(FIXTURE);
    expect(events).toEqual([
      {
        kind: "api_request",
        session: SESSION,
        at: 1791748606620,
        model: "claude-haiku-5-5",
        costMicros: 3927,
        inputTokens: 2,
        outputTokens: 4,
        cacheReadTokens: 11869,
        cacheCreationTokens: 19031,
        durationMs: 1097,
        status: null,
        agent: null,
      },
    ]);
  });

  it("carries no identity value anywhere in what it returns", () => {
    const out = JSON.stringify(readClaudeCodeEvents(FIXTURE));
    for (const value of IDENTITY) expect(out).not.toContain(value);
  });

  it("reads an api_error as an error with its status", () => {
    const [event] = readClaudeCodeEvents(
      withRecord([
        { key: "model", value: { stringValue: "claude-opus-5-5" } },
        { key: "status_code", value: { intValue: 529 } },
        { key: "duration_ms", value: { intValue: "812" } },
      ])
    );
    expect(event).toMatchObject({ kind: "api_error", model: "claude-opus-5-5", status: 529, durationMs: 812, costMicros: null });
  });

  it("names a sub-agent from agent.name", () => {
    const [event] = readClaudeCodeEvents(
      withRecord(
        [
          { key: "model", value: { stringValue: "claude-haiku-5-5" } },
          { key: "agent.name", value: { stringValue: "Explore" } },
          { key: "cost_usd_micros", value: { intValue: "120" } },
        ],
        "claude_code.api_request"
      )
    );
    expect(event).toMatchObject({ agent: "Explore", costMicros: 120 });
  });

  it("ignores every other event and every other service", () => {
    expect(readClaudeCodeEvents(withRecord([], "claude_code.user_prompt"))).toEqual([]);
    const other = clone(FIXTURE);
    other.resourceLogs[0].resource.attributes = [{ key: "service.name", value: { stringValue: "something-else" } }];
    expect(readClaudeCodeEvents(other)).toEqual([]);
  });

  it("drops values that fail their pattern instead of passing them on", () => {
    const [event] = readClaudeCodeEvents(
      withRecord(
        [
          { key: "model", value: { stringValue: "\u001b[31mred" } },
          { key: "agent.name", value: { stringValue: "a b\nc" } },
          { key: "cost_usd_micros", value: { intValue: -5 } },
        ],
        "claude_code.api_request"
      )
    );
    expect(event).toMatchObject({ model: null, agent: null, costMicros: null });
  });

  it("never throws on junk", () => {
    for (const junk of [null, 1, "x", [], {}, { resourceLogs: 1 }, { resourceLogs: [{ scopeLogs: [{ logRecords: [null, 1] }] }] }]) {
      expect(readClaudeCodeEvents(junk)).toEqual([]);
    }
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
  const rows = [];
  sidecar.feed.attach({ write: (line) => rows.push(JSON.parse(line)), on: () => {}, writableLength: 0 });
  return { port, rows: () => rows.filter((r) => r.type === "call") };
}

const post = (port, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${OTLP_LOGS_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("the sidecar's telemetry endpoint", () => {
  it("accepts the export, answers as an OTLP collector, and shows the call on the board", async () => {
    const { port, rows } = await startSidecar();
    const res = await post(port, FIXTURE);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ outcome: "seen", model: "claude-haiku-5-5", ses: SESSION, cost: 3927, ms: 1097, provider: "anthropic" });
    for (const value of IDENTITY) expect(JSON.stringify(rows())).not.toContain(value);
  });

  it("does not count twice a session whose calls this sidecar already relays", async () => {
    const { port, rows } = await startSidecar();
    await fetch(`http://127.0.0.1:${port}/api/v1/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": SESSION },
      body: JSON.stringify({ model: "claude-haiku-5-5" }),
    });
    const before = rows().length;
    await post(port, FIXTURE);
    expect(rows()).toHaveLength(before);
  });

  it("refuses protobuf with a message saying which protocol to set", async () => {
    const { port } = await startSidecar();
    const res = await post(port, "\x0a\x00", { "content-type": "application/x-protobuf" });
    expect(res.status).toBe(415);
    expect((await res.json()).message).toContain("http/json");
  });

  it("refuses a browser", async () => {
    const { port, rows } = await startSidecar();
    expect((await post(port, FIXTURE, { origin: "https://evil.example" })).status).toBe(403);
    expect(rows()).toHaveLength(0);
  });

  it("answers 400 to a body that is not JSON, and stays up", async () => {
    const { port } = await startSidecar();
    expect((await post(port, "not json")).status).toBe(400);
    expect((await post(port, FIXTURE)).status).toBe(200);
  });
});

describe("the board shows a reported call", () => {
  it("as SEEN with its API-equivalent cost, counted apart from boarded calls", () => {
    const state = createBoardState();
    applyEvent(state, { type: "hello", feed: "passcontrol-watch", run: "r" });
    applyEvent(state, { type: "call", seq: 1, at: 1_000, ses: SESSION, model: "claude-haiku-5-5", outcome: "seen", cost: 3927, ms: 1097 });
    const lines = renderBoard(state, { width: 120, height: 12, port: 8788, now: 5_000, formatTime: () => "21:00:00" });
    const text = lines.join("\n");
    expect(text).toMatch(/SEEN \$0\.0039/);
    expect(text).toMatch(/1 seen/);
    expect(text).not.toMatch(/1 boarded/);
  });
});
