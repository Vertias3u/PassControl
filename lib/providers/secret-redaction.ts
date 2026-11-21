// Response-side protection for invariant 4: the provider key PassControl
// injected must not come back to the agent, even when the upstream echoes it.
//
// The request side was always airtight — the key is added after every check and
// never logged. The response side was not. The proxy forwards provider error
// bodies verbatim, success JSON re-serialised, and SSE bytes unchanged, so an
// upstream that reflects the Authorization header it received (a custom
// endpoint, a debugging proxy in front of a provider, an error page that quotes
// the request) handed the tenant's real key to whoever held the agent
// credential — which is the one party this gateway exists to keep it from.
// Found as S-02 by the credential-path audit; reproduced against the handler.
//
// ── What this does and does not cover ───────────────────────────────────────
// Widened 2026-11-09 after the credential-isolation benchmark
// (~/agent-credential-bench) showed an exact-bytes match let every transformed echo
// through. For a key of 16+ characters it now removes:
//   - the exact key and its JSON-escaped spelling;
//   - base64 and base64url of it, alone or inside a longer encoding (Basic auth
//     "user:<key>", a base64'd "Bearer <key>" header) at any of the three byte offsets;
//   - hex (either case), fully percent-encoded (either case), and reversed (free to add);
//   - ANY run of 12+ characters of the key's secret part, which catches a key cut in
//     halves, truncated, or split around other text. The public prefix
//     (`sk-ant-api03-`, `sk-proj-`, `github_pat_`, …) is excluded, so text that
//     merely mentions a key format is never touched.
// Keys of 6–15 characters stay exact-match only: their fragments and encodings are
// short enough to collide with ordinary output.
//
// Each of those spellings is looked for in two places:
//   1. the BYTES of every body: a buffered answer, and a stream of any kind;
//   2. (2026-11-10) the TEXT A CLIENT JOINS from a stream. A model streams text a few
//      characters per SSE event, each in its own JSON, so a key that arrives that way
//      never forms a 12-byte run, but the agent's SDK appends the pieces and has the
//      whole key. This was the benchmark's last failing case (`leaks/stream-split`).
//      Where an SSE event carries JSON with streamed text inside a `delta`, the
//      pieces are now joined as the client joins them and matched there. That covers
//      Anthropic Messages (`delta.text`, `delta.partial_json`, `delta.thinking`),
//      OpenAI Chat Completions (`choices[].delta.content`, tool-call `arguments`) and
//      OpenAI Responses (a string `delta`), in pieces of any size, across events and
//      across content blocks, plus streamed reasoning (`reasoning_content`, `reasoning`)
//      and refusals (`refusal`). The field names are STREAM_TEXT_KEYS
//      (lib/stream-text-keys.ts), the list lib/secret-guard.ts reads, not a second one.
//
// Still NOT covered, and each pinned by a test so this stays true:
//   - streamed text this does not recognize: newline-delimited JSON (Ollama's native
//     stream), SSE whose text is not inside a `delta`, a `delta` field that
//     STREAM_TEXT_KEYS does not name, or an event that is not strict JSON (a bare
//     NaN, which some clients accept). Those get the byte-level masking, exactly as before.
//   - the first 1 to 3 characters of a key that trickles in under 4 characters per
//     event (see HOLD_FROM). For a real key that is its public `sk-`.
//   - pieces separated by more than STALE_AFTER other events, or by more than 256 KB.
//     Holding has to be bounded, so the held piece is then released. What follows is
//     still matched against it: no more than 11 secret characters ever pass in a row,
//     but an ENCODING cut up that way passes except for its last piece. No provider
//     streams like this; it takes an upstream doing it on purpose, and that upstream
//     was sent the key and has it already.
//   - pieces a client would have to join across separate strings: two choices, a text
//     block and a tool call, two tool calls of one choice.
//   - more than MAX_LANES text streams in one response that are each part-way into a
//     possible needle at once: the ones after that share a lane.
//   - a run of 11 or fewer secret characters, and transforms not listed above
//     (compression, other encodings of a fragment, the key re-cased).
//
// ── How matching works ──────────────────────────────────────────────────────
// Every spelling above is a "needle". Each body is masked with the union of every
// needle's occurrences, and each masked run becomes ONE marker, so overlapping
// fragments never leave a chopped residue between replacements. Streams work on bytes
// mapped one-to-one onto a string (each byte one char code), so the native indexOf
// does the searching and multi-byte text is never re-encoded; every needle is ASCII
// or the key's own UTF-8 bytes, so a needle can never match inside another character.
//
// ── Why the stream holds back only a needle PREFIX ──────────────────────────
// A key can arrive split across chunks at any byte. The simple fix — always
// hold back the last (key length − 1) bytes — delays every SSE event until the
// next one arrives, so a streaming client would see each token one event late.
// Instead only a tail that could still BECOME a needle is held: an SSE chunk
// ends in "\n\n", which begins no needle, so ordinary output passes with no added
// delay and only a genuine partial match waits for the next chunk. Characters
// already matched stay masked while held, so the tail of a run caught in one chunk
// cannot slip out alone in the next.
//
// ── How the joined text is followed ─────────────────────────────────────────
// `redactingStream` is two stages. The joined-text stage runs first and the byte stage
// above runs on whatever it emits, so nothing the byte stage caught before can be
// missed now, and a stream the first stage does not recognize gets exactly what it
// always got.
//
// The first stage assembles SSE data lines through the dispatching blank line;
// non-data fields retain their bytes and order. Each streamed string is appended to
// a LANE: the string the client builds from that field. A lane is named by the field's path, with array entries named by
// their own `index` (OpenAI sends choice 1 at position 0). So one choice's content is a
// lane, one tool call's arguments is a lane, and all of an Anthropic message's text
// deltas are ONE lane, whichever content block they are in: a client that concatenates
// text blocks gets a key that was cut across them. Only what a client joins by goes
// into the name. Anything else in it (a `type` the client ignores, "0" against 0) would
// let an upstream deal one string out over several lanes, and none would see the key.
// The assembled event is decoded as a client decodes it, for the same reason.
//
// Three rules, in the order they matter:
//   - HOLD WHOLE EVENTS, NEVER PARTS OF ONE. While a lane's tail is the first
//     HOLD_FROM+ characters of a needle, the line carrying it waits, and every later
//     line queues behind it. Lines leave in the order they arrived, always. If the
//     text turns out not to be a needle, the held lines go out byte for byte as the
//     upstream sent them. If the needle completes, each held line has its text field
//     rewritten (the first gets the marker, the rest of the run is left out) and
//     other event fields retain their meaning. No event is ever invented, dropped, split or
//     moved, so `index` fields, tool calls, usage and stop events mean what they did.
//     A held event's `event:` line may already be out; a client acts on an event at
//     its blank line, so that changes nothing.
//   - ORDINARY TEXT DOES NOT WAIT. A lane is examined once per character, and a
//     character can start a needle only if the HOLD_FROM characters from it are a
//     needle's first HOLD_FROM. Anything else is settled the moment it arrives.
//   - HOLDING IS BOUNDED (STALE_AFTER, MAX_QUEUED_BYTES, MAX_LINE_BYTES, MAX_LANES).
//     A released lane keeps what it has seen, so a needle that completes later is
//     still masked from where it was not yet sent. An assembled event exceeding
//     MAX_LINE_BYTES uses the existing over-long-line fallback: release queued
//     bytes, apply byte masking only until the next blank line, then resume.
//
// THINKING BLOCKS. Anthropic signs a thinking block, and a client must send it back
// unchanged on its next call. A key inside `delta.thinking` is redacted like any other
// text, which breaks that signature: the next call that replays the block is refused.
// That is the chosen outcome. The alternatives were to leave thinking alone (the key
// reaches the agent, which is the one thing this file exists to prevent) or to end the
// stream with an error (also loses the turn, and gives an upstream a way to break any
// response). Thinking that does NOT contain the key is never altered, so its signature
// stays valid: a held event is released as the exact bytes that arrived.

import { LOCAL_NO_KEY } from "@/lib/providers";
import { STREAM_TEXT_KEYS } from "@/lib/stream-text-keys";

/** What an echoed key becomes. No quotes or backslashes, so JSON stays valid. */
export const PROVIDER_KEY_REDACTION = "[REDACTED_PROVIDER_KEY]";

/**
 * The shortest value treated as a key. Stored keys can be any length (custom and
 * `local` endpoints take whatever the server was started with), and LiteLLM
 * documents `sk-1234` as a master key, so this was 16 and let exactly those
 * through (cloud review 2026-11-03, A8). Below 6, replacing the value everywhere
 * would scramble ordinary output, and a key that short is guessable anyway.
 */
const MIN_SECRET_LENGTH = 6;

/** Below this, only the exact key (and its JSON escape) is removed. */
const MIN_TRANSFORM_LENGTH = 16;

/** The shortest run of the secret part that is removed on its own. */
export const FRAGMENT_LENGTH = 12;

/**
 * The key's public prefix: up to three short letter-led segments each ending in "-"
 * or "_" (`sk-ant-api03-`, `sk-proj-`, `sk-or-v1-`, `github_pat_`, `xoxb-`). Fragments
 * are taken only from what follows it.
 */
const PUBLIC_PREFIX = /^(?:[A-Za-z][A-Za-z0-9]{0,7}[-_]){1,3}/;

/** Bytes → a string with one char per byte (0–255), and back. */
function bytesToBinary(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return out;
}
function binaryToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function base64(bytes: Uint8Array): string {
  return btoa(bytesToBinary(bytes));
}

/** base64 of `key` when encoded inside a longer string, one stable core per byte offset. */
function base64Cores(key: Uint8Array): string[] {
  const out: string[] = [];
  for (const offset of [0, 1, 2]) {
    const padded = new Uint8Array(offset + key.length);
    padded.set(key, offset);
    const encoded = base64(padded);
    const lead = Math.ceil((offset * 8) / 6);
    const whole = Math.floor(padded.length / 3) * 4;
    out.push(encoded.slice(lead, whole));
  }
  return out;
}

/**
 * Every spelling of `key` to remove (see the header). Longest first. All are plain
 * strings; for a key of plain ASCII they are what appears in decoded text too.
 */
export function secretsToRedact(key: string | null | undefined): string[] {
  // The keyless-local marker is a fixed public string, never sent upstream.
  if (typeof key !== "string" || key.length < MIN_SECRET_LENGTH || key === LOCAL_NO_KEY) return [];
  const escaped = JSON.stringify(key).slice(1, -1).replaceAll("/", "\\/");
  const exact = escaped === key ? [key] : [key, escaped];
  if (key.length < MIN_TRANSFORM_LENGTH) return exact;

  const bytes = new TextEncoder().encode(key);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  const percent = [...bytes].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
  const cores = base64Cores(bytes);
  const needles = new Set<string>([
    ...exact,
    base64(bytes),
    ...cores,
    ...cores.map((c) => c.replaceAll("+", "-").replaceAll("/", "_")),
    hex,
    hex.toUpperCase(),
    percent,
    percent.toUpperCase(),
    [...key].reverse().join(""),
  ]);
  const secretPart = key.slice(key.match(PUBLIC_PREFIX)?.[0].length ?? 0);
  for (let i = 0; i + FRAGMENT_LENGTH <= secretPart.length; i++) {
    needles.add(secretPart.slice(i, i + FRAGMENT_LENGTH));
  }
  return [...needles].filter((n) => n.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

/** Mark every character of `text` covered by an occurrence of any needle. */
function maskOf(text: string, needles: readonly string[], mask: boolean[]): boolean {
  let any = false;
  for (const needle of needles) {
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      for (let i = at; i < at + needle.length; i++) mask[i] = true;
      any = true;
    }
  }
  return any;
}

/** `text` with each maximal masked run replaced by one marker. */
function applyMask(text: string, mask: readonly boolean[], marker: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (!mask[i]) {
      let j = i;
      while (j < text.length && !mask[j]) j++;
      out += text.slice(i, j);
      i = j;
    } else {
      while (i < text.length && mask[i]) i++;
      out += marker;
    }
  }
  return out;
}

function redactRawSecretsInText(text: string, secrets: readonly string[]): { text: string; redacted: boolean } {
  if (secrets.length === 0 || text.length === 0) return { text, redacted: false };
  const mask: boolean[] = new Array(text.length).fill(false);
  if (!maskOf(text, secrets, mask)) return { text, redacted: false };
  return { text: applyMask(text, mask, PROVIDER_KEY_REDACTION), redacted: true };
}

/** Decode only JSON escapes that cannot change string boundaries or control characters.
 * Keep the original spelling unless the decoded view actually contains a secret.
 */
export function redactSecretsInText(text: string, secrets: readonly string[]): { text: string; redacted: boolean } {
  const raw = redactRawSecretsInText(text, secrets);
  if (!secrets.length) return raw;
  // Consume all escape pairs, including escaped backslashes, so a literal \\uXXXX
  // is never mistaken for an encoded character.
  const decoded = raw.text.replace(/\\(?:u([0-9a-f]{4})|[\s\S])/gi, (escape, hex: string | undefined) => {
    if (escape === "\\/") return "/";
    if (!hex) return escape;
    const code = parseInt(hex, 16);
    return code >= 0x20 && code <= 0x7e && code !== 0x22 && code !== 0x5c ? String.fromCharCode(code) : escape;
  });
  const inspected = redactRawSecretsInText(decoded, secrets);
  return inspected.redacted ? inspected : raw;
}

/** Only credential-aware callers use this; the generic telemetry scrubber stays generic. */
export function redactProviderError(error: unknown, secrets: readonly string[]): unknown {
  if (error instanceof Error) {
    const message = redactSecretsInText(error.message, secrets);
    const stack = error.stack === undefined ? undefined : redactSecretsInText(error.stack, secrets);
    const name = redactSecretsInText(error.name, secrets);
    if (!message.redacted && !stack?.redacted && !name.redacted) return error;
    const safe = new Error(message.text);
    safe.name = name.text;
    safe.stack = stack?.text;
    return safe;
  }
  return typeof error === "string" ? redactSecretsInText(error, secrets).text : error;
}

/** Longest k < needle.length such that `text` ends with needle's first k characters. */
function heldPrefixLength(text: string, needle: string): number {
  for (let k = Math.min(needle.length - 1, text.length); k > 0; k--) {
    if (text.endsWith(needle.slice(0, k))) return k;
  }
  return 0;
}

/** One stage of the stream: text in, the text that may go on now out. Bytes as chars. */
interface Stage {
  push(chunk: string): string;
  flush(): string;
}

/**
 * The byte stage: every needle masked in the raw bytes, across chunk boundaries (see
 * "Why the stream holds back only a needle PREFIX"). `onMasked` fires on each output
 * that carries a marker.
 */
function byteStage(needles: readonly string[], marker: string, onMasked: () => void): Stage {
  let pending = "";
  let pendingMask: boolean[] = [];
  const masked = (text: string, mask: boolean[]) => {
    if (text.length === 0) return "";
    if (mask.some(Boolean)) onMasked();
    return applyMask(text, mask, marker);
  };
  return {
    push(chunk) {
      const buf = pending + chunk;
      const mask = pendingMask.concat(new Array(buf.length - pending.length).fill(false));
      maskOf(buf, needles, mask);
      const hold = Math.max(0, ...needles.map((n) => heldPrefixLength(buf, n)));
      let cut = buf.length - hold;
      // Never cut through a masked run: hold all of it, so it becomes one marker.
      while (cut > 0 && cut < buf.length && mask[cut] && mask[cut - 1]) cut--;
      pending = buf.slice(cut);
      pendingMask = mask.slice(cut);
      return masked(buf.slice(0, cut), mask.slice(0, cut));
    },
    flush() {
      // Whatever is held could not complete a longer needle: the stream ended.
      const out = masked(pending, pendingMask);
      pending = "";
      pendingMask = [];
      return out;
    },
  };
}

// ── The joined-text stage ───────────────────────────────────────────────────

/**
 * An event is held once the joined text ends with this many characters of a needle's
 * start. Not 1: a 100-character key has about a hundred needles, so nearly every letter
 * starts one of them, and holding from the first match would delay the last character
 * of almost every token. Four matching characters in ordinary text is roughly a
 * one-in-100,000 event. The price: a key that trickles in under 4 characters at a time
 * shows its first 1 to 3 characters before the marker (for a real key, the public `sk-`).
 */
export const HOLD_FROM = 4;

/**
 * A held event is released after this many further `data:` lines during which the text
 * it waits on did not grow. Pings, other choices and other blocks may sit between two
 * pieces of a key; this is how many of them the hold survives, and the bound on how long
 * text that only looked like a key can wait when nothing follows it.
 */
export const STALE_AFTER = 32;

/** The most that may queue behind a held event before it is released. */
const MAX_QUEUED_BYTES = 256 * 1024;
/** A line or assembled SSE event over this cap falls back to byte masking until its blank line. */
const MAX_LINE_BYTES = 1024 * 1024;
/**
 * Text streams followed at once in one response. Past this the least recently fed one
 * that is not part-way into a possible needle is forgotten; if every one is, further
 * streams share a single lane.
 */
const MAX_LANES = 1024;
/** How deep in an event's JSON streamed text is looked for (lib/secret-guard.ts uses the same). */
const MAX_DEPTH = 8;

/** The only lines this stage reads. Every other byte of a stream passes straight through it. */
const DATA = "data:";

/**
 * A lane: one string a client builds by appending streamed pieces. It keeps only the
 * tail it still needs, and positions are counted from the lane's first character ever.
 */
interface Lane {
  /** The kept tail of the joined text, and where it starts. */
  text: string;
  base: number;
  /** Per kept character: it is part of a needle that completed. */
  mask: boolean[];
  /** Starts of runs that begin a needle and may still complete, ascending. */
  open: number[];
  /** The next start not yet examined (it has fewer than HOLD_FROM characters after it). */
  next: number;
  /** Nothing before this can change any more: it may be sent. */
  settled: number;
  /** Everything before this has been sent. */
  sent: number;
  /** The last character sent went out as the marker: a continuing run adds no second one. */
  marked: boolean;
  /** The `data:` line count when text last arrived. */
  fed: number;
}

/** One streamed string inside a parsed event, and the stretch of its lane it carries. */
interface Leaf {
  holder: Record<string, unknown>;
  key: string;
  lane: Lane;
  start: number;
  end: number;
}

/** One line of the stream, waiting its turn. Only a line that carries streamed text has leaves. */
interface Line {
  raw: string;
  event?: unknown;
  leaves?: Leaf[];
}

/**
 * The joined-text stage: follows the text a client joins from an SSE stream and masks
 * needles in THAT (see the header). Lines leave in the order they came, always; a line
 * is changed only when a needle completed in text it carries.
 */
function joinedTextStage(needles: readonly string[], onMasked: () => void): Stage {
  // Needles by their first HOLD_FROM characters: a needle can only start where one of these does.
  const byStart = new Map<string, string[]>();
  for (const needle of needles) {
    if (needle.length < HOLD_FROM) continue;
    const start = needle.slice(0, HOLD_FROM);
    const list = byStart.get(start);
    if (list) list.push(needle);
    else byStart.set(start, [needle]);
  }
  const encoder = new TextEncoder();
  // Lenient, as a client's decoder is: a byte that is not UTF-8 becomes U+FFFD and the
  // event is still read. A strict decoder here would skip a line the client goes on to use.
  const decoder = new TextDecoder();

  // Where in a line the stream is: at its start (is it `data:`?), inside a `data:` line
  // (kept until it ends), or inside any other line (passed along as it arrives).
  let state: "start" | "data" | "other" = "start";
  let buffer = ""; // "start": the bytes that so far agree with `data:`; "data": the line so far
  let eventRaw = "";
  let eventData: string[] = [];
  let bypassEvent = false;
  let afterCR = false;
  let otherLength = 0;
  let seen = 0; // SSE events so far
  // Lanes by name, least recently fed first. `busy` ones are part-way into a possible
  // needle and are never forgotten; `shared` takes every new name once all are busy.
  const quiet = new Map<string, Lane>();
  const busy = new Map<string, Lane>();
  let shared: Lane | null = null;
  const queue: Line[] = [];
  let queuedBytes = 0;

  /**
   * Whether a needle may still complete from `start`. Masks every needle that already has.
   */
  const examine = (lane: Lane, start: number): boolean => {
    const at = start - lane.base;
    const candidates = byStart.get(lane.text.substring(at, at + HOLD_FROM));
    if (!candidates) return false;
    const have = lane.text.length - at;
    let open = false;
    for (const needle of candidates) {
      if (needle.length <= have) {
        if (lane.text.startsWith(needle, at)) for (let i = 0; i < needle.length; i++) lane.mask[at + i] = true;
      } else if (needle.startsWith(lane.text.slice(at))) {
        open = true;
      }
    }
    return open;
  };

  const newLane = (): Lane => ({ text: "", base: 0, mask: [], open: [], next: 0, settled: 0, sent: 0, marked: false, fed: seen });

  /** The lane a name feeds, taken out of the maps; `feed` files it again when it has grown. */
  const laneFor = (name: string): Lane => {
    const known = quiet.get(name) ?? busy.get(name);
    if (known) {
      quiet.delete(name);
      busy.delete(name);
      return known;
    }
    if (quiet.size + busy.size >= MAX_LANES) {
      // Forget the quiet lane fed longest ago: it holds no part of a needle, only its
      // last few characters. Lines already queued keep their own reference to it.
      const oldest = quiet.keys().next();
      if (oldest.done) return (shared ??= newLane());
      quiet.delete(oldest.value);
    }
    return newLane();
  };

  /** Append a piece to its lane; returns the stretch it occupies. */
  const feed = (name: string, piece: string): [Lane, number, number] => {
    const lane = laneFor(name);
    const start = lane.base + lane.text.length;
    const end = start + piece.length;
    lane.text += piece;
    for (let i = 0; i < piece.length; i++) lane.mask.push(false);
    lane.fed = seen;
    lane.open = lane.open.filter((s) => examine(lane, s));
    for (; lane.next + HOLD_FROM <= end; lane.next++) if (examine(lane, lane.next)) lane.open.push(lane.next);
    if (lane !== shared) (lane.open.length ? busy : quiet).set(name, lane);
    // Settled: everything before the earliest run that may still become a needle. It
    // never moves back: what was sent, or released, stays so. A character already
    // masked cannot change either, so it does not wait for the run it sits in.
    let settled = Math.max(lane.settled, lane.open.length ? lane.open[0]! : end);
    while (settled < end && lane.mask[settled - lane.base]) settled++;
    lane.settled = settled;
    return [lane, start, end];
  };

  /** Stop waiting on a lane: all it has so far may be sent as it stands. */
  const release = (lane: Lane): void => {
    lane.settled = lane.base + lane.text.length;
  };

  /** Every streamed string in an event: a STREAM_TEXT_KEYS field inside a `delta`. */
  const leavesOf = (event: unknown): Leaf[] => {
    const leaves: Leaf[] = [];
    const type = (event as { type?: unknown }).type;
    const walk = (node: unknown, path: string, inDelta: boolean, depth: number): void => {
      if (depth > MAX_DEPTH || node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach((item, i) => {
          // An array entry is named by its own `index` when it has one: OpenAI sends
          // choice 1, or tool call 2, at position 0 of the array. "1" and 1 are one name,
          // as they are to a client.
          const index = item !== null && typeof item === "object" ? (item as { index?: unknown }).index : undefined;
          walk(item, `${path}[${typeof index === "number" || typeof index === "string" ? index : `@${i}`}]`, inDelta, depth + 1);
        });
        return;
      }
      const holder = node as Record<string, unknown>;
      for (const [key, value] of Object.entries(holder)) {
        const within = inDelta || key === "delta";
        if (typeof value === "string") {
          if (!within || !STREAM_TEXT_KEYS.has(key)) continue;
          // The name is the path, which is what a client joins by. The event's `type`
          // is part of it only for a top-level string `delta` (OpenAI Responses), where
          // the type is all that tells text from tool arguments. Anywhere else a client
          // ignores `type`, so letting it split a lane would be a way past this stage.
          const name = path === "" && typeof type === "string" ? `${type}|${key}` : `${path}.${key}`;
          const [lane, start, end] = feed(name, value);
          leaves.push({ holder, key, lane, start, end });
        } else {
          walk(value, `${path}.${key}`, within, depth + 1);
        }
      }
    };
    walk(event, "", false, 0);
    return leaves;
  };

  /** SSE joins every data line with a newline before JSON parsing (which decodes escapes). */
  const follow = (raw: string, data: string): Line | null => {
    let event: unknown;
    try {
      event = JSON.parse(decoder.decode(binaryToBytes(data)));
    } catch {
      return null;
    }
    if (event === null || typeof event !== "object") return null;
    const leaves = leavesOf(event);
    return leaves.length ? { raw, event, leaves } : null;
  };

  /** The bytes to send for a line whose turn has come. */
  const send = (line: Line): string => {
    if (!line.leaves) return line.raw;
    let changed = false;
    for (const leaf of line.leaves) {
      const { lane } = leaf;
      const from = leaf.start - lane.base;
      const to = leaf.end - lane.base;
      const firstMasked = lane.mask.indexOf(true, from);
      if (firstMasked === -1 || firstMasked >= to) {
        if (to > from) lane.marked = false;
      } else {
        // One marker for each run of masked characters, also when the run began in an
        // earlier event: the rest of it is simply left out.
        let text = "";
        for (let i = from; i < to; i++) {
          if (!lane.mask[i]) {
            text += lane.text[i];
            lane.marked = false;
          } else if (!lane.marked) {
            text += PROVIDER_KEY_REDACTION;
            lane.marked = true;
          }
        }
        leaf.holder[leaf.key] = text;
        changed = true;
      }
      lane.sent = leaf.end;
      // Keep only what can still matter: unsent text, and runs that may still complete.
      const keep = Math.min(lane.sent, lane.next, lane.open.length ? lane.open[0]! : lane.next);
      if (keep > lane.base) {
        lane.text = lane.text.slice(keep - lane.base);
        lane.mask = lane.mask.slice(keep - lane.base);
        lane.base = keep;
      }
    }
    if (!changed) return line.raw;
    onMasked();
    const json = bytesToBinary(encoder.encode(JSON.stringify(line.event)));
    let written = false;
    // Preserve comments, event/id/retry fields and the dispatching blank line.
    // Only matched events are reserialized; ordinary events retain every byte.
    return line.raw.replace(/(^|(?<=[\r\n]))data:[^\r\n]*(?:\r\n|\r|\n|$)/g, (raw) => {
      if (written) return "";
      written = true;
      const ending = raw.endsWith("\r\n") ? "\r\n" : /[\r\n]$/.test(raw) ? raw.slice(-1) : "";
      return `${DATA} ${json}${ending}`;
    });
  };

  /** Send every line at the head of the queue whose text has settled. */
  const drain = (releaseAll = false): string => {
    let out = "";
    while (queue.length) {
      const head = queue[0]!;
      const waiting = head.leaves?.find((leaf) => leaf.end > leaf.lane.settled);
      if (waiting) {
        const stale = seen - waiting.lane.fed > STALE_AFTER;
        if (!releaseAll && !stale && queuedBytes <= MAX_QUEUED_BYTES) break;
        release(waiting.lane);
        continue;
      }
      queue.shift();
      queuedBytes -= head.raw.length;
      out += send(head);
    }
    return out;
  };

  /** Bytes that are not a line this stage reads: out at once, unless something is held ahead of them. */
  const pass = (bytes: string): string => {
    if (queue.length === 0 || bytes.length === 0) return bytes;
    const last = queue[queue.length - 1]!;
    if (last.leaves) queue.push({ raw: bytes });
    else last.raw += bytes;
    queuedBytes += bytes.length;
    return drain();
  };

  const finishEvent = (): string => {
    if (eventData.length) seen++;
    const raw = eventRaw;
    const data = eventData.join("\n");
    eventRaw = "";
    eventData = [];
    const bypass = bypassEvent;
    bypassEvent = false;
    if (bypass || !raw) return "";
    const line = data.includes('"delta"') || data.includes("\\u") ? follow(raw, data) : null;
    if (!line) return pass(raw);
    queue.push(line);
    queuedBytes += raw.length;
    return drain();
  };

  const keep = (bytes: string): string => {
    if (bypassEvent || !eventRaw) return pass(bytes);
    eventRaw += bytes;
    if (eventRaw.length <= MAX_LINE_BYTES) return "";
    // Same fallback as the old over-long data line: release queued content in
    // order, then retain byte masking only. Resume inspection at the next event.
    const out = drain(true) + eventRaw;
    eventRaw = "";
    eventData = [];
    bypassEvent = true;
    return out;
  };

  const dataLine = (raw: string): string => {
    if (bypassEvent) return pass(raw);
    if (!eventRaw) eventRaw = raw;
    else eventRaw += raw;
    if (eventRaw.length > MAX_LINE_BYTES) {
      const out = drain(true) + eventRaw;
      eventRaw = "";
      eventData = [];
      bypassEvent = true;
      return out;
    }
    let data = raw.slice(DATA.length).replace(/[\r\n]+$/, "");
    if (data.startsWith(" ")) data = data.slice(1);
    eventData.push(data);
    return "";
  };

  return {
    push(chunk) {
      let out = "";
      let pos = 0;
      // Cache absent line endings too: rescanning the rest of a large chunk for
      // a CR that is not there on every LF would make ordinary SSE quadratic.
      let lf = -2;
      let cr = -2;
      while (pos < chunk.length) {
        // CRLF is one line ending even across network chunks. The CR already
        // ended the line; retain its LF without treating it as a dispatch.
        if (afterCR) {
          afterCR = false;
          if (chunk[pos] === "\n") {
            out += keep("\n");
            pos++;
            continue;
          }
        }
        if (state === "start") {
          while (buffer.length < DATA.length && pos < chunk.length && chunk[pos] === DATA[buffer.length]) buffer += chunk[pos++];
          if (buffer.length === DATA.length) state = "data";
          else if (pos < chunk.length) {
            state = "other";
            otherLength = buffer.length;
            out += keep(buffer);
            buffer = "";
          }
          continue;
        }
        if (lf !== -1 && lf < pos) lf = chunk.indexOf("\n", pos);
        if (cr !== -1 && cr < pos) cr = chunk.indexOf("\r", pos);
        const end = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
        let upTo = end === -1 ? chunk.length : end + 1;
        if (end !== -1 && chunk[end] === "\r" && chunk[upTo] === "\n") upTo++;
        const bytes = chunk.slice(pos, upTo);
        pos = upTo;
        if (state === "other") {
          out += keep(bytes);
          if (end !== -1 && otherLength === 0 && (bytes === "\n" || bytes === "\r" || bytes === "\r\n")) out += finishEvent();
          otherLength += bytes.length;
        } else if (end !== -1) {
          out += dataLine(buffer + bytes);
          buffer = "";
        } else {
          buffer += bytes;
          if (buffer.length + eventRaw.length > MAX_LINE_BYTES) {
            out += drain(true) + eventRaw + buffer;
            eventRaw = "";
            eventData = [];
            buffer = "";
            bypassEvent = true;
            state = "other";
            otherLength = 1;
          }
        }
        if (end !== -1) {
          afterCR = chunk[end] === "\r" && upTo === end + 1;
          state = "start";
        }
      }
      return out;
    },
    flush() {
      const out = state === "data" ? dataLine(buffer) : keep(buffer);
      buffer = "";
      state = "start";
      return out + finishEvent() + drain(true);
    },
  };
}

function encodeNeedles(secrets: readonly string[]): { needles: string[]; marker: string } {
  const encoder = new TextEncoder();
  return {
    needles: secrets.filter(Boolean).map((s) => bytesToBinary(encoder.encode(s))),
    marker: bytesToBinary(encoder.encode(PROVIDER_KEY_REDACTION)),
  };
}

function stagedStream(stages: readonly Stage[] | null): TransformStream<Uint8Array, Uint8Array> {
  if (!stages) return new TransformStream<Uint8Array, Uint8Array>(); // nothing to redact: pass through
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      let text = bytesToBinary(chunk);
      for (const stage of stages) text = stage.push(text);
      if (text.length) controller.enqueue(binaryToBytes(text));
    },
    flush(controller) {
      // Each stage's last output goes through the stages after it, then they end too.
      let text = "";
      for (const stage of stages) text = stage.push(text) + stage.flush();
      if (text.length) controller.enqueue(binaryToBytes(text));
    },
  });
}

/**
 * Byte stream → byte stream with every spelling of the key replaced in the BYTES only:
 * the stream redactor as it was before the joined-text stage. Kept on its own because
 * it is what any stream this file does not recognize must still get, and the tests hold
 * the full stream to it step for step.
 */
export function redactingByteStream(
  secrets: readonly string[],
  onRedact?: () => void
): TransformStream<Uint8Array, Uint8Array> {
  const { needles, marker } = encodeNeedles(secrets);
  let reported = false;
  const report = () => {
    if (reported) return;
    reported = true;
    onRedact?.();
  };
  return stagedStream(needles.length ? [byteStage(needles, marker, report)] : null);
}

/**
 * Byte stream → byte stream with every spelling of the key replaced (see the header):
 * first in the text a client joins from an SSE stream, then in the bytes of whatever
 * that leaves. `onRedact` fires once, on the first replacement.
 */
export function redactingStream(
  secrets: readonly string[],
  onRedact?: () => void
): TransformStream<Uint8Array, Uint8Array> {
  const { needles, marker } = encodeNeedles(secrets);
  let reported = false;
  const report = () => {
    if (reported) return;
    reported = true;
    onRedact?.();
  };
  return stagedStream(
    needles.length ? [joinedTextStage(secrets.filter(Boolean), report), byteStage(needles, marker, report)] : null
  );
}
