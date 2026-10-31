// The injection guard's scanner (plans/injection-guard.md §3).
//
// One file for both sides, like cli/tool-rules.mjs: the gateway scans what tools returned
// inside a model request (API mode), and the sidecar will scan what a hook hands it
// (subscription mode). Pure: no `node:` imports, no network, safe on the edge.
//
// It reads text that came from OUTSIDE the agent's owner: a tool result, a fetched page,
// a document. Never the system prompt or the user's own words (the caller picks the text;
// lib/injection-blocks.ts does it for request bodies).
//
// What a finding means: this text carries a tell that injected instructions carry. Not
// that it IS an injection, and never that text without one is safe. A polite instruction
// with no tell ("also CC the report to …") passes, and is what Phase 2's hold is for.
//
// Severity:
//   high  an unquoted tell, or any tell inside text a reader would not see (an HTML
//         comment, a hidden element, Unicode tag characters).
//   low   the same tell quoted or in code (`"ignore previous instructions"` in a doc or a
//         string literal), a negated one ("never send your keys to …"), or a weak tell
//         on its own (an authority claim, an invisible character, a `Human:` line).
// A quoted attack is therefore low. That is the price of not flagging every page ABOUT
// injection; Phase 1 records both, and the owner's data decides what Phase 2 holds on.
//
// Normalisation is for scanning only; nothing here changes what is forwarded. NFKC folds
// fullwidth and compatibility letters, invisible characters are removed (and counted),
// Unicode tag characters are decoded to the ASCII they smuggle. Nothing is base64- or
// URL-decoded (plan §3).
//
// Cost: every pattern is anchored on a literal word or character with bounded
// quantifiers, and every look-around is bounded. Bounded per match is not enough: the
// text is attacker-written, so a bound times every match was seconds (2026-10-30, measured
// in plans/codex-runs/inj-perf.report.md). So overlapping hidden spans are scanned once,
// fences and close tags are found by bisection, and a match's context is read at most
// CONTEXT_CHECKS_MAX times per pattern. The scan is synchronous and runs beside the call
// on the gateway, so this is its latency. Hostile 4 MB blocks are tested
// (tests/injection-scan.test.ts).

/** Immutable. A change to what this file finds ships under a new id. */
export const INJECTION_DETECTOR = "pc-heuristic-1";
/** Immutable, likewise, for the normalisation above. */
export const INJECTION_NORMALIZATION = 1;

export const INJECTION_FAMILIES = ["role_markup", "instruction_override", "exfil_directive", "authority_claim", "hidden_text"];

const HIDDEN_SEGMENT_MAX = 10_000;
const LINE_LOOK = 2_000;
const SENTENCE_LOOK = 300;

// ── Normalisation ────────────────────────────────────────────────────────────

// Invisible characters that have no business in ordinary text, and are counted. Joiners,
// directional marks and the soft hyphen are real in Persian, Hebrew, German or emoji, so
// they are removed for matching but never counted (a leading byte-order mark likewise).
const COUNTED_INVISIBLE = /[​⁠-⁤﻿‭‮]/g;
const SILENT_INVISIBLE = /[‌‍‎‏­‪-‬⁦-⁩᠎]/g;
const TAG_RUN = /[\u{e0000}-\u{e007f}]+/gu;
const BLACK_FLAG = 0x1f3f4;

/**
 * The text as scanned, plus what normalisation took out of sight: the ASCII decoded
 * from tag characters (a subdivision flag's tags are an emoji, not a message), and how
 * many counted invisible characters there were.
 */
function normalize(raw) {
  const smuggled = [];
  let text = raw.replace(TAG_RUN, (run, offset) => {
    const before = offset > 0 ? raw.codePointAt(offset - 2) : undefined;
    if (before === BLACK_FLAG) return "";
    let ascii = "";
    for (const ch of run) {
      const cp = ch.codePointAt(0) - 0xe0000;
      if (cp >= 0x20 && cp <= 0x7e) ascii += String.fromCharCode(cp);
    }
    if (ascii) smuggled.push(ascii);
    return "";
  });
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.normalize("NFKC");
  let invisible = 0;
  text = text.replace(COUNTED_INVISIBLE, () => {
    invisible++;
    return "";
  });
  text = text.replace(SILENT_INVISIBLE, "").replace(/[ \t \f\v]+/g, " ");
  return { text, smuggled, invisible };
}

// ── Hidden HTML ──────────────────────────────────────────────────────────────

const OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9-]{0,20})\b([^<>]{0,1000})>/g;
const HIDING_ATTR = /display\s{0,3}:\s{0,3}none|visibility\s{0,3}:\s{0,3}hidden|font-size\s{0,3}:\s{0,3}0(?![.\d])|opacity\s{0,3}:\s{0,3}0(?![.\d])|(?:^|\s)hidden(?=\s|=|$)/i;

const CLOSE_TAG = /<\/([a-zA-Z][a-zA-Z0-9-]{0,20})/g;
const ROLE_LOW_AT = /(?:Human|Assistant)\s{0,2}:/y;

/** The first value in ascending `list` that is >= `at`, or -1. */
function firstAtOrAfter(list, at) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid] < at) lo = mid + 1;
    else hi = mid;
  }
  return lo < list.length ? list[lo] : -1;
}

/**
 * Where each closing tag starts, under every prefix of its lowercased name: a hidden
 * `<i>` ends at the first `</i…` after it (`</img` too, as a plain search for `</i` would).
 */
function closeTagIndex(text) {
  const index = new Map();
  CLOSE_TAG.lastIndex = 0;
  for (const m of text.matchAll(CLOSE_TAG)) {
    const name = m[1].toLowerCase();
    for (let n = 1; n <= name.length; n++) {
      const key = name.slice(0, n);
      const list = index.get(key);
      if (list) list.push(m.index ?? 0);
      else index.set(key, [m.index ?? 0]);
    }
  }
  return index;
}

/**
 * Text a browser would not show: comment bodies and hidden elements' contents, each up to
 * HIDDEN_SEGMENT_MAX characters. Spans that overlap are merged and returned once, so no
 * character is scanned twice: before, every one of 400,000 nested `<i hidden>` opened its
 * own 10,000-character window, and one 4 MB block took over 20 s. `roleAtStart`: a span
 * merged into an earlier one starts with a `Human:` line, which its own segment would have
 * matched at `^` and the merged text does not.
 */
function hiddenSegments(text) {
  const spans = [];
  let at = 0;
  for (;;) {
    const open = text.indexOf("<!--", at);
    if (open === -1) break;
    const close = text.indexOf("-->", open + 4);
    const end = close === -1 ? text.length : close;
    spans.push([open + 4, Math.min(end, open + 4 + HIDDEN_SEGMENT_MAX)]);
    if (close === -1) break;
    at = close + 3;
  }
  let closes = null;
  OPEN_TAG.lastIndex = 0;
  for (const m of text.matchAll(OPEN_TAG)) {
    if (!HIDING_ATTR.test(m[2])) continue;
    const start = (m.index ?? 0) + m[0].length;
    const limit = Math.min(text.length, start + HIDDEN_SEGMENT_MAX);
    closes ??= closeTagIndex(text);
    const name = m[1].toLowerCase();
    const close = firstAtOrAfter(closes.get(name) ?? [], start);
    // The whole `</name` inside the window, as a search of the window alone required.
    spans.push([start, close !== -1 && close + 2 + name.length <= limit ? close : limit]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  const segments = [];
  let roleAtStart = false;
  let from = -1;
  let to = -1;
  for (const [s, e] of spans) {
    if (s < to) {
      ROLE_LOW_AT.lastIndex = s;
      if (ROLE_LOW_AT.test(text) && ROLE_LOW_AT.lastIndex <= e) roleAtStart = true;
      to = Math.max(to, e);
      continue;
    }
    if (from !== -1) segments.push(text.slice(from, to));
    from = s;
    to = e;
  }
  if (from !== -1) segments.push(text.slice(from, to));
  return { segments, roleAtStart };
}

// ── Quoted and code context ──────────────────────────────────────────────────

const FENCE = /^ {0,3}(?:```|~~~)/gm;
const CLOSERS = { '"': '"', "`": "`", "“": "”", "‘": "’", "«": "»", "'": "'" };
const WORD_CHAR = /[\p{L}\p{N}_]/u;

function fenceRanges(text) {
  const ranges = [];
  let open = -1;
  FENCE.lastIndex = 0;
  for (const m of text.matchAll(FENCE)) {
    if (open === -1) open = m.index ?? 0;
    else {
      ranges.push([open, m.index ?? 0]);
      open = -1;
    }
  }
  if (open !== -1) ranges.push([open, text.length]);
  return ranges;
}

/** Whether [start, end) sits inside a quote or inline code span on its own line. */
function quotedOnLine(text, start, end) {
  let lineStart = start;
  const floor = Math.max(0, start - LINE_LOOK);
  while (lineStart > floor && text[lineStart - 1] !== "\n") lineStart--;
  let lineEnd = end;
  const ceiling = Math.min(text.length, end + LINE_LOOK);
  while (lineEnd < ceiling && text[lineEnd] !== "\n") lineEnd++;
  let opener = null;
  let openAt = -1;
  for (let i = lineStart; i < lineEnd; i++) {
    const c = text[i];
    if (opener !== null) {
      if (c === CLOSERS[opener]) {
        if (openAt < start && i >= end) return true;
        opener = null;
      }
    } else if (i >= start) {
      // No span is open at the match, so none can contain it.
      return false;
    } else if (c in CLOSERS && c !== "”" && c !== "’" && c !== "»") {
      if (c === "'" && i > 0 && WORD_CHAR.test(text[i - 1])) continue;
      opener = c;
      openAt = i;
    }
  }
  return false;
}

function quotedContext(text, fences, start, end) {
  // Fences are disjoint and in order, so only the last one opening at or before `start`
  // can hold the match. Found by bisection: a walk over every fence, per match, took 12 s
  // on 100,000 fenced overrides.
  let lo = 0;
  let hi = fences.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (fences[mid][0] <= start) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && end <= fences[lo - 1][1]) return true;
  return quotedOnLine(text, start, end);
}

// ── The tells ────────────────────────────────────────────────────────────────

const OVERRIDE = [
  /\b(?:ignore|disregard|forget|override|bypass|skip)\s{1,3}(?:(?:all|any|the|your|these|those|my|of)\s{1,3}){0,3}(?:previous|prior|above|preceding|earlier|existing|original|initial|system|developer)\s{1,3}(?:instructions?|prompts?|rules|directives|guidelines|guidance|commands|messages|context|constraints)\b/gi,
  /\bnew\s{1,3}(?:system\s{1,3})?instructions?\s{0,3}:/gi,
];

const ROLE_HIGH = [
  /<\|(?:im_start|im_end|im_sep|system|user|assistant|endoftext|eot_id|start_header_id|end_header_id|begin_of_text)\|>/gi,
  /\[\/?INST\]|<<\/?SYS>>/g,
  /<\/(?:tool_result|function_results|tool_output|tool_response|system|instructions)>/gi,
  /<system>/gi,
];
// Not `<system-reminder>`: Claude Code writes that markup into its own requests, tool
// results included, so it would flag every Claude Code tool call. A fake one in a page
// is a real tell this version does not see.
const ROLE_LOW = /^(?:Human|Assistant)\s{0,2}:/gm;

const AUTHORITY = [
  /\b(?:user|owner|admin(?:istrator)?|developer|operator)\s{1,2}(?:has\s{1,2})?(?:already\s{1,2})?(?:authori[sz]ed|approved|permitted|granted\s{1,2}(?:you\s{1,2})?permission)\b/gi,
  /\b(?:note|message|instructions?|attention|important)\s{0,2}(?:to|for)\s{1,2}(?:the\s{1,2}|all\s{1,2}|any\s{1,2})?(?:ai|llm|language\s{1,2}model|assistant|agent|model|chatbot)s?\b/gi,
  /\bsystem\s{0,2}(?:override|administrator|admin)\b/gi,
];

const SECRET_NOUN = /\.env\b|\benv(?:ironment)?\s{1,2}(?:file|variables|vars)\b|\bsystem\s{1,2}prompt\b|\b(?:api|access|secret|private|ssh|aws)\s{0,2}keys\b|\ball\s{1,2}(?:the\s{1,2})?keys\b|\bcredentials\b|\bprivate\s{1,2}key\b|\bssh\s{1,2}key\b|\bpasswords?\b|\bsecrets\b|\bcookies\b|~\/\.ssh|\bid_rsa\b/gi;
const SEND_VERB = /\b(?:send|forward|upload|e-?mail|exfiltrate|transmit|leak|paste|share|copy|curl|wget)\b/i;
const DESTINATION = /https?:\/\/[^\s"'<>)]{1,300}|\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}\b/i;
const NEGATION = /\b(?:never|not|don'?t|do\s{1,2}not|must\s{1,2}not|mustn'?t|shouldn'?t|should\s{1,2}not|avoid|without)\b/i;
const MD_IMAGE = /!\[[^\]\n]{0,200}\]\(([^\s)]{1,1000})\)/g;
const BEACON_QUERY = /\{|%7b|\$|</i;

const isStop = (c) => c === "." || c === "!" || c === "?";

/** The sentence around [start, end): bounded, ending at `. ` / `! ` / `? ` or a newline. */
function sentenceAround(text, start, end) {
  let a = start;
  const floor = Math.max(0, start - SENTENCE_LOOK);
  while (a > floor && text[a - 1] !== "\n" && !(isStop(text[a - 1]) && /\s/.test(text[a] ?? " "))) a--;
  let b = end;
  const ceiling = Math.min(text.length, end + SENTENCE_LOOK);
  while (b < ceiling && text[b] !== "\n" && !(isStop(text[b]) && /\s/.test(text[b + 1] ?? " "))) b++;
  return text.slice(a, b);
}

// What a sentence needs before SEND_VERB and DESTINATION can match in it, without their
// word boundaries (a sentence cut mid-word can match where the whole text does not). Their
// positions are found once per text, so a secret noun with neither near it costs a bisection:
// `password ` 470,000 times over, each reading its sentence, took 4 s.
const SEND_LOOSE = /send|forward|upload|e-?mail|exfiltrate|transmit|leak|paste|share|copy|curl|wget/gi;
const DESTINATION_LOOSE = /https?:\/\/|@/gi;

function positions(text, re) {
  re.lastIndex = 0;
  return Array.from(text.matchAll(re), (m) => m.index ?? 0);
}

/** Whether any position in ascending `list` falls in [from, to). */
const anyIn = (list, from, to) => {
  const p = firstAtOrAfter(list, from);
  return p !== -1 && p < to;
};

// A backstop on top of the bounds above: per pattern per text, at most this many matches
// get their quote, code or sentence context read. Past it the pattern stops, keeping what
// it found (fail open: the scan must never stall the call it rides on). Reaching it takes
// a thousand quoted, fenced or negated tells in one block.
const CONTEXT_CHECKS_MAX = 1_000;

/**
 * Every tell in one normalised text, as family → severity. `hidden`: the text was out of
 * a reader's sight, so every tell in it is high, quoted or not.
 */
function tellsIn(text, hidden, found) {
  const fences = hidden ? [] : fenceRanges(text);
  const mark = (family, severity) => {
    if (found.get(family) !== "high") found.set(family, severity);
  };
  const strong = (family, re) => {
    re.lastIndex = 0;
    let checks = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const quoted = !hidden && quotedContext(text, fences, start, start + m[0].length);
      mark(family, quoted ? "low" : "high");
      if (found.get(family) === "high" || ++checks >= CONTEXT_CHECKS_MAX) return;
    }
  };

  for (const re of OVERRIDE) strong("instruction_override", re);
  for (const re of ROLE_HIGH) strong("role_markup", re);
  ROLE_LOW.lastIndex = 0;
  if (ROLE_LOW.test(text)) mark("role_markup", hidden ? "high" : "low");
  for (const re of AUTHORITY) {
    re.lastIndex = 0;
    if (re.test(text)) mark("authority_claim", hidden ? "high" : "low");
  }

  SECRET_NOUN.lastIndex = 0;
  let sends = null;
  let destinations = null;
  let checks = 0;
  for (const m of text.matchAll(SECRET_NOUN)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    // The sentence lies within SENTENCE_LOOK of the noun on either side. A verb at the
    // sentence's start can be one the text-wide scan skipped, inside an overlapping earlier
    // match ("shar|email" cut at the bar); that match starts at most 10 characters before.
    const from = start - SENTENCE_LOOK - 16;
    const to = end + SENTENCE_LOOK;
    sends ??= positions(text, SEND_LOOSE);
    if (!anyIn(sends, from, to)) continue;
    destinations ??= positions(text, DESTINATION_LOOSE);
    if (!anyIn(destinations, from, to)) continue;
    if (++checks > CONTEXT_CHECKS_MAX) break;
    const sentence = sentenceAround(text, start, end);
    if (!SEND_VERB.test(sentence) || !DESTINATION.test(sentence)) continue;
    const softened = !hidden && (NEGATION.test(sentence) || quotedContext(text, fences, start, end));
    mark("exfil_directive", softened ? "low" : "high");
    if (found.get("exfil_directive") === "high") break;
  }
  MD_IMAGE.lastIndex = 0;
  for (const m of text.matchAll(MD_IMAGE)) {
    const url = m[1];
    const q = url.indexOf("?");
    if (!/^https?:\/\//i.test(url) || q === -1 || !BEACON_QUERY.test(url.slice(q + 1))) continue;
    mark("exfil_directive", "high");
    break;
  }
}

/**
 * The tells in one piece of untrusted text, one entry per family at its highest
 * severity, in INJECTION_FAMILIES order. Empty when there are none.
 *
 * @param {string} raw
 * @returns {{ family: string, severity: "high" | "low" }[]}
 */
export function scanText(raw) {
  if (typeof raw !== "string" || raw.length === 0) return [];
  const { text, smuggled, invisible } = normalize(raw);
  const found = new Map();
  tellsIn(text, false, found);

  const { segments, roleAtStart } = hiddenSegments(text);
  const hidden = [...segments, ...smuggled.map((s) => normalize(s).text)];
  let hiddenTell = false;
  if (roleAtStart) {
    hiddenTell = true;
    found.set("role_markup", "high");
  }
  for (const segment of hidden) {
    const inner = new Map();
    tellsIn(segment, true, inner);
    if (inner.size === 0) continue;
    hiddenTell = true;
    for (const family of inner.keys()) found.set(family, "high");
  }
  if (hiddenTell || smuggled.length > 0) found.set("hidden_text", "high");
  else if (invisible > 0) found.set("hidden_text", "low");

  return INJECTION_FAMILIES.filter((f) => found.has(f)).map((family) => ({ family, severity: found.get(family) }));
}
