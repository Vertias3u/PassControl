import fs from "node:fs";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

import { createCallUploader, CLIENT_EVENTS_PATH } from "../client-events-upload.mjs";
import { OTLP_LOGS_PATH } from "../otlp-logs.mjs";
import { createSidecar } from "../sidecar.mjs";

// Subscription mode, Phase 1b: the model calls Claude Code reports to the sidecar are
// uploaded to the gateway (POST /api/v1/client-events, migration 0084), so the owner
// sees them on the agent's dashboard page and not only on this machine's `watch`.
//
// What these tests hold:
//   * the OTLP answer never waits for the upload: `add` only queues;
//   * each event gets one key when it is queued, and every retry sends that key, so
//     the gateway stores it once however often it is sent;
//   * the queue is bounded, drops the oldest when full, and counts what it dropped;
//   * a refusal that will not change (stopped agent, bad batch, a gateway without
//     0084) drops instead of retrying forever; a transient one keeps the events and
//     backs off.

function harness(answers, options = {}) {
  const sent = [];
  const timers = [];
  let t = 1_000_000;
  const queue = [...answers];
  const uploader = createCallUploader({
    send: async (events) => {
      sent.push(events.map((e) => ({ ...e })));
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return next;
    },
    now: () => t,
    setTimer: (fn, ms) => {
      const timer = { fn, at: t + ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
    ...options,
  });
  async function advance(ms) {
    t += ms;
    for (;;) {
      const due = timers.find((x) => !x.cleared && x.at <= t);
      if (!due) break;
      due.cleared = true;
      await due.fn();
    }
  }
  return { uploader, sent, advance };
}

const event = (over = {}) => ({
  kind: "api_request",
  session: "4f6c1d2e-0000-4000-8000-000000000001",
  at: 1_700_000_000_000,
  model: "claude-haiku-5-5",
  costMicros: 3927,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  durationMs: 1097,
  status: null,
  agent: null,
  ...over,
});

describe("call uploader: what it sends", () => {
  it("names the gateway path it posts to", () => {
    expect(CLIENT_EVENTS_PATH).toBe("/api/v1/client-events");
  });

  it("sends a reported call in the gateway's shape, with a key the gateway accepts", async () => {
    const { uploader, sent, advance } = harness([{ status: 200 }], { flushMs: 1_000 });
    uploader.add(event());
    expect(sent).toHaveLength(0);
    await advance(1_000);
    expect(sent).toHaveLength(1);
    const [wire] = sent[0];
    expect(wire.key).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(wire).toEqual({
      key: wire.key,
      kind: "model_call",
      session: "4f6c1d2e-0000-4000-8000-000000000001",
      at: 1_700_000_000_000,
      model: "claude-haiku-5-5",
      cost_usd_micros: 3927,
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      duration_ms: 1097,
    });
  });

  it("sends an error as an error, with its status and no cost", async () => {
    const { uploader, sent, advance } = harness([{ status: 200 }], { flushMs: 1_000 });
    uploader.add(event({ kind: "api_error", status: 529, costMicros: null, agent: "general-purpose" }));
    await advance(1_000);
    expect(sent[0][0]).toMatchObject({ kind: "model_error", status: 529, agent: "general-purpose" });
    expect(sent[0][0]).not.toHaveProperty("cost_usd_micros");
  });

  it("sends a tool decision with the tool and the decision only (Phase 2)", async () => {
    const { uploader, sent, advance } = harness([{ status: 200 }], { flushMs: 1_000 });
    uploader.add({
      kind: "tool_decision",
      at: 1_700_000_000_000,
      session: "sess-1",
      agent: null,
      tool: "Bash",
      decision: "owner_denied",
      ruleIndex: 0,
      waitMs: 12_000,
    });
    await advance(1_000);
    const [wire] = sent[0];
    expect(wire).toEqual({
      key: wire.key,
      kind: "tool_decision",
      session: "sess-1",
      at: 1_700_000_000_000,
      tool: "Bash",
      decision: "owner_denied",
      rule_index: 0,
      duration_ms: 12_000,
    });
  });

  it("gives every event its own key", async () => {
    const { uploader, sent, advance } = harness([{ status: 200 }], { flushMs: 1_000 });
    for (let i = 0; i < 20; i++) uploader.add(event());
    await advance(1_000);
    expect(new Set(sent[0].map((e) => e.key)).size).toBe(20);
  });

  it("batches, and sends a full batch without waiting for the timer", async () => {
    const { uploader, sent, advance } = harness([{ status: 200 }], { flushMs: 60_000, batchSize: 5 });
    for (let i = 0; i < 12; i++) uploader.add(event());
    await advance(0);
    expect(sent.map((b) => b.length)).toEqual([5, 5]);
    await advance(60_000);
    expect(sent.map((b) => b.length)).toEqual([5, 5, 2]);
    expect(uploader.stats()).toMatchObject({ queued: 0, sent: 12, dropped: 0 });
  });
});

describe("call uploader: retries keep the same keys", () => {
  it("keeps the events through a network failure and resends them with the SAME keys", async () => {
    const { uploader, sent, advance } = harness([new Error("ECONNREFUSED"), { status: 200 }], { flushMs: 1_000 });
    uploader.add(event());
    uploader.add(event());
    await advance(1_000);
    expect(uploader.stats().queued).toBe(2);
    await advance(60_000);
    expect(sent).toHaveLength(2);
    expect(sent[1].map((e) => e.key)).toEqual(sent[0].map((e) => e.key));
    expect(uploader.stats()).toMatchObject({ queued: 0, sent: 2 });
  });

  it("backs off on repeated failures instead of hammering the gateway", async () => {
    const { uploader, sent, advance } = harness([{ status: 502 }], { flushMs: 1_000 });
    uploader.add(event());
    for (let i = 0; i < 60; i++) await advance(1_000);
    // A minute of failures: 1 s, then doubling from 2 s up to the cap — a handful, not sixty.
    expect(sent.length).toBeLessThanOrEqual(7);
    expect(uploader.stats().queued).toBe(1);
  });

  it("waits out a rate limit for as long as the gateway asks", async () => {
    const { uploader, sent, advance } = harness([{ status: 429, retryAfterS: 60 }, { status: 200 }], { flushMs: 1_000 });
    uploader.add(event());
    await advance(1_000);
    await advance(59_000);
    expect(sent).toHaveLength(1);
    await advance(1_000);
    expect(sent).toHaveLength(2);
    expect(uploader.stats().queued).toBe(0);
  });

  it("keeps the events that arrived while a batch was in flight", async () => {
    let release;
    const sent = [];
    const uploader = createCallUploader({
      send: (events) => {
        sent.push(events.length);
        return new Promise((resolve) => (release = () => resolve({ status: 200 })));
      },
      flushMs: 1_000_000,
      setTimer: () => null,
      clearTimer: () => {},
    });
    uploader.add(event());
    const flushing = uploader.flush();
    uploader.add(event());
    release();
    await flushing;
    expect(uploader.stats()).toMatchObject({ queued: 1, sent: 1 });
  });
});

describe("call uploader: what it gives up on", () => {
  it("drops a batch the gateway refuses for good: a stopped agent, or a bad batch", async () => {
    for (const status of [403, 400, 413]) {
      const { uploader, advance } = harness([{ status }], { flushMs: 1_000 });
      uploader.add(event());
      await advance(1_000);
      expect(uploader.stats(), `status ${status}`).toMatchObject({ queued: 0, dropped: 1 });
    }
  });

  it("stops for a while when the gateway has no table for the records yet (before 0084)", async () => {
    const { uploader, sent, advance } = harness([{ status: 503, error: "client_events_unavailable" }], { flushMs: 1_000 });
    uploader.add(event());
    uploader.add(event());
    await advance(1_000);
    expect(uploader.stats()).toMatchObject({ queued: 0, dropped: 2 });
    uploader.add(event());
    await advance(5 * 60_000);
    expect(sent).toHaveLength(1);
    expect(uploader.stats()).toMatchObject({ queued: 0, dropped: 3 });
  });

  it("stops for a while on a gateway that has no such endpoint yet (an older deploy answers 404)", async () => {
    // npm, the Cloud deploy and `passcontrol update` ship at different times: a new
    // CLI meets an old gateway on day one. Retrying a 404 every minute forever, with a
    // full queue, helps nobody.
    for (const status of [404, 405]) {
      const { uploader, sent, advance } = harness([{ status }], { flushMs: 1_000 });
      uploader.add(event());
      await advance(1_000);
      expect(uploader.stats(), `status ${status}`).toMatchObject({ queued: 0, dropped: 1 });
      uploader.add(event());
      await advance(5 * 60_000);
      expect(sent, `status ${status}`).toHaveLength(1);
    }
  });

  it("gives up on a batch that fails the same way too many times, so it cannot pin the queue", async () => {
    const { uploader, sent, advance } = harness([{ status: 500 }], { flushMs: 1_000, maxAttempts: 5 });
    uploader.add(event());
    for (let i = 0; i < 10; i++) await advance(60_000);
    expect(sent).toHaveLength(5);
    expect(uploader.stats()).toMatchObject({ queued: 0, dropped: 1 });
  });

  it("holds at most maxQueue events and drops the oldest", async () => {
    const { uploader, sent, advance } = harness([new Error("down"), { status: 200 }], { flushMs: 1_000, maxQueue: 3 });
    for (let i = 0; i < 5; i++) uploader.add(event({ durationMs: i }));
    expect(uploader.stats()).toMatchObject({ queued: 3, dropped: 2 });
    await advance(1_000);
    await advance(60_000);
    expect(sent.at(-1).map((e) => e.duration_ms)).toEqual([2, 3, 4]);
  });

  it("stops its timer on close", async () => {
    const { uploader, sent, advance } = harness([{ status: 200 }], { flushMs: 1_000 });
    uploader.add(event());
    uploader.close();
    await advance(10_000);
    expect(sent).toHaveLength(0);
  });
});

// ── Through the real sidecar, against a fake gateway ──────────────────────────

const FIXTURE = JSON.parse(
  fs.readFileSync(new URL("./fixtures/otlp-logs-claude-code-2.1.296.json", import.meta.url), "utf8")
);
const FIXTURE_SESSION = "11111111-1111-4111-8111-111111111111";
// The identity values Claude Code attaches to every record (scrubbed in the fixture).
const IDENTITY = ["owner@example.test", "00000000-0000-4000-8000-0000000000aa", "user_00000000000000000000000000", "00000000-0000-4000-8000-0000000000bb", "0".repeat(64)];

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

async function sidecarWithGateway(options = {}) {
  const uploads = [];
  const gateway = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/api/auth/challenge") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ visa: "fake.visa.token", expires_in: 300 }));
        return;
      }
      if (req.url === CLIENT_EVENTS_PATH) {
        uploads.push({ method: req.method, headers: req.headers, raw: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: 1, rejected: 0 }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  const gatewayPort = await listen(gateway);
  const secret = ed25519.utils.randomPrivateKey();
  const sidecar = createSidecar({
    gateway: `http://127.0.0.1:${gatewayPort}`,
    passportId: b64url(ed25519.getPublicKey(secret)),
    passportSecret: b64url(secret),
    ...options,
  });
  const port = await listen(sidecar.server);
  return { sidecar, port, uploads };
}

const postOtlp = (port, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}${OTLP_LOGS_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("the sidecar uploads what Claude Code reports", () => {
  it("posts the reported call to the gateway as the agent, with a visa and a proof, and no identity", async () => {
    const { sidecar, port, uploads } = await sidecarWithGateway();
    expect((await postOtlp(port, FIXTURE)).status).toBe(200);
    await sidecar.uploader.flush();
    expect(uploads).toHaveLength(1);
    const [upload] = uploads;
    expect(upload.method).toBe("POST");
    expect(upload.headers.authorization).toBe("Bearer fake.visa.token");
    expect(upload.headers["x-passcontrol-proof"]).toBeTruthy();
    const body = JSON.parse(upload.raw);
    expect(body.source).toBe("claude_code_otel");
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ kind: "model_call", session: FIXTURE_SESSION, model: "claude-haiku-5-5", cost_usd_micros: 3927 });
    for (const value of IDENTITY) expect(upload.raw).not.toContain(value);
  });

  it("does not upload a session whose calls this sidecar relays: those already have receipts", async () => {
    const { sidecar, port, uploads } = await sidecarWithGateway();
    await fetch(`http://127.0.0.1:${port}/api/v1/anthropic/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-claude-code-session-id": FIXTURE_SESSION },
      body: JSON.stringify({ model: "claude-haiku-5-5" }),
    });
    await postOtlp(port, FIXTURE);
    await sidecar.uploader.flush();
    expect(uploads).toHaveLength(0);
  });

  it("uploads nothing when the operator turned it off", async () => {
    const { sidecar, port, uploads } = await sidecarWithGateway({ reportCalls: false });
    await postOtlp(port, FIXTURE);
    expect(sidecar.uploader).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(uploads).toHaveLength(0);
  });
});

describe("an upload sent through the sidecar's own listener", () => {
  it("is forwarded, but never shown on the board as a call", async () => {
    const { sidecar, port, uploads } = await sidecarWithGateway({ reportCalls: false });
    const rows = [];
    sidecar.feed.attach({ write: (line) => rows.push(JSON.parse(line)), on: () => {}, writableLength: 0 });
    const res = await fetch(`http://127.0.0.1:${port}${CLIENT_EVENTS_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "claude_code_otel", events: [] }),
    });
    expect(res.status).toBe(200);
    expect(uploads).toHaveLength(1);
    expect(rows.filter((r) => r.type === "call")).toHaveLength(0);
  });
});
