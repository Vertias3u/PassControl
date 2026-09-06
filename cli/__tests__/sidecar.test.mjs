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
  for (const server of [sidecar?.server, gateway]) {
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
