import http from "node:http";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

import { createSidecar, startSidecar } from "../sidecar.mjs";

// These drive the REAL sidecar over REAL sockets using the proxy wire protocol a
// client with HTTPS_PROXY set actually speaks — `CONNECT host:port` and
// absolute-form request lines. Nothing here stubs the sidecar's own transport,
// because the thing under test is what it does with a destination the client
// chose rather than one we configured.

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const LEAK = "sk-a-real-users-provider-key";

let gateway;
let gatewayPort;
let echo;
let echoPort;
let sidecar;
let sidecarPort;
let received;
let refusals;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

/**
 * A CONNECT exactly as a proxy-aware HTTP client issues it.
 *
 * Node emits `connect` for EVERY response to a CONNECT — its parser marks the
 * exchange as an upgrade on the method, not on the status — so a refusal arrives
 * on the same event with a non-2xx `statusCode` and its body in the `head`
 * buffer. Branching on the event rather than the status is how a caller
 * mistakes a 403 for an open tunnel, which is worth pinning here: it is exactly
 * the mistake a client integrating against this proxy would make.
 */
function connect(port, target, { payload } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: target });

    req.on("connect", (res, socket, head) => {
      const tunnelled = res.statusCode >= 200 && res.statusCode < 300;
      const chunks = head?.length ? [head] : [];
      socket.on("error", reject);

      if (!tunnelled) {
        socket.on("data", (c) => chunks.push(c));
        const done = () =>
          resolve({
            tunnelled: false,
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          });
        socket.on("end", done);
        socket.on("close", done);
        return;
      }

      if (!payload) {
        socket.destroy();
        resolve({ tunnelled: true, status: res.statusCode, headers: res.headers });
        return;
      }
      socket.on("data", (c) => chunks.push(c));
      socket.on("end", () =>
        resolve({
          tunnelled: true,
          status: res.statusCode,
          headers: res.headers,
          echoed: Buffer.concat(chunks).toString(),
        })
      );
      socket.end(payload);
    });

    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ tunnelled: false, status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

/** An absolute-form request line — what a proxy client sends for a plain-HTTP URL. */
function proxyRequest(port, absoluteUrl, { method = "POST", headers = {}, body = "{}" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, path: absoluteUrl, headers: { "content-type": "application/json", ...headers } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })
        );
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

beforeEach(async () => {
  received = [];
  refusals = [];
  gateway = http.createServer((req, res) => {
    if (req.url === "/api/auth/challenge") {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ visa: "fake.visa.token", expires_in: 300 }));
      return;
    }
    req.resume();
    received.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  gatewayPort = await listen(gateway);

  echo = net.createServer((socket) => socket.pipe(socket));
  echoPort = await listen(echo);

  const secret = ed25519.utils.randomPrivateKey();
  sidecar = createSidecar({
    gateway: `http://127.0.0.1:${gatewayPort}`,
    passportId: b64url(ed25519.getPublicKey(secret)),
    passportSecret: b64url(secret),
    allowConnectHosts: [`127.0.0.1:${echoPort}`],
    onRefusal: (verdict) => refusals.push(verdict),
  });
  sidecarPort = await listen(sidecar.server);
});

afterEach(async () => {
  for (const server of [sidecar?.server, gateway, echo]) {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
  }
});

describe("CONNECT — the HTTPS_PROXY front door", () => {
  // The load-bearing refusal. Tunnelling this would produce a provider call that
  // is completely ungoverned while sitting behind the component whose entire job
  // is governing it — the operator would believe budgets and scope applied.
  it("refuses to tunnel to a provider instead of silently carrying an ungoverned call", async () => {
    const res = await connect(sidecarPort, "api.anthropic.com:443");

    expect(res.tunnelled).toBe(false);
    expect(res.status).toBe(403);
    expect(res.headers["x-passcontrol-refusal"]).toBe("provider_tunnel_not_governed");
    expect(res.headers["x-passcontrol-help"]).toBeTruthy();
    expect(res.body).toMatch(/anthropic/);
  });

  it("refuses an unrelated host, so the sidecar is not an open proxy", async () => {
    const res = await connect(sidecarPort, "example.com:443");

    expect(res.tunnelled).toBe(false);
    expect(res.status).toBe(403);
    expect(res.headers["x-passcontrol-refusal"]).toBe("host_not_allowed");
  });

  it("refuses a malformed CONNECT target with 400", async () => {
    const res = await connect(sidecarPort, "not-a-target");

    expect(res.status).toBe(400);
    expect(res.headers["x-passcontrol-refusal"]).toBe("bad_connect_target");
  });

  it("tunnels to the configured gateway", async () => {
    const res = await connect(sidecarPort, `127.0.0.1:${gatewayPort}`);

    expect(res.tunnelled).toBe(true);
    expect(res.status).toBe(200);
  });

  it("carries bytes both ways once tunnelled", async () => {
    const res = await connect(sidecarPort, `127.0.0.1:${echoPort}`, { payload: "ping" });

    expect(res.tunnelled).toBe(true);
    expect(res.echoed).toBe("ping");
  });

  // A CONNECT client usually surfaces the status code and nothing else — no
  // body, no headers — so the sidecar's own console is the channel an operator
  // can always read. It is a real output, not a debug line.
  it("reports the refusal on the sidecar's console channel", async () => {
    await connect(sidecarPort, "api.openai.com:443");

    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ code: "provider_tunnel_not_governed" });
    expect(refusals[0].help).toMatch(/api\/v1\/openai/);
  });

  it("never leaks a provider key the client attached to the CONNECT", async () => {
    const res = await connect(sidecarPort, "api.anthropic.com:443");

    expect(res.body).not.toContain(LEAK);
    expect(JSON.stringify(res.headers)).not.toContain(LEAK);
  });
});

describe("absolute-form proxy requests", () => {
  it("governs a provider URL by routing it through the gateway with a visa", async () => {
    const res = await proxyRequest(sidecarPort, "http://api.anthropic.com/v1/messages", {
      headers: { "x-api-key": LEAK },
    });

    expect(res.status).toBe(200);
    const sent = received.at(-1);
    expect(sent.url).toBe("/api/v1/anthropic/v1/messages");
    expect(sent.headers.authorization).toBe("Bearer fake.visa.token");
    const leaked = Object.entries(sent.headers).filter(([, v]) => String(v).includes(LEAK));
    expect(leaked, "the client's raw provider key left the machine").toEqual([]);
  });

  it("strips hop-by-hop proxy headers rather than forwarding them upstream", async () => {
    await proxyRequest(sidecarPort, "http://api.anthropic.com/v1/messages", {
      headers: { "proxy-connection": "keep-alive", "proxy-authorization": `Basic ${LEAK}` },
    });

    const sent = received.at(-1);
    expect(sent.headers["proxy-connection"]).toBeUndefined();
    expect(sent.headers["proxy-authorization"]).toBeUndefined();
  });

  it("refuses an absolute-form URL for a host that is not a provider or the gateway", async () => {
    const res = await proxyRequest(sidecarPort, "http://example.com/anything");

    expect(res.status).toBe(403);
    expect(res.headers["x-passcontrol-refusal"]).toBe("host_not_allowed");
    expect(received).toEqual([]);
  });

  it("still serves the origin-form path the sidecar has always served", async () => {
    const res = await proxyRequest(sidecarPort, "/api/v1/anthropic/v1/messages");

    expect(res.status).toBe(200);
    expect(received.at(-1).url).toBe("/api/v1/anthropic/v1/messages");
  });
});

describe("bind guard", () => {
  // A sidecar reachable off-host is a visa-minting endpoint for anyone on the
  // LAN: it holds the passport and hands out the agent's scope and budget to
  // whoever connects. Loopback is not a default to be quietly overridden.
  it("refuses a non-loopback bind without an explicit opt-in", () => {
    expect(() =>
      startSidecar({
        gateway: `http://127.0.0.1:${gatewayPort}`,
        passportId: "x",
        passportSecret: "y",
        host: "0.0.0.0",
      })
    ).toThrow(/loopback/i);
  });
});
