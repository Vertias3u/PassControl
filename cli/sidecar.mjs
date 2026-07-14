import http from "node:http";
import { Readable } from "node:stream";
import { fail, ok, step } from "./config.mjs";
import { createVisaClient } from "./visa-client.mjs";

const STRIP_REQ = new Set(["authorization", "x-api-key", "host", "content-length", "accept-encoding", "connection"]);
const STRIP_RES = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

export function createSidecar({ gateway, passportId, passportSecret, port = 8788, host = "127.0.0.1", refreshSkewSeconds = 30 }) {
  const visas = createVisaClient({
    gateway,
    passportId,
    passportSecret,
    refreshSkewSeconds,
    missingVisaMessage: "challenge returned no visa",
  });

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
      const upstream = await visas.fetchWithVisa((visa) => fetchUpstream(req, body, visa));
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

  return { server, getVisa: visas.getVisa };
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
