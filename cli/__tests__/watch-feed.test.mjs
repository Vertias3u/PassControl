import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

import { createSidecar } from "../sidecar.mjs";
import { createWatchFeed, refusalCode, requestModel, WATCH_PATH } from "../watch-feed.mjs";
import { openFeed } from "../watch.mjs";

// `passcontrol watch` (F6) reads a loopback-only feed from the sidecar: one event per
// call it relays. These tests drive the REAL sidecar against a fake gateway, because
// what is asserted is what the feed says, what it never says (a prompt), and that it
// never changes what the client gets or sends anything upstream.

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const MARKER = "PROMPT-MARKER-7f3c9e"; // in every request body; never on the feed

let gateway;
let gatewayPort;
let sidecar;
let port;
let received;
const subscribers = new Set();

async function listen(server, host = "127.0.0.1") {
  await new Promise((resolve) => server.listen(0, host, resolve));
  return server.address().port;
}

const REFUSAL = { error: "blocked_suspended", message: `PassControl refused this call (${MARKER} is not echoed here)` };
const PROVIDER_ERROR = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };

function startGateway() {
  return http.createServer((req, res) => {
    if (req.url === "/api/auth/challenge") {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ visa: "fake.visa.token", expires_in: 300 }));
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ url: req.url, method: req.method, headers: req.headers });
      const mode = req.headers["x-test-mode"] ?? "ok";
      const json = (status, body) => {
        res.writeHead(status, { "content-type": "application/json", "x-passcontrol-receipt-id": "rcpt-1" });
        res.end(JSON.stringify(body));
      };
      if (req.url.startsWith("/api/v1/self")) return json(200, { budget: {} });
      if (mode === "denied") return json(403, REFUSAL);
      if (mode === "provider-error") return json(529, PROVIDER_ERROR);
      if (mode === "escape-code") return json(403, { error: "\u001b[2Jwiped" });
      if (mode === "spaces") return json(404, { error: "model not found" });
      // A streamed success: headers first, the body over ~60ms.
      res.writeHead(200, { "content-type": "text/event-stream", "x-passcontrol-receipt-id": "rcpt-ok" });
      res.write("event: message_start\ndata: {}\n\n");
      setTimeout(() => res.write("event: content_block_delta\ndata: {}\n\n"), 30);
      setTimeout(() => res.end("event: message_stop\ndata: {}\n\n"), 60);
    });
  });
}

beforeEach(async () => {
  received = [];
  gateway = startGateway();
  gatewayPort = await listen(gateway);
});

afterEach(async () => {
  for (const s of subscribers) s.destroy();
  subscribers.clear();
  for (const server of [sidecar?.server, sidecar?.ollamaServer, gateway]) {
    if (server?.listening) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }
  sidecar = null;
});

async function start(options = {}) {
  const secret = ed25519.utils.randomPrivateKey();
  sidecar = createSidecar({
    gateway: `http://127.0.0.1:${gatewayPort}`,
    passportId: b64url(ed25519.getPublicKey(secret)),
    passportSecret: b64url(secret),
    onRefusal: () => {},
    ...options,
  });
  port = await listen(sidecar.server, options.listenHost);
  return sidecar;
}

/** Subscribes the way `passcontrol watch` does, and collects every line. */
function subscribe() {
  const events = [];
  const lines = [];
  let resolveHello;
  const hello = new Promise((r) => (resolveHello = r));
  const feed = openFeed({
    port,
    onEvent: (event, raw) => {
      events.push(event);
      lines.push(raw);
      if (event.type === "hello") resolveHello(event);
    },
    onError: () => {},
  });
  subscribers.add(feed);
  const until = async (predicate, timeoutMs = 3000) => {
    const end = Date.now() + timeoutMs;
    while (!predicate(events)) {
      if (Date.now() > end) throw new Error(`feed timed out; got ${JSON.stringify(events)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return events;
  };
  return { events, lines, hello, until };
}

async function call({ mode = "ok", headers = {}, model = "claude-sonnet-5-5", path = "/api/v1/anthropic/v1/messages" } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-mode": mode, ...headers },
    body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: "user", content: `say hi ${MARKER}` }] }),
  });
  return { status: response.status, body: await response.text() };
}

/** A raw GET to the feed with headers of our choosing (the guards' attacker shapes). */
function rawGet(path, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
        // The feed never ends on its own: one line is the answer.
        if (res.statusCode === 200 && body.includes("\n")) {
          resolve({ status: res.statusCode, headers: res.headers, body });
          res.destroy();
        }
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const calls = (events) => events.filter((e) => e.type === "call");

describe("the watch feed: handshake and locality", () => {
  it("answers a hello line on the sidecar's own port, and never sends the request upstream", async () => {
    await start();
    const { hello } = subscribe();
    const first = await hello;
    expect(first).toMatchObject({ type: "hello", feed: "passcontrol-watch", v: 1, run: sidecar.runId });
    expect(received).toEqual([]);
  });

  it("serves ndjson, not cached, not sniffed, with no CORS grant", async () => {
    await start();
    const r = await rawGet(WATCH_PATH);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toBe("application/x-ndjson");
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers every other /_passcontrol/ path locally with a 404, never forwarding it", async () => {
    await start();
    const r = await rawGet("/_passcontrol/anything");
    expect(r.status).toBe(404);
    expect(received).toEqual([]);
  });

  it("refuses a browser's cross-origin request (an Origin header)", async () => {
    await start();
    const r = await rawGet(WATCH_PATH, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(received).toEqual([]);
  });

  it("refuses a Host that is not this loopback listener (DNS rebinding)", async () => {
    await start();
    for (const host of [`evil.example:${port}`, `127.0.0.1:${port + 1}`, "127.0.0.1", `localhost.evil.example:${port}`]) {
      const r = await rawGet(WATCH_PATH, { host });
      expect(r.status, host).toBe(403);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      const r = await rawGet(WATCH_PATH, { host });
      expect(r.status, host).toBe(200);
    }
    expect(received).toEqual([]);
  });

  it("answers GET only", async () => {
    await start();
    const r = await rawGet(WATCH_PATH, {}, "POST");
    expect(r.status).toBe(405);
    expect(received).toEqual([]);
  });

  it("is off when the sidecar is bound off loopback, and still never forwards the path", async () => {
    await start({ host: "0.0.0.0" });
    const r = await rawGet(WATCH_PATH);
    expect(r.status).toBe(404);
    expect(r.body).toMatch(/loopback/);
    expect(received).toEqual([]);
  });

  it("caps its subscribers", async () => {
    await start({ watchMaxSubscribers: 2 });
    const a = subscribe();
    const b = subscribe();
    await a.hello;
    await b.hello;
    const r = await rawGet(WATCH_PATH);
    expect(r.status).toBe(503);
  });
});

describe("the watch feed: one event per call, and what each says", () => {
  it("a relayed call is BOARDED with its session, sub-agent, parent, model and provider; its end carries the total time", async () => {
    await start();
    const feed = subscribe();
    await feed.hello;
    const res = await call({
      headers: { "x-claude-code-session-id": "sess-1", "x-claude-code-agent-id": "a02", "x-claude-code-parent-agent-id": "a01" },
    });
    expect(res.status).toBe(200);
    await feed.until((ev) => ev.some((e) => e.type === "end"));
    const [c] = calls(feed.events);
    expect(c).toMatchObject({
      outcome: "boarded",
      status: 200,
      ses: "sess-1",
      agent: "a02",
      parent: "a01",
      model: "claude-sonnet-5-5",
      provider: "anthropic",
      code: null,
    });
    expect(typeof c.at).toBe("number");
    expect(c.ttfb).toBeGreaterThanOrEqual(0);
    const end = feed.events.find((e) => e.type === "end");
    expect(end.seq).toBe(c.seq);
    // The body took ~60ms after the headers: the total is not the time to headers.
    expect(end.ms).toBeGreaterThanOrEqual(c.ttfb + 40);
  });

  it("a call with no CLI session falls back to this run, as the gateway does", async () => {
    await start();
    const feed = subscribe();
    await feed.hello;
    await call({ headers: { "x-passcontrol-agent": "researcher" } });
    await feed.until((ev) => calls(ev).length === 1);
    expect(calls(feed.events)[0]).toMatchObject({ ses: sidecar.runId, agent: "researcher", parent: null });
  });

  it("a gateway refusal is DENIED with its code, and the client gets the gateway's body byte for byte", async () => {
    await start();
    const feed = subscribe();
    await feed.hello;
    const res = await call({ mode: "denied" });
    expect(res.status).toBe(403);
    expect(res.body).toBe(JSON.stringify(REFUSAL));
    await feed.until((ev) => calls(ev).length === 1);
    expect(calls(feed.events)[0]).toMatchObject({ outcome: "denied", code: "blocked_suspended", status: 403 });
  });

  it("a provider's own error is ERROR with its status, not DENIED", async () => {
    await start();
    const feed = subscribe();
    await feed.hello;
    const res = await call({ mode: "provider-error" });
    expect(res.body).toBe(JSON.stringify(PROVIDER_ERROR));
    await feed.until((ev) => calls(ev).length === 1);
    expect(calls(feed.events)[0]).toMatchObject({ outcome: "error", code: null, status: 529 });
  });

  it.each([
    ["an escape sequence", "escape-code"],
    ["prose, as Ollama's errors are", "spaces"],
  ])("an error string that is not a gateway code (%s) is ERROR, and is not carried", async (_name, mode) => {
    await start();
    const feed = subscribe();
    await feed.hello;
    await call({ mode });
    await feed.until((ev) => calls(ev).length === 1);
    expect(calls(feed.events)[0]).toMatchObject({ outcome: "error", code: null });
    expect(feed.lines.join("\n")).not.toContain("\u001b");
    expect(feed.lines.join("\n")).not.toContain("wiped");
  });

  it("a call the sidecar itself refuses is DENIED with the sidecar's code, and the gateway never sees it", async () => {
    await start();
    const feed = subscribe();
    await feed.hello;
    const r = await new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port, method: "GET", path: "http://not-a-provider.example/x", headers: { "x-claude-code-session-id": "sess-9" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        }
      );
      req.end();
    });
    expect(r).toBe(403);
    await feed.until((ev) => calls(ev).length === 1);
    expect(calls(feed.events)[0]).toMatchObject({ outcome: "denied", code: "host_not_allowed", status: 403, ses: "sess-9" });
    expect(received).toEqual([]);
  });

  it("a gateway that cannot be reached is ERROR sidecar_upstream_error", async () => {
    await start();
    await sidecar.getVisa(); // warm, so the failure is the call's own
    gateway.closeAllConnections();
    await new Promise((resolve) => gateway.close(resolve));
    const feed = subscribe();
    await feed.hello;
    const res = await call();
    expect(res.status).toBe(502);
    await feed.until((ev) => calls(ev).length === 1);
    expect(calls(feed.events)[0]).toMatchObject({ outcome: "error", code: "sidecar_upstream_error", status: 502 });
  });

  it("a client that aborts its upload is an ERROR row, and the gateway never sees it", async () => {
    await start();
    const feed = subscribe();
    await feed.hello;
    await new Promise((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/v1/anthropic/v1/messages",
        headers: { "content-type": "application/json", "content-length": "1000", "x-claude-code-session-id": "gone" },
      });
      req.on("error", () => resolve());
      req.write('{"model":"claude');
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 50);
    });
    await feed.until((ev) => calls(ev).length === 1);
    expect(calls(feed.events)[0]).toMatchObject({ outcome: "error", code: "sidecar_upstream_error", ses: "gone" });
    expect(received).toEqual([]);
  });

  it("the budget read (GET /api/v1/self) is not a call on the board", async () => {
    await start();
    const feed = subscribe();
    await feed.hello;
    await fetch(`http://127.0.0.1:${port}/api/v1/self`).then((r) => r.text());
    await call();
    await feed.until((ev) => calls(ev).length >= 1);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls(feed.events)).toHaveLength(1);
    expect(received.map((r) => r.url)).toContain("/api/v1/self");
  });

  it("the Ollama listener's calls are on the feed too, as provider local", async () => {
    await start();
    const ollamaPort = await listen(sidecar.ollamaServer);
    const feed = subscribe();
    await feed.hello;
    await fetch(`http://127.0.0.1:${ollamaPort}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "llama3.2", messages: [{ role: "user", content: MARKER }] }),
    }).then((r) => r.text());
    await feed.until((ev) => calls(ev).length === 1);
    expect(calls(feed.events)[0]).toMatchObject({ provider: "local", model: "llama3.2", outcome: "boarded" });
  });

  it("exactly one call event per call, across every outcome", async () => {
    await start();
    const feed = subscribe();
    await feed.hello;
    await call();
    await call({ mode: "denied" });
    await call({ mode: "provider-error" });
    await call({ path: "/api/v1/openai/v1/chat/completions", model: "gpt-5" });
    await feed.until((ev) => calls(ev).length >= 4 && ev.filter((e) => e.type === "end").length >= 4);
    await new Promise((r) => setTimeout(r, 100));
    expect(calls(feed.events)).toHaveLength(4);
    expect(new Set(calls(feed.events).map((c) => c.seq)).size).toBe(4);
  });

  it("never carries the prompt: the marker in every request body is on no line of the feed", async () => {
    await start();
    const feed = subscribe();
    await feed.hello;
    await call({ headers: { "x-claude-code-session-id": "s" } });
    await call({ mode: "denied" });
    await call({ model: `evil ${MARKER}` }); // not a model id: dropped, not echoed
    await feed.until((ev) => calls(ev).length === 3);
    await new Promise((r) => setTimeout(r, 100));
    const all = feed.lines.join("\n");
    expect(all).not.toContain(MARKER);
    expect(calls(feed.events)[2].model).toBeNull();
  });

  it("replays recent calls to a subscriber that arrives later, then goes live", async () => {
    await start();
    await call({ headers: { "x-claude-code-session-id": "early" } });
    await new Promise((r) => setTimeout(r, 100));
    const feed = subscribe();
    await feed.hello;
    await feed.until((ev) => calls(ev).length === 1);
    expect(calls(feed.events)[0]).toMatchObject({ ses: "early" });
    expect(typeof calls(feed.events)[0].ms).toBe("number");
    await call({ headers: { "x-claude-code-session-id": "late" } });
    await feed.until((ev) => calls(ev).length === 2);
    expect(calls(feed.events)[1]).toMatchObject({ ses: "late" });
  });

  it("keeps only its most recent calls in memory", async () => {
    await start({ watchCapacity: 2 });
    for (const s of ["one", "two", "three"]) await call({ headers: { "x-claude-code-session-id": s } });
    await new Promise((r) => setTimeout(r, 100));
    const feed = subscribe();
    await feed.hello;
    await feed.until((ev) => calls(ev).length === 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls(feed.events).map((c) => c.ses)).toEqual(["two", "three"]);
  });
});

describe("the watch feed unit pieces", () => {
  it("drops a subscriber that cannot keep up instead of buffering for it", () => {
    const feed = createWatchFeed({ runId: "r" });
    let destroyed = false;
    const res = {
      writableLength: 0,
      write() {
        this.writableLength += 2 * 1024 * 1024; // never drains
        return false;
      },
      destroy: () => {
        destroyed = true;
      },
      on: () => {},
    };
    feed.attach(res);
    feed.record({ outcome: "boarded", status: 200 });
    expect(destroyed).toBe(true);
    expect(feed.subscriberCount()).toBe(0);
  });

  it("a replay larger than a socket's high-water mark does not drop a new subscriber", () => {
    const feed = createWatchFeed({ runId: "r", capacity: 500 });
    for (let i = 0; i < 500; i++) feed.record({ outcome: "boarded", status: 200, lineage: { session: "s".repeat(100), agent: null, parent: null } });
    let destroyed = false;
    const res = {
      writableLength: 0,
      write(line) {
        this.writableLength += line.length; // a socket that has not drained yet
        return this.writableLength < 16 * 1024;
      },
      destroy: () => {
        destroyed = true;
      },
      on: () => {},
    };
    feed.attach(res);
    expect(res.writableLength).toBeGreaterThan(16 * 1024);
    expect(destroyed).toBe(false);
    expect(feed.subscriberCount()).toBe(1);
  });

  it("a call is announced once, however often it is settled", () => {
    const feed = createWatchFeed({ runId: "r" });
    const lines = [];
    feed.attach({ writableLength: 0, write: (l) => lines.push(l), destroy: () => {}, on: () => {} });
    const call = feed.begin({});
    call.settle({ outcome: "boarded", status: 200 });
    call.settle({ outcome: "error", status: 502 });
    call.finish();
    call.finish();
    const events = lines.map((l) => JSON.parse(l));
    expect(events.filter((e) => e.type === "call")).toHaveLength(1);
    expect(events.filter((e) => e.type === "end")).toHaveLength(1);
    expect(events.find((e) => e.type === "call").outcome).toBe("boarded");
  });

  it("a subscriber that throws never reaches the call", () => {
    const feed = createWatchFeed({ runId: "r" });
    feed.attach({ write: () => { throw new Error("boom"); }, destroy: () => {}, on: () => {} });
    expect(() => feed.record({ outcome: "boarded", status: 200 })).not.toThrow();
  });

  it.each([
    ['{"model":"claude-opus-5-5","messages":[]}', "claude-opus-5-5"],
    ['{"messages":[],"model":"gpt-5.1-codex"}', "gpt-5.1-codex"],
    ['{"model":"openrouter/anthropic/claude-sonnet-5.5"}', "openrouter/anthropic/claude-sonnet-5.5"],
    ['{"model":"qwen3:8b"}', "qwen3:8b"],
    ['{"model":"has space"}', null],
    ['{"model":"\\u001b[31m"}', null],
    ['{"model":42}', null],
    ['{"nested":{"model":"x"}}', null],
    ["not json", null],
    ["", null],
  ])("requestModel(%s) is %s", (body, expected) => {
    expect(requestModel(body ? Buffer.from(body) : undefined)).toBe(expected);
  });

  it.each([
    ['{"error":"blocked_suspended"}', "blocked_suspended"],
    ['{"error":"budget_exceeded","message":"x"}', "budget_exceeded"],
    ['{"type":"error","error":{"type":"overloaded_error"}}', null],
    ['{"error":"model not found"}', null],
    ['{"error":"Bad"}', null],
    ['{"error":"\\u001b[2J"}', null],
    ['{"error":"a_very_long_code_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', null],
    ["{trunc", null],
  ])("refusalCode(%s) is %s", (text, expected) => {
    expect(refusalCode(text)).toBe(expected);
  });
});
