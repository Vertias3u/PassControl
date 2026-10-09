import { randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import { bareGatewayOrigin, fail, ok, step, warn } from "./config.mjs";
import { classifyConnect, classifyProxyRequest, isLoopbackBindHost } from "./proxy-policy.mjs";
import { createVisaClient } from "./visa-client.mjs";
import { declaredSession } from "./declared-session.mjs";
import { defaultJournalDir, openJournal } from "./journal.mjs";

// Hop-by-hop headers plus the ones the sidecar rebuilds itself. `proxy-connection`
// and friends only appear once something is used as a FORWARD proxy, which is
// what HTTP_PROXY/HTTPS_PROXY make this: they are addressed to the proxy and
// have no meaning upstream.
const STRIP_REQ = new Set([
  "authorization",
  "x-passcontrol-proof",
  "x-api-key",
  "host",
  "content-length",
  "accept-encoding",
  "connection",
  "proxy-connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
]);

// The set above is a denylist over header NAMES, and a denylist over names loses
// to spelling. A client that was previously configured with a raw provider key
// sends it as whatever its vendor chose: `x-api-key` (Anthropic), `api-key`
// (Azure style), `openai-api-key`, `x-goog-api-key`, or `proxy-authorization`.
// Only the first was named, so the rest reached the gateway verbatim. The
// gateway builds its upstream headers from scratch and never forwarded them on,
// so no key ever reached a provider — but it had no business leaving the user's
// machine at all, since not sending the key IS the sidecar.
const CREDENTIAL_HEADER = /(^|[-_])(api[-_]?key|authorization|auth|token|secret|credentials?)$/i;

function isStripped(name) {
  const key = name.toLowerCase();
  return STRIP_REQ.has(key) || CREDENTIAL_HEADER.test(key);
}
const STRIP_RES = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

const STATUS_TEXT = { 400: "Bad Request", 403: "Forbidden", 502: "Bad Gateway" };

/**
 * A header value is a single line of printable ASCII, always.
 *
 * The refusal text below interpolates a hostname the CLIENT chose. `proxy-policy`
 * already refuses a hostname containing whitespace or a delimiter, so this is the
 * second of two gates rather than the only one — but a header writer that can be
 * handed a newline is a response-splitting bug, and one that can be handed a
 * non-latin1 byte is a crash, so neither is left to the caller's good behaviour.
 */
function headerSafe(value) {
  return String(value ?? "").replace(/[^\x20-\x7e]/g, " ").slice(0, 512);
}

function refusalBody(verdict) {
  return JSON.stringify({ error: verdict.code, message: verdict.message, help: verdict.help });
}

/**
 * Refusals travel on five channels because clients surface wildly different
 * subsets of them: a status code, a machine-readable code header, a one-line fix
 * header, a JSON body for `curl -v`, and a line on the sidecar's own console.
 * A CONNECT client typically shows only the status, so the console line is the
 * one an operator can always read.
 */
function refusalHeaders(verdict) {
  return {
    "content-type": "application/json",
    "x-passcontrol-refusal": headerSafe(verdict.code),
    "x-passcontrol-help": headerSafe(verdict.help),
    connection: "close",
  };
}

function writeRefusal(res, verdict) {
  const body = refusalBody(verdict);
  res.writeHead(verdict.status, { ...refusalHeaders(verdict), "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/** The same refusal, hand-rolled: a CONNECT is answered on the raw socket. */
function writeConnectRefusal(socket, verdict) {
  if (socket.destroyed) return;
  const body = refusalBody(verdict);
  const head = [
    `HTTP/1.1 ${verdict.status} ${STATUS_TEXT[verdict.status] ?? "Error"}`,
    ...Object.entries({ ...refusalHeaders(verdict), "content-length": Buffer.byteLength(body) }).map(
      ([k, v]) => `${k}: ${v}`
    ),
    "",
    "",
  ].join("\r\n");
  socket.end(head + body);
}

export function createSidecar({
  gateway,
  passportId,
  passportSecret,
  keyStorage = null,
  port = 8788,
  host = "127.0.0.1",
  refreshSkewSeconds = 30,
  allowConnectHosts = [],
  onRefusal = (verdict) => warn(`${verdict.code}: ${verdict.message} → ${verdict.help}`),
  // This run's id: stamped on every forwarded request as `x-passcontrol-run`, the
  // fallback session for a client that declares none (lib/client-lineage.ts).
  runId = randomUUID(),
  // cli/journal.mjs, or null for `--no-journal`.
  journal = null,
}) {
  // The upstream URL below is built from this, not from the argument: the
  // sidecar forwards a bearer visa on every proxied request, so its destination
  // is part of the credential's security rather than a formatting detail.
  const origin = bareGatewayOrigin(gateway);
  const visas = createVisaClient({
    gateway: origin,
    passportId,
    passportSecret,
    keyStorage,
    refreshSkewSeconds,
    missingVisaMessage: "challenge returned no visa",
  });

  // Used only to print the governed base URL back in a refusal. Read from the
  // live listener when there is one so the advice names the port actually bound.
  const localBaseUrl = () => {
    const address = server?.listening ? server.address() : null;
    return `http://${host}:${address?.port ?? port}`;
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(chunks.length ? Buffer.concat(chunks) : undefined));
      req.on("error", reject);
    });
  }

  async function fetchUpstream(req, path, body, visa) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!isStripped(k) && typeof v === "string") headers[k] = v;
    }
    headers["authorization"] = `Bearer ${visa}`;
    // Set after the copy, so a client cannot name the run: only the sidecar can.
    headers["x-passcontrol-run"] = runId;
    headers["x-passcontrol-proof"] = visas.createProof(visa, req.method, new URL(path, origin));
    headers["accept-encoding"] = "identity";
    return fetch(`${origin}${path}`, { method: req.method, headers, body: body ?? undefined });
  }

  // A service call's pagination `link` and same-origin `location` name the
  // GATEWAY (it builds them from its own origin), and following one directly
  // would skip the visa only this sidecar adds. Point them back at the sidecar.
  // Only the exact gateway origin followed by /api/v1/ is rewritten; any other
  // URL — codeload for an archive download — passes through untouched.
  const toLocal = (value) => value.split(`${origin}/api/v1/`).join(`${localBaseUrl()}/api/v1/`);

  function writeResponse(res, upstream, reqHeaders) {
    // At the headers, not at the end of the body: a streamed call whose client
    // disconnects mid-stream still produced a receipt, and the user's record of
    // it must not depend on how long they kept reading. With the session the call
    // declared, read as the gateway reads it, so a seal is checked against its own.
    journal?.record(
      upstream.headers.get("x-passcontrol-receipt-id"),
      upstream.status,
      declaredSession((name) => {
        const v = reqHeaders?.[name];
        return Array.isArray(v) ? v[0] : v;
      }, runId)
    );
    const outHeaders = {};
    upstream.headers.forEach((v, k) => {
      const name = k.toLowerCase();
      if (STRIP_RES.has(name)) return;
      outHeaders[k] = name === "link" || name === "location" ? toLocal(v) : v;
    });
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
  }

  const server = http.createServer(async (req, res) => {
    // Judge the destination before reading the body: a refused host should not
    // get to make the sidecar buffer megabytes on its way to a 403.
    const verdict = classifyProxyRequest({ url: req.url, gatewayOrigin: origin, localBaseUrl: localBaseUrl() });
    if (!verdict.allow) {
      req.resume();
      onRefusal(verdict);
      writeRefusal(res, verdict);
      return;
    }

    try {
      const body = await readBody(req);
      const upstream = await visas.fetchWithVisa((visa) => fetchUpstream(req, verdict.path, body, visa));
      writeResponse(res, upstream, req.headers);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "sidecar_upstream_error", message: e.message }));
      } else {
        res.end();
      }
    }
  });

  // ── The Ollama listener (1.3.0 #3) ────────────────────────────────────────
  //
  // For apps that only take OLLAMA_HOST, which is host:port with no path. Every
  // request on this port is the gateway's `local` provider: `/api/chat` becomes
  // `/api/v1/local/api/chat`, and the OpenAI-compatible `/v1/...` paths map the
  // same way. Its own port, so the main listener's forward-proxy handling is
  // untouched; an absolute-form request (a proxy request for another host) is
  // refused here rather than becoming a governed local call.
  //
  // The path is normalised by the URL parser BEFORE the prefix is added, so a
  // `..` segment (encoded or not) resolves inside it and cannot carry the visa
  // to another gateway route. The health probe (`/`, which the ollama CLI HEADs)
  // is not answered here: it goes to the gateway as `/api/version`, so an app
  // sees the gateway's real answer, including a refusal where `local` is off.
  const ollamaServer = http.createServer(async (req, res) => {
    if (!String(req.url ?? "").startsWith("/")) {
      req.resume();
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "ollama_listener_absolute_form", message: "This port serves Ollama's API for the local provider only; it is not a proxy." }));
      return;
    }
    const url = new URL(req.url, "http://ollama.invalid");
    const probe = url.pathname === "/";
    const mapped = `/api/v1/local${probe ? "/api/version" : url.pathname}${probe ? "" : url.search}`;
    const method = probe ? "GET" : req.method;
    try {
      const body = probe ? null : await readBody(req);
      if (probe) req.resume();
      const upstream = await visas.fetchWithVisa((visa) => fetchUpstream({ method, headers: req.headers }, mapped, body, visa));
      if (req.method === "HEAD") {
        res.writeHead(upstream.status);
        res.end();
        await upstream.body?.cancel().catch(() => {});
        return;
      }
      writeResponse(res, upstream, req.headers);
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "sidecar_upstream_error", message: e.message }));
      } else {
        res.end();
      }
    }
  });

  // `CONNECT host:port` — what every client with HTTPS_PROXY set sends first.
  // PassControl cannot govern what it cannot read, and it deliberately does not
  // terminate TLS to make it readable, so a provider target is refused here
  // rather than tunnelled into a call that is ungoverned while looking governed.
  server.on("connect", (req, clientSocket, head) => {
    clientSocket.on("error", () => {});

    const verdict = classifyConnect({
      target: req.url,
      gatewayOrigin: origin,
      allowHosts: allowConnectHosts,
      localBaseUrl: localBaseUrl(),
    });
    if (!verdict.allow) {
      onRefusal(verdict);
      writeConnectRefusal(clientSocket, verdict);
      return;
    }

    let established = false;
    const upstream = net.connect(verdict.port, verdict.hostname, () => {
      established = true;
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => {
      if (established) {
        clientSocket.destroy();
        return;
      }
      writeConnectRefusal(clientSocket, {
        status: 502,
        code: "tunnel_unreachable",
        message: `PassControl could not open a tunnel to ${verdict.hostname}.`,
        help: "Check that the host is reachable from this machine.",
      });
    });
    clientSocket.on("close", () => upstream.destroy());
  });

  return { server, ollamaServer, getVisa: visas.getVisa, runId };
}

/**
 * Bind guard.
 *
 * The sidecar holds the passport and mints a visa for whoever connects, so a
 * listener reachable off-host hands the agent's scope and budget to anyone who
 * can route to it. Loopback is the default and a non-loopback bind is an
 * explicit, named opt-in rather than a config value that quietly widens it.
 */
export function assertBindHost(host, allowNonLoopback = false) {
  if (isLoopbackBindHost(host) || allowNonLoopback) return host;
  throw new Error(
    `Refusing to bind the sidecar to ${host}: it is not a loopback address. The sidecar mints work-visas for ` +
      "anything that connects to it, so a non-loopback bind exposes your agent's scope and budget to the " +
      "network. Pass allowNonLoopback only if the listener is protected by something else."
  );
}

export function startSidecar(opts) {
  const { gateway, port = 8788, host = "127.0.0.1", allowNonLoopback = false, allowConnectHosts = [], ollamaPort = null } = opts;
  assertBindHost(host, allowNonLoopback);
  const runId = randomUUID();
  // On unless the operator said --no-journal (D3). See cli/journal.mjs.
  const journal = opts.noJournal
    ? null
    : openJournal({
        dir: opts.journalDir ?? defaultJournalDir(),
        runId,
        onError: (e) =>
          warn(`journal: could not write ${journal.path} (${e.message}). Calls are unaffected; this run is no longer being recorded.`),
      });
  const { server, ollamaServer, getVisa } = createSidecar({ ...opts, runId, journal });
  if (ollamaPort != null) {
    ollamaServer.listen(ollamaPort, host, () => {
      step(`Ollama API (local models) on http://${host}:${ollamaPort}: set OLLAMA_HOST=${host}:${ollamaPort}`);
    });
  }
  server.listen(port, host, () => {
    step(`PassControl visa sidecar forwarding to ${gateway}`);
    step(`Listening on http://${host}:${port}`);
    step(`Point your agent at: http://${host}:${port}/api/v1/anthropic (or /api/v1/openai)`);
    step("API key = anything (ignored). Visa is minted + refreshed automatically.");
    step(
      journal
        ? `Journal: ${journal.path} (receipt ids, times, statuses and declared sessions only; --no-journal turns it off)`
        : "Journal: off (--no-journal). Session seals cannot be checked against this run."
    );
    // Said at startup rather than only in a refusal, because the whole point of
    // HTTPS_PROXY is that nobody reads the docs first.
    step("HTTPS_PROXY: CONNECT to a provider is refused, not tunnelled — PassControl cannot");
    step("govern TLS it does not terminate, and does not install an intercepting CA.");
    // Always printed, including when empty. An egress exception the operator
    // cannot see is one they cannot audit, and this list is exactly the thing a
    // checked-in config file used to be able to extend without saying so.
    step(
      allowConnectHosts.length
        ? `CONNECT allowlist: ${allowConnectHosts.join(", ")} (provider hosts are never eligible).\n`
        : "CONNECT allowlist: none — only the gateway.\n"
    );
    getVisa()
      .then(() => ok("visa warmed"))
      .catch((e) => fail(`could not mint initial visa: ${e.message}`));
  });
  return server;
}
