// The sidecar's live feed for `passcontrol watch` (F6): one event per call it relays,
// served on the sidecar's own loopback listener and kept in memory only.
//
// What it carries is what the board shows and nothing else: when, the declared
// session and sub-agent, the model id, the provider, BOARDED / DENIED / ERROR with
// the gateway's refusal CODE (never its message), the status, and the latency. No
// prompt, no response, no message text, no path beyond the provider's name. Nothing
// is written to disk: the journal (cli/journal.mjs) stays receipt ids only, as D3
// promised, and this ring buffer dies with the process.
//
// Who may read it. The sidecar holds a passport, so it is already bound to loopback
// by `assertBindHost`; the feed adds the checks a browser would otherwise get around:
//   * GET only, from a loopback peer;
//   * a Host header naming this loopback listener and port exactly, so a page that
//     rebinds its own hostname to 127.0.0.1 is refused (DNS rebinding);
//   * no Origin header, which a browser sends on a cross-origin request;
//   * no CORS grant, ever.
// A sidecar bound off loopback (`allowNonLoopback`) serves no feed at all.
//
// It must never slow or break a call: every write is guarded, a subscriber that
// cannot keep up is dropped rather than buffered for, and nothing on the proxy
// path waits on a subscriber.

export const WATCH_PATH = "/_passcontrol/watch";
/** Paths under this prefix are the sidecar's own and are never forwarded. */
export const LOCAL_PREFIX = "/_passcontrol/";

const DECLARED = /^[A-Za-z0-9._:-]{1,128}$/;
// A model id as the providers and routers spell them: claude-opus-5-5,
// gpt-5.1-codex, openrouter/anthropic/claude-sonnet-5.5, qwen3:8b, meta-llama/Llama-3@q4.
const MODEL = /^[A-Za-z0-9._:/@-]{1,100}$/;
// The gateway's refusal codes are lower-case snake case (`errR(status, code)`).
const CODE = /^[a-z][a-z0-9_]{1,47}$/;
const PROVIDER = /^[a-z0-9-]{1,32}$/;

/**
 * Bodies larger than this are not parsed for their model: the row shows none. The
 * sidecar already holds the whole body to forward it; parsing it costs about 0.6 ms
 * at 500 KB and 4.5 ms at this cap (measured 2026-10-11, M-series Mac), against a
 * model call that takes seconds.
 */
const MODEL_PARSE_LIMIT = 4 * 1024 * 1024;
/** How much of an error body is read to find a refusal code. */
const REFUSAL_PEEK_BYTES = 8 * 1024;
/**
 * A subscriber with more than this queued and unsent is dropped. Bytes, not
 * write()'s return value: the replay alone passes the socket's 16 KB high-water
 * mark, and a board that is merely starting up is not a board that cannot keep up.
 */
const MAX_BUFFERED_BYTES = 1024 * 1024;

const held = (pattern, value) => (typeof value === "string" && pattern.test(value) ? value : null);

/** The request's top-level `model`, if it is a well-formed model id. */
export function requestModel(body) {
  if (!body || body.length === 0 || body.length > MODEL_PARSE_LIMIT) return null;
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? held(MODEL, parsed.model) : null;
  } catch {
    return null;
  }
}

/**
 * The gateway's refusal code from an error body, or null. The gateway's own
 * refusals are `{ "error": "<code>" }` with a string; a provider's errors carry an
 * object there, and an Ollama-style string is prose, which fails the pattern.
 */
export function refusalCode(text) {
  try {
    const parsed = JSON.parse(text);
    return held(CODE, parsed?.error);
  } catch {
    return null;
  }
}

/** `/api/v1/<provider>/...` → provider, else null. */
export function providerOf(path) {
  const match = /^\/api\/v1\/([^/?#]+)/.exec(String(path ?? ""));
  return match ? held(PROVIDER, match[1]) : null;
}

/** The gateway's budget read, which the board and the status line poll: not a call. */
export function isBudgetRead(path) {
  return /^\/api\/v1\/self(\?|$)/.test(String(path ?? ""));
}

/** Reads at most `limit` bytes of a (cloned) body, then cancels it. Never throws. */
export async function peekText(body, limit = REFUSAL_PEEK_BYTES) {
  if (!body) return "";
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
  } catch {
    // An aborted body has no code to read.
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, limit).toString("utf8");
}

const LOOPBACK_PEER = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hostIsThisListener(hostHeader, port) {
  if (typeof hostHeader !== "string") return false;
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(hostHeader.trim().toLowerCase());
  return Boolean(match && LOOPBACK_NAMES.has(match[1]) && Number(match[2]) === port);
}

function answer(res, status, error, message) {
  const body = JSON.stringify({ error, message });
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    connection: "close",
  });
  res.end(body);
}

/**
 * @param {{ runId: string, capacity?: number, maxSubscribers?: number, enabled?: boolean, now?: () => number }} options
 */
export function createWatchFeed({ runId, capacity = 200, maxSubscribers = 8, enabled = true, now = () => Date.now() }) {
  const ring = [];
  const subscribers = new Set();
  let seq = 0;

  function send(res, line) {
    try {
      // A subscriber whose socket is backed up is dropped: buffering for it would
      // grow without bound, and waiting for it would slow calls.
      res.write(line);
      if ((res.writableLength ?? 0) > MAX_BUFFERED_BYTES) drop(res);
    } catch {
      drop(res);
    }
  }

  function drop(res) {
    subscribers.delete(res);
    try {
      res.destroy();
    } catch {
      // Already gone.
    }
  }

  function broadcast(event) {
    if (subscribers.size === 0) return;
    let line;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch {
      return;
    }
    for (const res of [...subscribers]) send(res, line);
  }

  function remember(record) {
    ring.push(record);
    if (ring.length > capacity) ring.splice(0, ring.length - capacity);
  }

  /**
   * A call the board will show. `settle` announces it once its outcome is known;
   * `finish` records the total time when the response is done. Either order works:
   * a call that finishes before it is settled is announced with its total.
   * Never throws.
   */
  function begin({ startedAt = now(), lineage = null, model = null, provider = null } = {}) {
    const record = {
      type: "call",
      seq: ++seq,
      at: startedAt,
      ses: held(DECLARED, lineage?.session),
      agent: held(DECLARED, lineage?.agent),
      parent: held(DECLARED, lineage?.parent),
      model: held(MODEL, model),
      provider: held(PROVIDER, provider),
      outcome: null,
      code: null,
      status: null,
      ttfb: null,
      ms: null,
    };
    let announced = false;
    return {
      settle({ outcome, code = null, status, ttfb = null }) {
        try {
          if (announced) return;
          announced = true;
          record.outcome = ["boarded", "denied", "error"].includes(outcome) ? outcome : "error";
          record.code = held(CODE, code);
          record.status = Number.isInteger(status) ? status : null;
          record.ttfb = Math.max(0, Math.round(Number.isFinite(ttfb) ? ttfb : now() - record.at));
          remember(record);
          broadcast(record);
        } catch {
          // The feed is never the reason a call fails.
        }
      },
      finish() {
        try {
          if (record.ms !== null) return;
          record.ms = Math.max(0, Math.round(now() - record.at));
          if (announced) broadcast({ type: "end", seq: record.seq, ms: record.ms });
        } catch {
          // As above.
        }
      },
    };
  }

  /** A call whose outcome and end are known at once (refusals, upstream failures). */
  function record({ outcome, code = null, status, lineage = null, model = null, provider = null, startedAt = now() }) {
    const call = begin({ startedAt, lineage, model, provider });
    call.finish();
    call.settle({ outcome, code, status, ttfb: now() - startedAt });
  }

  /** Adds a subscriber, replaying the ring. Exposed for tests; `serve` is the way in. */
  function attach(res) {
    subscribers.add(res);
    send(res, `${JSON.stringify({ type: "hello", feed: "passcontrol-watch", v: 1, run: runId })}\n`);
    for (const r of ring) if (subscribers.has(res)) send(res, `${JSON.stringify(r)}\n`);
    try {
      res.on("close", () => subscribers.delete(res));
    } catch {
      subscribers.delete(res);
    }
  }

  /** Answers a request for `/_passcontrol/...`. `port` is the listener's bound port. */
  function serve(req, res, { port }) {
    req.resume();
    const pathname = String(req.url ?? "").split("?")[0];
    if (pathname !== WATCH_PATH) return answer(res, 404, "not_found", "Nothing is served here.");
    if (!enabled) {
      return answer(res, 404, "watch_off", "This sidecar is bound off loopback, so it serves no watch feed.");
    }
    if (req.method !== "GET") return answer(res, 405, "method_not_allowed", "The watch feed answers GET only.");
    const loopbackPeer = LOOPBACK_PEER.test(String(req.socket?.remoteAddress ?? ""));
    if (!loopbackPeer || req.headers.origin !== undefined || !hostIsThisListener(req.headers.host, port)) {
      return answer(res, 403, "watch_refused", "The watch feed is for `passcontrol watch` on this machine only.");
    }
    if (subscribers.size >= maxSubscribers) {
      return answer(res, 503, "watch_busy", `Already ${maxSubscribers} boards watching this sidecar.`);
    }
    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.socket?.setNoDelay?.(true);
    attach(res);
  }

  function close() {
    for (const res of [...subscribers]) drop(res);
  }

  return { begin, record, serve, attach, close, subscriberCount: () => subscribers.size };
}
