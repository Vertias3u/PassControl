// PassControl VISA SIDECAR — make PassControl drop-in for ANY agent that expects a
// static API key (OpenHands, Aider, Cline, Continue, …), not just ones using our SDK.
//
// It's a tiny local reverse proxy: it holds your passport, mints + refreshes a
// work-visa in the background, and injects it into every request it forwards to the
// gateway — stripping whatever placeholder key the agent sent. To the agent it looks
// like a normal LLM endpoint with a never-expiring key; the real key never leaves the
// gateway's vault and the visa is refreshed for you.
//
// Run:
//   PASSPORT_ID=<pubkey> PASSPORT_SECRET=<privkey> node examples/visa-sidecar.mjs
//   (or: PASSPORT_ID=… PASSPORT_SECRET=… npm run sidecar)
//
// Then point your agent at the sidecar EXACTLY as you'd point it at the gateway,
// e.g. base URL http://localhost:8788/api/v1/anthropic  (or .../api/v1/openai),
// API key = anything (it's ignored/replaced). The sidecar forwards the same path to
// the gateway with a fresh visa.
//
// Env: PASSCONTROL_GATEWAY (default http://localhost:3000) · SIDECAR_PORT (8788) ·
//      REFRESH_SKEW_SECONDS (30) · SIDECAR_HOST (127.0.0.1).
import http from "node:http";
import { Readable } from "node:stream";
import { ed25519 } from "@noble/curves/ed25519";

const GATEWAY = (process.env.PASSCONTROL_GATEWAY ?? "http://localhost:3000").replace(/\/+$/, "");
const PORT = Number(process.env.SIDECAR_PORT ?? 8788);
const HOST = process.env.SIDECAR_HOST ?? "127.0.0.1";
const SKEW_MS = Math.max(0, Number(process.env.REFRESH_SKEW_SECONDS ?? 30) * 1000);
const PASSPORT_ID = process.env.PASSPORT_ID;
const PASSPORT_SECRET = process.env.PASSPORT_SECRET;

if (!PASSPORT_ID || !PASSPORT_SECRET) {
  console.error("Set PASSPORT_ID and PASSPORT_SECRET (base64url Ed25519 public/private key).");
  process.exit(1);
}

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));

// ── Visa lifecycle: cache + refresh-before-expiry + single-flight ─────────────
let cached = null; // { token, expiresAt }
let inflight = null;

async function mint() {
  const obj = { passport_id: PASSPORT_ID, ts: Date.now(), nonce: crypto.randomUUID() };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const signature = b64url(ed25519.sign(fromB64url(payload), fromB64url(PASSPORT_SECRET)));
  const res = await fetch(`${GATEWAY}/api/auth/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, signature }),
  });
  if (!res.ok) throw new Error(`challenge failed: ${res.status} ${await res.text()}`);
  const { visa, expires_in } = await res.json();
  if (!visa) throw new Error("challenge returned no visa");
  return { token: visa, expiresAt: Date.now() + (expires_in ?? 300) * 1000 };
}

async function getVisa() {
  if (cached && Date.now() < cached.expiresAt - SKEW_MS) return cached.token;
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

// ── Read an incoming Node request body into a Buffer (LLM bodies are small) ────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
    req.on("error", reject);
  });
}

// Headers we must not forward verbatim (auth is replaced; hop-by-hop/encoding dropped).
const STRIP_REQ = new Set(["authorization", "x-api-key", "host", "content-length", "accept-encoding", "connection"]);
const STRIP_RES = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

// Fetch the gateway with a fresh visa injected. Does NOT touch the client response,
// so the caller can inspect the status and retry before any bytes are streamed back.
// `body` is a Buffer (re-readable), so a retry can reuse it.
async function fetchUpstream(req, body, visa) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIP_REQ.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
  }
  headers["authorization"] = `Bearer ${visa}`;
  headers["accept-encoding"] = "identity"; // avoid compression so we can stream cleanly
  return fetch(`${GATEWAY}${req.url}`, { method: req.method, headers, body: body ?? undefined });
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
    // Visa rejected (expired/revoked mid-flight)? Re-mint once and retry BEFORE we've
    // written anything back to the agent.
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

server.listen(PORT, HOST, () => {
  console.log(`PassControl visa sidecar → forwarding to ${GATEWAY}`);
  console.log(`Listening on http://${HOST}:${PORT}`);
  console.log(`Point your agent at:  http://${HOST}:${PORT}/api/v1/anthropic   (or /api/v1/openai)`);
  console.log(`API key = anything (ignored). Visa is minted + refreshed automatically.\n`);
  // Warm the visa cache so the first agent request isn't slowed by a mint.
  getVisa()
    .then(() => console.log("✓ visa warmed"))
    .catch((e) => console.error("⚠ could not mint initial visa:", e.message));
});
