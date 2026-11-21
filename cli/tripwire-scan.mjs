// Tripwire decoy candidates (idea 12; research/idea-12-tripwire/).
//
// Shared by the gateway (lib/tripwire/*, edge runtime) and the local sidecar, so it is
// plain JavaScript with no Node built-ins and no hashing: the caller hashes each
// candidate and asks its registry. A candidate is NOT a finding. Only an exact digest
// match against a registered decoy is, so a false candidate costs one lookup and can
// never raise a Seen on its own. That is why this file errs towards proposing too much:
// no word boundaries (junk glued to a decoy must not hide it), and every decoding layer
// the design claims is tried.
//
// Forms covered (research/idea-12-tripwire/RESULTS.md, S2): plain; JSON \u escapes;
// percent-encoding; base64 (standard and url-safe, any byte alignment, line-wrapped); hex
// (either case); one of the first two layers around one of the last two; a decoy split across
// two ADJACENT string leaves of one JSON body; a decoy split across stream chunks.
// Forms NOT covered are listed there as accepted limits (compression, encryption,
// line-wrapped base64, any transformation the agent invents, splits across requests).
//
// Linear time: one indexOf pass per signature per layer, and each hit inspects a
// fixed-size window. Bounded output: at most `maxCandidates` unique candidates, and a
// truncation is reported, never silently dropped.

const PREFIX = "pc_agent_";
const SECRET_LENGTH = 43;
const DECOY_LENGTH = PREFIX.length + SECRET_LENGTH; // 52
const SECRET_CHAR = /^[A-Za-z0-9_-]$/;

export const TRIPWIRE_SCAN_LIMITS = Object.freeze({
  maxCandidates: 512,
  maxDepth: 64,
  // Longer than the longest single-decoy encoding this file reads: \u-escaped is 6
  // characters a byte (312), percent-encoded base64 of a decoy is ~216.
  streamWindow: 4096,
  streamTail: 640,
  // Characters of each adjacent leaf joined to find a decoy split across two leaves.
  seam: 640,
});

const B64_STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64_VALUE = new Map();
for (let i = 0; i < 64; i++) {
  B64_VALUE.set(B64_STD[i], i);
  B64_VALUE.set(B64_URL[i], i);
}

function encodeBase64(bytes, alphabet) {
  let out = "";
  for (let i = 0; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63];
  }
  return out; // whole groups only: the trailing partial group depends on what follows
}

// For each byte alignment k (bytes of the 3-byte group before the prefix), the base64
// characters of the prefix that do not depend on its neighbours, and how many
// characters into the group they start.
const PREFIX_BYTES = Array.from(PREFIX, (c) => c.charCodeAt(0));
const B64_SIGNATURES = [];
for (const alphabet of [B64_STD, B64_URL]) {
  for (let k = 0; k < 3; k++) {
    const enc = encodeBase64([...new Array(k).fill(0), ...PREFIX_BYTES], alphabet);
    const skip = k === 0 ? 0 : k + 1; // chars touched by the k leading bytes
    const signature = enc.slice(skip);
    if (!B64_SIGNATURES.some((s) => s.signature === signature)) B64_SIGNATURES.push({ signature, k, skip });
  }
}
const HEX_SIGNATURE = Array.from(PREFIX, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");

function isSecret(text, start) {
  if (start + SECRET_LENGTH > text.length) return false;
  for (let i = start; i < start + SECRET_LENGTH; i++) {
    if (!SECRET_CHAR.test(text[i])) return false;
  }
  return true;
}

/** Collects unique candidates up to the cap. */
class Sink {
  constructor(limit = TRIPWIRE_SCAN_LIMITS.maxCandidates) {
    this.limit = limit;
    this.set = new Set();
    this.truncated = false;
  }
  add(candidate) {
    if (this.set.has(candidate)) return;
    if (this.set.size >= this.limit) {
      this.truncated = true;
      return;
    }
    this.set.add(candidate);
  }
}

function scanPlain(text, sink) {
  for (let at = text.indexOf(PREFIX); at !== -1; at = text.indexOf(PREFIX, at + 1)) {
    const start = at + PREFIX.length;
    if (isSecret(text, start)) sink.add(text.slice(at, start + SECRET_LENGTH));
  }
}

function decodeBase64Window(text, from, chars) {
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (let i = from; i < from + chars && i < text.length; i++) {
    const v = B64_VALUE.get(text[i]);
    if (v === undefined) break;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return String.fromCharCode(...bytes);
}

function scanBase64(text, sink) {
  // A decoy needs the k leading bytes plus 52: ceil((k + 52) / 3) groups.
  for (const { signature, k, skip } of B64_SIGNATURES) {
    for (let at = text.indexOf(signature); at !== -1; at = text.indexOf(signature, at + 1)) {
      const groupStart = at - skip;
      if (groupStart < 0) continue;
      const chars = Math.ceil((k + DECOY_LENGTH) / 3) * 4;
      const decoded = decodeBase64Window(text, groupStart, chars);
      const value = decoded.slice(k, k + DECOY_LENGTH);
      if (value.startsWith(PREFIX) && isSecret(value, PREFIX.length)) sink.add(value);
    }
  }
}

function scanHex(text, sink) {
  const lower = text.toLowerCase();
  for (let at = lower.indexOf(HEX_SIGNATURE); at !== -1; at = lower.indexOf(HEX_SIGNATURE, at + 1)) {
    if (at + DECOY_LENGTH * 2 > lower.length) continue;
    let value = "";
    for (let i = 0; i < DECOY_LENGTH; i++) {
      const pair = lower.slice(at + i * 2, at + i * 2 + 2);
      if (!/^[0-9a-f]{2}$/.test(pair)) break;
      value += String.fromCharCode(parseInt(pair, 16));
    }
    if (value.length === DECOY_LENGTH && isSecret(value, PREFIX.length)) sink.add(value);
  }
}

function unescapeJson(text) {
  if (!text.includes("\\")) return null;
  // Any number of backslashes before the u: JSON inside a JSON string escapes the escape
  // (`\\u0070`), and that is how a nested tool result arrives (S2 suite, red team R3-07).
  const out = text.replace(/\\+u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\+\//g, "/");
  return out === text ? null : out;
}

function decodePercent(text) {
  if (!text.includes("%")) return null;
  const out = text.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return out === text ? null : out;
}

function scanLayers(text, sink) {
  const layers = [text];
  // Line-wrapped base64 or hex (MIME's 76 columns, `base64` without -w0, PEM-style): the
  // same text with line breaks removed. Red team R1-06.
  if (text.includes("\n") || text.includes("\r")) {
    const unwrapped = text.replace(/[\r\n]+/g, "");
    if (unwrapped !== text) layers.push(unwrapped);
  }
  const json = unescapeJson(text);
  if (json !== null) layers.push(json);
  const percent = decodePercent(text);
  if (percent !== null) layers.push(percent);
  for (const layer of layers) {
    scanPlain(layer, sink);
    scanBase64(layer, sink);
    scanHex(layer, sink);
  }
}

/** Candidates in one string. Never throws on a string. */
/**
 * A credential header's value, plus what its HTTP Basic credentials decode to, when it is
 * Basic auth (curl -u, git credential helpers; red team R2-01/02). The gateway and the
 * sidecar both read headers through this, so the two cannot disagree (review R12-10).
 * Standard or URL-safe base64; anything that is not base64 adds nothing.
 */
export function credentialHeaderTexts(raw) {
  if (typeof raw !== "string") return [];
  const texts = [raw];
  const basic = /^\s*basic\s+([A-Za-z0-9+/=_-]{1,4096})\s*$/i.exec(raw);
  if (basic) {
    try {
      texts.push(atob(basic[1].replace(/-/g, "+").replace(/_/g, "/")));
    } catch {
      // Not base64: nothing more to read.
    }
  }
  return texts;
}

export function findDecoyCandidates(text) {
  const sink = new Sink();
  if (typeof text === "string" && text.length > 0) scanLayers(text, sink);
  return { candidates: [...sink.set], truncated: sink.truncated };
}

/**
 * Candidates in a parsed JSON value: every string leaf (base64 media included, because
 * a text document travels as base64), plus the seam between each pair of adjacent
 * leaves, so a decoy cut across two messages is still read whole.
 */
export function candidatesInJson(value) {
  const sink = new Sink();
  const gaps = new Set();
  let previous = "";
  const seam = TRIPWIRE_SCAN_LIMITS.seam;
  const pending = [[value, 0]];
  const visited = new WeakSet();
  const leaf = (text) => {
    scanLayers(text, sink);
    if (previous) scanLayers(previous.slice(-seam) + text.slice(0, seam), sink);
    previous = text;
  };
  while (pending.length) {
    const [node, depth] = pending.pop();
    if (typeof node === "string") {
      leaf(node);
      continue;
    }
    if (node === null || typeof node !== "object") continue;
    if (depth >= TRIPWIRE_SCAN_LIMITS.maxDepth) {
      gaps.add("depth_limit");
      continue;
    }
    if (visited.has(node)) continue;
    visited.add(node);
    // Object keys too: a decoy can be a key. Pushed in reverse so leaves come out in order.
    const entries = Array.isArray(node) ? node.map((v) => [null, v]) : Object.entries(node);
    for (let i = entries.length - 1; i >= 0; i--) {
      const [key, child] = entries[i];
      pending.push([child, depth + 1]);
      if (key !== null && key.length >= PREFIX.length) pending.push([key, depth + 1]);
    }
  }
  if (sink.truncated) gaps.add("candidate_limit");
  return { candidates: [...sink.set], truncated: sink.truncated, gaps: [...gaps] };
}

/**
 * For text that arrives in fragments (a streamed answer, a chunked body): a bounded
 * window scanned as it grows, keeping a tail longer than any encoded decoy.
 */
export function createStreamCandidateFinder() {
  const { streamWindow, streamTail } = TRIPWIRE_SCAN_LIMITS;
  const sink = new Sink();
  let window = "";
  return {
    push(fragment) {
      if (typeof fragment !== "string" || fragment.length === 0) return;
      for (let at = 0; at < fragment.length; ) {
        const room = streamWindow - window.length;
        window += fragment.slice(at, at + room);
        at += room;
        if (window.length >= streamWindow) {
          scanLayers(window, sink);
          window = window.slice(-streamTail);
        }
      }
    },
    finish() {
      scanLayers(window, sink);
      window = "";
      return { candidates: [...sink.set], truncated: sink.truncated };
    },
    retained() {
      return window.length;
    },
  };
}
