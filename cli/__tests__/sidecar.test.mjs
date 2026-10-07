import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

import { createSidecar } from "../sidecar.mjs";

// The sidecar's whole reason to exist is that the client stops holding the
// provider key: it strips whatever credential the client sent and substitutes a
// short-lived visa. These tests drive the REAL sidecar against a fake gateway,
// because the thing being asserted is what actually leaves the machine.

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const LEAK = "sk-a-real-users-provider-key";

let gateway;
let sidecar;
let received;
let passportId;

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

beforeEach(async () => {
  received = [];
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
  const gatewayPort = await listen(gateway);

  const secret = ed25519.utils.randomPrivateKey();
  passportId = b64url(ed25519.getPublicKey(secret));
  sidecar = createSidecar({
    gateway: `http://127.0.0.1:${gatewayPort}`,
    passportId,
    passportSecret: b64url(secret),
  });
});

afterEach(async () => {
  for (const server of [sidecar?.server, sidecar?.ollamaServer, gateway]) {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
  }
});

async function proxy(headers, suffix = "") {
  const port = await listen(sidecar.server);
  await fetch(`http://127.0.0.1:${port}/api/v1/anthropic/v1/messages${suffix}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
  return received.at(-1);
}

describe("sidecar credential stripping", () => {
  it("replaces the client's Authorization with a minted visa", async () => {
    const sent = await proxy({ authorization: `Bearer ${LEAK}` });

    expect(sent.headers.authorization).toBe("Bearer fake.visa.token");
  });

  it("signs every upstream request and binds the proof to method, URI, and exact visa", async () => {
    const sent = await proxy({ authorization: `Bearer ${LEAK}` }, "?transport_hint=stream");
    const [payloadPart, signaturePart] = String(sent.headers["x-passcontrol-proof"]).split(".");
    const payloadBytes = new Uint8Array(Buffer.from(payloadPart, "base64url"));
    const payload = JSON.parse(Buffer.from(payloadBytes).toString("utf8"));
    const signature = new Uint8Array(Buffer.from(signaturePart, "base64url"));

    expect(payload).toMatchObject({
      htm: "POST",
      htu: expect.stringMatching(/\/api\/v1\/anthropic\/v1\/messages$/),
      iat: expect.any(Number),
      jti: expect.any(String),
      vh: b64url(sha256(new TextEncoder().encode("fake.visa.token"))),
    });
    expect(new URL(payload.htu).search).toBe("");
    expect(sent.url).toContain("?transport_hint=stream");
    expect(ed25519.verify(signature, payloadBytes, Buffer.from(passportId, "base64url"))).toBe(true);
  });

  // Header names are the attack surface here, not header values. A client that
  // was previously configured with a raw provider key spells it differently
  // depending on which app it is: `x-api-key` (Anthropic), `api-key` (Azure
  // style), `openai-api-key`, or `proxy-authorization`. All of these reached the
  // gateway verbatim, because the strip list named only two of them.
  it.each([
    "x-api-key",
    "X-Api-Key",
    "api-key",
    "Api-Key",
    "openai-api-key",
    "x-goog-api-key",
    "proxy-authorization",
    "x-auth-token",
  ])("does not forward a provider key sent as %s", async (header) => {
    const sent = await proxy({ [header]: LEAK });

    const leaked = Object.entries(sent.headers).filter(([, v]) => String(v).includes(LEAK));
    expect(leaked, `"${header}" reached the gateway carrying the raw key`).toEqual([]);
  });

  // Over-stripping is the opposite failure: providers carry real behaviour on
  // non-credential headers, and dropping them silently changes the request.
  it.each(["anthropic-version", "anthropic-beta", "openai-organization", "user-agent"])(
    "still forwards the non-credential header %s",
    async (header) => {
      const sent = await proxy({ [header]: "keep-me" });

      expect(sent.headers[header.toLowerCase()]).toBe("keep-me");
    }
  );
});

// The gateway builds a service call's pagination and redirect URLs from its OWN
// origin, which is right for a client calling it directly and wrong behind the
// sidecar: Octokit would follow page 2 straight to the gateway without the visa
// only the sidecar adds. So the sidecar points those URLs back at itself.
describe("service URLs in responses (any-API)", () => {
  it("rewrites a gateway Link and Location to the sidecar, and leaves other hosts alone", async () => {
    let gatewayOrigin = "";
    const svcGateway = http.createServer((req, res) => {
      if (req.url === "/api/auth/challenge") {
        req.resume();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ visa: "fake.visa.token", expires_in: 300 }));
        return;
      }
      req.resume();
      res.writeHead(200, {
        "content-type": "application/json",
        link: `<${gatewayOrigin}/api/v1/svc/github/repos/acme/web/issues?page=2>; rel="next"`,
        location: "https://codeload.github.com/acme/web/legacy.tar.gz/refs/heads/main",
      });
      res.end("[]");
    });
    const gatewayPort = await listen(svcGateway);
    gatewayOrigin = `http://127.0.0.1:${gatewayPort}`;
    const secret = ed25519.utils.randomPrivateKey();
    const svcSidecar = createSidecar({
      gateway: gatewayOrigin,
      passportId: b64url(ed25519.getPublicKey(secret)),
      passportSecret: b64url(secret),
    });
    try {
      const port = await listen(svcSidecar.server);
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/svc/github/repos/acme/web/issues`);
      expect(res.headers.get("link")).toBe(
        `<http://127.0.0.1:${port}/api/v1/svc/github/repos/acme/web/issues?page=2>; rel="next"`
      );
      expect(res.headers.get("location")).toBe("https://codeload.github.com/acme/web/legacy.tar.gz/refs/heads/main");
    } finally {
      for (const server of [svcSidecar.server, svcGateway]) {
        if (server.listening) await new Promise((resolve) => server.close(resolve));
      }
    }
  });
});

// A second listener for apps that only take OLLAMA_HOST (host:port, no path).
// Everything on it maps under the gateway's `local` provider. It is its own
// port, so the main sidecar's forward-proxy handling is untouched, and an
// absolute-form request (a forward-proxy request for some other host) is refused
// rather than turned into a governed local call.
describe("the Ollama listener", () => {
  async function ollamaCall(method, path, { absolute = false } = {}) {
    const port = sidecar.ollamaServer.listening ? sidecar.ollamaServer.address().port : await listen(sidecar.ollamaServer);
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, method, path: absolute ? `http://elsewhere.example${path}` : path, headers: { "content-type": "application/json", "x-api-key": LEAK } },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        }
      );
      req.on("error", reject);
      req.end(method === "POST" ? '{"model":"qwen2.5:0.5b"}' : undefined);
    });
  }

  it("maps /api/chat under /api/v1/local with a visa, and drops the client's key", async () => {
    const res = await ollamaCall("POST", "/api/chat");
    expect(res.status).toBe(200);
    expect(received.at(-1).url).toBe("/api/v1/local/api/chat");
    expect(received.at(-1).headers.authorization).toBe("Bearer fake.visa.token");
    expect(JSON.stringify(received.at(-1).headers)).not.toContain(LEAK);
  });

  it("maps the OpenAI-compatible /v1 paths too", async () => {
    await ollamaCall("POST", "/v1/chat/completions");
    expect(received.at(-1).url).toBe("/api/v1/local/v1/chat/completions");
  });

  it("forwards the health probe instead of answering it", async () => {
    await ollamaCall("GET", "/");
    expect(received.at(-1).url).toBe("/api/v1/local/api/version");
  });

  it("keeps a dot-segment path inside the local prefix", async () => {
    await ollamaCall("POST", "/api/../../../control/v1/agents");
    expect(received.at(-1).url).toBe("/api/v1/local/control/v1/agents");
    await ollamaCall("POST", "/api/%2e%2e/%2e%2e/control/v1/agents");
    expect(received.at(-1).url).toBe("/api/v1/local/control/v1/agents");
  });

  it("refuses an absolute-form request", async () => {
    const res = await ollamaCall("POST", "/api/chat", { absolute: true });
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });
});
