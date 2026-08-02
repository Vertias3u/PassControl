import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

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
  sidecar = createSidecar({
    gateway: `http://127.0.0.1:${gatewayPort}`,
    passportId: b64url(ed25519.getPublicKey(secret)),
    passportSecret: b64url(secret),
  });
});

afterEach(async () => {
  for (const server of [sidecar?.server, gateway]) {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
  }
});

async function proxy(headers) {
  const port = await listen(sidecar.server);
  await fetch(`http://127.0.0.1:${port}/api/v1/anthropic/v1/messages`, {
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
