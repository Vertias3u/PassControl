import { randomUUID } from "node:crypto";
import http from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import { bareGatewayOrigin, fail, ok, step, warn } from "./config.mjs";
import { classifyConnect, classifyProxyRequest, isLoopbackBindHost } from "./proxy-policy.mjs";
import { createVisaClient } from "./visa-client.mjs";
import { declaredLineage, declaredSession } from "./declared-session.mjs";
import { defaultJournalDir, openJournal } from "./journal.mjs";
import { answer, createWatchFeed, isNotACall, isLocalCaller, LOCAL_PREFIX, peekText, providerOf, refusalCode, requestModel } from "./watch-feed.mjs";
import { createStopGate, HOOK_PATH, SELF_READ_TIMEOUT_MS, selfAnswerState } from "./subscription-gate.mjs";
import { createToolGate } from "./tool-gate.mjs";
import { OTLP_LOGS_PATH, readClaudeCodeEvents } from "./otlp-logs.mjs";
import { CLIENT_EVENTS_PATH, CLIENT_EVENTS_SOURCE, createCallUploader } from "./client-events-upload.mjs";
import { heldUsageWindow, WINDOW_PATH } from "./usage-window.mjs";

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
// An OTLP log export batches every event of a few seconds; Claude Code's run ~30 KB.
const OTLP_BODY_LIMIT = 4 * 1024 * 1024;
// Sessions whose calls this sidecar relays, remembered so their telemetry is not
// counted a second time. Bounded: the oldest is forgotten first.
const RELAYED_SESSIONS_MAX = 1000;

// Claude Code's hook input carries the tool's input (a whole file for Write), so it
// is not small; past this it is refused rather than buffered.
const HOOK_BODY_LIMIT = 1024 * 1024;

// How long Claude Code waits for the hook, as configure wrote it into the URL
// (`?t=600`); null for a hook that does not say (a Phase 1 install).
function hookTimeoutS(url) {
  const t = new URL(url ?? "/", "http://127.0.0.1").searchParams.get("t");
  return t !== null && /^\d{1,4}$/.test(t) && Number(t) > 0 ? Number(t) : null;
}
// The agent's opt-in note (1.6.0): `?note=1` on subscription mode's prompt hook,
// `?note=only` on API mode's, which only ever adds the note.
function hookNote(url) {
  const note = new URL(url ?? "/", "http://127.0.0.1").searchParams.get("note");
  return note === "1" ? "subscription" : note === "only" ? "api" : null;
}
// A usage window is two numbers and two times.
const WINDOW_BODY_LIMIT = 4 * 1024;

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
  // `passcontrol watch`'s feed (cli/watch-feed.mjs). Off when bound off loopback.
  watchFeed = isLoopbackBindHost(host),
  watchCapacity = 200,
  watchMaxSubscribers = 8,
  // Subscription mode, Phase 1b: upload the calls Claude Code reports to the
  // gateway's agent page (cli/client-events-upload.mjs). `--no-report-calls` turns it off.
  reportCalls = true,
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
  const feed = createWatchFeed({ runId, capacity: watchCapacity, maxSubscribers: watchMaxSubscribers, enabled: watchFeed });
  const lineageOf = (headers) =>
    declaredLineage((name) => {
      const v = headers?.[name];
      return Array.isArray(v) ? v[0] : v;
    }, runId);

  // Subscription mode's Stop (cli/subscription-gate.mjs): Claude Code's hooks ask
  // here, and the answer comes from the gateway's /api/v1/self, read with this
  // sidecar's visa and the session the hook names.
  async function readSelf(session) {
    // One deadline over the whole read, a visa mint included: past the hook's own
    // timeout the action goes ahead with no warning. A mint cut short here is not
    // aborted (the proxy shares it); it finishes and is cached for the next read.
    const signal = AbortSignal.timeout(SELF_READ_TIMEOUT_MS);
    const deadline = new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    deadline.catch(() => {});
    try {
      const response = await Promise.race([deadline, visas.fetchWithVisa((visa) => {
        // The tool rules ride on every gate read (Phase 2): no call of their own.
        const path = "/api/v1/self?include=tool_rules";
        const headers = {
          accept: "application/json",
          authorization: `Bearer ${visa}`,
          "x-passcontrol-run": runId,
          "x-passcontrol-proof": visas.createProof(visa, "GET", new URL(path, origin)),
          "accept-encoding": "identity",
        };
        if (session) headers["x-claude-code-session-id"] = session;
        return fetch(`${origin}${path}`, { headers, signal });
      })]);
      return await Promise.race([deadline, selfAnswerState(response)]);
    } catch (error) {
      return { state: "unknown", reason: error?.name === "TimeoutError" ? "the gateway did not answer in time" : (error?.message ?? "error") };
    }
  }
  const stopGate = createStopGate({ readSelf, dashboardUrl: `${origin}/dashboard` });

  // Phase 2's `ask_owner` tool rules: the gateway asks the owner (their alert
  // destination is in its Vault) and holds each request a few seconds; this asks
  // again until the owner answers or the tool gate's wait runs out.
  const TOOL_APPROVALS_PATH = "/api/v1/tool-approvals";
  const APPROVAL_REQUEST_TIMEOUT_MS = 25_000;
  const APPROVAL_RETRY_MS = 1_000;
  async function askOwner(input, { session, waitMs }) {
    const deadline = Date.now() + waitMs;
    const body = JSON.stringify({ session: session ?? undefined, tool_name: input.tool_name, tool_input: input.tool_input, cwd: input.cwd });
    while (Date.now() < deadline - 500) {
      let response;
      try {
        response = await visas.fetchWithVisa((visa) => {
          const headers = {
            "content-type": "application/json",
            authorization: `Bearer ${visa}`,
            "x-passcontrol-run": runId,
            "x-passcontrol-proof": visas.createProof(visa, "POST", new URL(TOOL_APPROVALS_PATH, origin)),
            "accept-encoding": "identity",
          };
          if (session) headers["x-claude-code-session-id"] = session;
          return fetch(`${origin}${TOOL_APPROVALS_PATH}`, {
            method: "POST",
            headers,
            body,
            signal: AbortSignal.timeout(Math.min(APPROVAL_REQUEST_TIMEOUT_MS, Math.max(1_000, deadline - Date.now()))),
          });
        });
      } catch {
        // The gateway did not answer this round: ask again while there is time.
        await new Promise((resolve) => setTimeout(resolve, Math.min(APPROVAL_RETRY_MS, Math.max(0, deadline - Date.now()))));
        continue;
      }
      const answered = await response.json().catch(() => ({}));
      if (response.status === 409) return { state: "refused" };
      if (response.status === 413) return { state: "too_large" };
      if (response.status !== 200) return { state: "unavailable" };
      if (["approved", "denied", "full"].includes(answered?.state)) return { state: answered.state };
      if (answered?.state !== "pending") return { state: "unavailable" };
    }
    return { state: "timeout" };
  }

  // The reported calls go to the gateway as this agent, straight from here: never
  // through this sidecar's own listener, so they are never a call on the board.
  const UPLOAD_TIMEOUT_MS = 10_000;
  async function sendReportedCalls(events) {
    const response = await visas.fetchWithVisa((visa) =>
      fetch(`${origin}${CLIENT_EVENTS_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${visa}`,
          "x-passcontrol-run": runId,
          "x-passcontrol-proof": visas.createProof(visa, "POST", new URL(CLIENT_EVENTS_PATH, origin)),
          "accept-encoding": "identity",
        },
        body: JSON.stringify({ source: CLIENT_EVENTS_SOURCE, events }),
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      })
    );
    const body = await response.json().catch(() => ({}));
    return { status: response.status, error: body?.error, retryAfterS: Number(response.headers.get("retry-after")) };
  }
  const uploader = reportCalls ? createCallUploader({ send: sendReportedCalls }) : null;
  // Its decisions reach the agent's page with the reported calls (same opt-out).
  const toolGate = createToolGate({
    askOwner,
    dashboardUrl: `${origin}/dashboard`,
    onDecision: (record) => uploader?.add({ kind: "tool_decision", at: Date.now(), ...record }),
  });

  const relayedSessions = new Set();
  function rememberRelayed(headers) {
    const session = lineageOf(headers)?.session;
    if (!session || relayedSessions.has(session)) return;
    relayedSessions.add(session);
    if (relayedSessions.size > RELAYED_SESSIONS_MAX) relayedSessions.delete(relayedSessions.values().next().value);
  }

  /** Reads a local caller's body up to `limit`; resolves null when it is over. */
  function readLocalBody(req, limit) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let over = false;
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) over = true;
        else chunks.push(c);
      });
      req.on("end", () => resolve(over ? null : Buffer.concat(chunks)));
      req.on("error", () => resolve(null));
    });
  }

  // Subscription mode's telemetry (cli/otlp-logs.mjs): Claude Code's log exporter
  // posts here. Answered as an OTLP collector does, `{}` on success.
  async function serveOtlpLogs(req, res) {
    const port = server.address()?.port;
    if (req.method !== "POST") {
      req.resume();
      return answer(res, 405, "method_not_allowed", "The telemetry endpoint answers POST only.");
    }
    if (!isLocalCaller(req, port)) {
      req.resume();
      return answer(res, 403, "telemetry_refused", "The telemetry endpoint is for Claude Code on this machine only.");
    }
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      req.resume();
      return answer(res, 415, "telemetry_protocol", "Send OTLP as JSON: set OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json.");
    }
    const raw = await readLocalBody(req, OTLP_BODY_LIMIT);
    if (raw === null) return answer(res, 413, "telemetry_too_large", "Log export over 4 MB.");
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return answer(res, 400, "telemetry_not_json", "The log export is not JSON.");
    }
    for (const event of readClaudeCodeEvents(body)) {
      if (event.session && relayedSessions.has(event.session)) continue;
      feed.report({
        at: event.at ?? Date.now(),
        lineage: { session: event.session, agent: event.agent },
        model: event.model,
        provider: "anthropic",
        outcome: event.kind === "api_request" ? "seen" : "error",
        status: event.status,
        ms: event.durationMs,
        cost: event.costMicros,
      });
      uploader?.add(event);
    }
    res.writeHead(200, { "content-type": "application/json", "content-length": 2, "cache-control": "no-store" });
    res.end("{}");
  }

  // Subscription mode's usage window (cli/usage-window.mjs): the status line posts
  // what Claude Code told it; `watch` gets it on the feed, `/passcontrol` asks for it.
  async function serveWindow(req, res) {
    const port = server.address()?.port;
    if (req.method !== "GET" && req.method !== "POST") {
      req.resume();
      return answer(res, 405, "method_not_allowed", "The usage-window endpoint answers GET and POST only.");
    }
    if (!isLocalCaller(req, port)) {
      req.resume();
      return answer(res, 403, "window_refused", "The usage-window endpoint is for this machine only.");
    }
    if (req.method === "GET") {
      req.resume();
      const current = feed.window();
      if (!current) return answer(res, 404, "window_unknown", "No usage window reported yet.");
      const body = JSON.stringify({ fiveHour: current.fiveHour, sevenDay: current.sevenDay, at: current.at });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
      return res.end(body);
    }
    const raw = await readLocalBody(req, WINDOW_BODY_LIMIT);
    let window = null;
    try {
      window = raw === null ? null : heldUsageWindow(JSON.parse(raw.toString("utf8")));
    } catch {
      window = null;
    }
    if (!window) return answer(res, 400, "window_invalid", "Expected a usage window: { fiveHour, sevenDay }.");
    feed.setWindow(window);
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
  }

  function serveHook(req, res) {
    const port = server.address()?.port;
    if (req.method !== "POST") {
      req.resume();
      return answer(res, 405, "method_not_allowed", "The hook endpoint answers POST only.");
    }
    if (!isLocalCaller(req, port)) {
      req.resume();
      return answer(res, 403, "hook_refused", "The hook endpoint is for Claude Code on this machine only.");
    }
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > HOOK_BODY_LIMIT) tooBig = true;
      else chunks.push(c);
    });
    req.on("end", async () => {
      if (tooBig) return answer(res, 413, "hook_too_large", "Hook input over 1 MB.");
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        input = null;
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        return answer(res, 400, "hook_not_json", "Expected Claude Code's hook input, a JSON object.");
      }
      let out;
      try {
        out = await stopGate.decide(input, { note: hookNote(req.url) });
      } catch {
        out = {};
      }
      // A stop ends the turn whatever the tool rules say; otherwise a PreToolUse is
      // the tool gate's, which needs to know how long Claude Code waits for this hook.
      if (out.continue !== false && input.hook_event_name === "PreToolUse") {
        let tool;
        try {
          tool = await toolGate.decide(input, stopGate.toolRules(), hookTimeoutS(req.url));
        } catch {
          tool = {};
        }
        const messages = [out.systemMessage, tool.systemMessage].filter(Boolean);
        out = { ...tool, ...(messages.length ? { systemMessage: messages.join("\n") } : {}) };
      }
      const body = JSON.stringify(out);
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
      res.end(body);
    });
    req.on("error", () => res.destroy());
  }

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

  // `watch` is the board's handle on this call ({ call, startedAt }), or null for one
  // the board does not show. Its outcome is read from the status and, for an error,
  // from a capped peek at a CLONE of the body, so the client's bytes are untouched
  // and nothing here waits on the peek.
  function writeResponse(res, upstream, reqHeaders, watch = null) {
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
    let peek = null;
    if (watch) {
      const ttfb = Date.now() - watch.startedAt;
      const status = upstream.status;
      res.on("close", () => watch.call.finish());
      if (status < 400) watch.call.settle({ outcome: "boarded", status, ttfb });
      else if (!upstream.body) watch.call.settle({ outcome: "error", status, ttfb });
      else {
        try {
          peek = upstream.clone().body;
        } catch {
          watch.call.settle({ outcome: "error", status, ttfb });
        }
        if (peek) {
          peekText(peek).then((text) => {
            const code = refusalCode(text);
            watch.call.settle({ outcome: code ? "denied" : "error", code, status, ttfb });
          });
        }
      }
    }
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
  }

  /** Begins the board's record of a forwarded call, unless it is not a call (the budget read, an upload). */
  function watchCall(req, path, body, startedAt) {
    if (isNotACall(path)) return null;
    rememberRelayed(req.headers);
    try {
      return { startedAt, call: feed.begin({ startedAt, lineage: lineageOf(req.headers), model: requestModel(body), provider: providerOf(path) }) };
    } catch {
      return null;
    }
  }

  /** A forwarded call that failed before the gateway answered: shown, then answered 502. */
  function upstreamFailed(res, watch, req, path, e) {
    if (!res.headersSent) {
      if (watch) {
        watch.call.settle({ outcome: "error", code: "sidecar_upstream_error", status: 502 });
        watch.call.finish();
      } else if (!isNotACall(path)) {
        feed.record({ outcome: "error", code: "sidecar_upstream_error", status: 502, lineage: lineageOf(req.headers), provider: providerOf(path) });
      }
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "sidecar_upstream_error", message: e.message }));
    } else {
      res.end();
    }
  }

  const server = http.createServer(async (req, res) => {
    // The sidecar's own paths: answered here, never forwarded with a visa.
    if (String(req.url ?? "").startsWith(LOCAL_PREFIX)) {
      const localPath = String(req.url).split("?")[0];
      if (localPath === HOOK_PATH) return serveHook(req, res);
      if (localPath === OTLP_LOGS_PATH) return serveOtlpLogs(req, res);
      if (localPath === WINDOW_PATH) return serveWindow(req, res);
      feed.serve(req, res, { port: server.address()?.port });
      return;
    }
    const startedAt = Date.now();
    // Judge the destination before reading the body: a refused host should not
    // get to make the sidecar buffer megabytes on its way to a 403.
    const verdict = classifyProxyRequest({ url: req.url, gatewayOrigin: origin, localBaseUrl: localBaseUrl() });
    if (!verdict.allow) {
      req.resume();
      onRefusal(verdict);
      feed.record({ outcome: "denied", code: verdict.code, status: verdict.status, lineage: lineageOf(req.headers), startedAt });
      writeRefusal(res, verdict);
      return;
    }

    let watch = null;
    try {
      const body = await readBody(req);
      watch = watchCall(req, verdict.path, body, startedAt);
      const upstream = await visas.fetchWithVisa((visa) => fetchUpstream(req, verdict.path, body, visa));
      writeResponse(res, upstream, req.headers, watch);
    } catch (e) {
      upstreamFailed(res, watch, req, verdict.path, e);
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
    const startedAt = Date.now();
    let watch = null;
    try {
      const body = probe ? null : await readBody(req);
      if (probe) req.resume();
      watch = watchCall(req, mapped, body, startedAt);
      const upstream = await visas.fetchWithVisa((visa) => fetchUpstream({ method, headers: req.headers }, mapped, body, visa));
      if (req.method === "HEAD") {
        watch?.call.settle({ outcome: upstream.status < 400 ? "boarded" : "error", status: upstream.status, ttfb: Date.now() - startedAt });
        watch?.call.finish();
        res.writeHead(upstream.status);
        res.end();
        await upstream.body?.cancel().catch(() => {});
        return;
      }
      writeResponse(res, upstream, req.headers, watch);
    } catch (e) {
      upstreamFailed(res, watch, req, mapped, e);
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
      feed.record({ outcome: "denied", code: verdict.code, status: verdict.status, lineage: lineageOf(req.headers) });
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
      feed.record({ outcome: "error", code: "tunnel_unreachable", status: 502, lineage: lineageOf(req.headers) });
      writeConnectRefusal(clientSocket, {
        status: 502,
        code: "tunnel_unreachable",
        message: `PassControl could not open a tunnel to ${verdict.hostname}.`,
        help: "Check that the host is reachable from this machine.",
      });
    });
    clientSocket.on("close", () => upstream.destroy());
  });

  server.on("close", () => uploader?.close());
  return { server, ollamaServer, getVisa: visas.getVisa, runId, feed, uploader };
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
  const { server, ollamaServer, getVisa, feed } = createSidecar({ ...opts, runId, journal });
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
    step(
      isLoopbackBindHost(host)
        ? `Watch live: passcontrol watch --port ${port} (this machine only; held in memory, never written)`
        : "Watch: off, because this sidecar is bound off loopback."
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
    warmVisa({
      getVisa,
      gateway,
      // Closed rather than process.exit(): stderr to a pipe is written
      // asynchronously, and exit() can drop the reason this just printed.
      onRefused: () => {
        process.exitCode = 1;
        // A watching board holds its connection open, and close() waits for it.
        feed.close();
        server.close();
        if (ollamaServer.listening) ollamaServer.close();
        setTimeout(() => process.exit(1), 1000).unref();
      },
    });
  });
  return server;
}

/** Waits between attempts to mint the first visa: backoff, then every 30 seconds. */
export const WARM_RETRY_MS = [1000, 2000, 4000, 8000, 15000, 30000];

/**
 * A gateway that answered and refused the passport: any 4xx except 408 and 429,
 * which mean "not now". No status (no connection) and 5xx mean "not up yet".
 */
export function isPassportRefusal(error) {
  const status = error?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * The first visa (sprint T2). A sidecar is often started before its gateway, by
 * `passcontrol start` or a login script, so a gateway that is not answering is
 * waited for, on screen; a refusal ends the process, because retrying it can only
 * fail again and a sidecar that cannot mint must not look like it is running.
 * Resolves true once warmed, false after a refusal (onRefused has run).
 */
export async function warmVisa({
  getVisa,
  gateway,
  onRefused,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = { ok, warn, fail },
  delays = WARM_RETRY_MS,
}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await getVisa();
      log.ok(attempt === 0 ? "visa warmed" : `visa warmed: ${gateway} is answering now`);
      return true;
    } catch (error) {
      if (isPassportRefusal(error)) {
        log.fail(`could not mint a visa: ${error.message}`);
        onRefused(error);
        return false;
      }
      const delay = delays[Math.min(attempt, delays.length - 1)];
      if (attempt === 0) {
        log.warn(
          `${gateway} is not answering yet (${error.message}). Waiting for it, and retrying on its own; ` +
            "calls made before it answers get a 502."
        );
      } else if (attempt % 10 === 0) {
        log.warn(`still waiting for ${gateway} (${error.message})`);
      }
      await sleep(delay);
    }
  }
}
