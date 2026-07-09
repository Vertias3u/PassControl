import http from "node:http";
import { Readable } from "node:stream";
import { ed25519 } from "@noble/curves/ed25519";
import { fail, formatChallengeError, ok, step } from "./config.mjs";

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

const STRIP_REQ = new Set(["authorization", "x-api-key", "host", "content-length", "accept-encoding", "connection"]);
const STRIP_RES = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

export function createSidecar({ gateway, passportId, passportSecret, port = 8788, host = "127.0.0.1", refreshSkewSeconds = 30 }) {
  const skewMs = Math.max(0, Number(refreshSkewSeconds) * 1000);
  let cached = null;
  let inflight = null;

  async function mint() {
    const obj = { passport_id: passportId, ts: Date.now(), nonce: crypto.randomUUID() };
    const payload = b64url(new TextEncoder().encode(JSON.stringify(obj)));
    const signature = b64url(ed25519.sign(fromB64url(payload), fromB64url(passportSecret)));
    const res = await fetch(`${gateway}/api/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload, signature }),
    });
    if (!res.ok) throw new Error(formatChallengeError(res.status, await res.text()));
    const { visa, expires_in } = await res.json();
    if (!visa) throw new Error("challenge returned no visa");
    return { token: visa, expiresAt: Date.now() + (expires_in ?? 300) * 1000 };
  }

  async function getVisa() {
    if (cached && Date.now() < cached.expiresAt - skewMs) return cached.token;
    if (inflight) return inflight;
    inflight = mint()
      .then((v) => {
        cached = v;
        return v.token;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
      req.on("error", reject);
    });
  }

  async function fetchUpstream(req, body, visa) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!STRIP_REQ.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
    }
    headers["authorization"] = `Bearer ${visa}`;
    headers["accept-encoding"] = "identity";
    return fetch(`${gateway}${req.url}`, { method: req.method, headers, body: body ?? undefined });
  }

  function writeResponse(res, upstream) {
    const outHeaders = {};
    upstream.headers.forEach((v, k) => {
      if (!STRIP_RES.has(k.toLowerCase())) outHeaders[k] = v;
    });
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
  }

  const server = http.createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      let upstream = await fetchUpstream(req, body, await getVisa());
      if (upstream.status === 401) {
        cached = null;
        upstream = await fetchUpstream(req, body, await getVisa());
      }
      writeResponse(res, upstream);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "sidecar_upstream_error", message: e.message }));
      } else {
        res.end();
      }
    }
  });

  return { server, getVisa };
}

export function startSidecar(opts) {
  const { gateway, port = 8788, host = "127.0.0.1" } = opts;
  const { server, getVisa } = createSidecar(opts);
  server.listen(port, host, () => {
    step(`PassControl visa sidecar forwarding to ${gateway}`);
    step(`Listening on http://${host}:${port}`);
    step(`Point your agent at: http://${host}:${port}/api/v1/anthropic (or /api/v1/openai)`);
    step("API key = anything (ignored). Visa is minted + refreshed automatically.\n");
    getVisa()
      .then(() => ok("visa warmed"))
      .catch((e) => fail(`could not mint initial visa: ${e.message}`));
  });
  return server;
}
