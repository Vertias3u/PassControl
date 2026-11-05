// The secret guard: keys must not leave in a prompt, and should not come back in an answer
// (owner, 2026-10-08; tests/secret-guard.test.ts carries the measurements).
//
// What it catches: provider keys (Anthropic, OpenAI, OpenRouter, Groq, xAI, Hugging Face),
// GitHub, AWS, Google, Slack, Stripe, Telegram and Notion tokens, private key blocks,
// PassControl's own Direct Agent Keys and control keys, and a passport secret where it
// is named as one. A bare 43-character base64url string is not flagged: it is exactly
// what a passport ID looks like.
//
// What it leaves alone, and why each rule exists: the committed public demo credentials
// (exact values), and strings that are plainly made up. Every rule below was needed by a
// real fixture in this repo; none dismisses a string drawn at random.
//
// Never stored: a finding is a kind and a JSON path. The secret itself goes nowhere but
// the redacted body's placeholder, which carries a keyed 32-bit fingerprint (so two keys
// can be told apart) and never the key.
//
// Patterns are anchored on a fixed prefix with bounded quantifiers. That alone did not
// keep the scan linear (cloud review 2026-11-03, B3): the private-key rule read 16 KB
// past every bare header, and every match was compared with every earlier one. Both are
// now found in one pass; `tests/secret-guard.test.ts` times the hostile shapes.
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { publiclyCommittedDemoValues } from "@/lib/demo/identity";

export type SecretKind =
  | "anthropic"
  | "openai"
  | "openrouter"
  | "groq"
  | "xai"
  | "github"
  | "github_fine"
  | "aws"
  | "google"
  | "slack"
  | "stripe"
  | "huggingface"
  | "passcontrol_agent"
  | "passcontrol_control"
  | "passport_secret"
  | "telegram"
  | "notion"
  | "private_key";

export interface SecretFinding {
  kind: SecretKind;
  /** Where in the body, e.g. `messages[3].content[0].text`. Never the value. */
  path: string;
}

// Order matters only for overlapping prefixes: OpenRouter's `sk-or-v1-` before OpenAI's
// legacy `sk-`, and a Direct Agent Key before the general control-key shape.
const RULES: readonly (readonly [SecretKind, RegExp])[] = [
  ["anthropic", /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,120}/g],
  ["openrouter", /\bsk-or-v1-[a-f0-9]{64}\b/g],
  ["openai", /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,200}/g],
  ["openai", /\bsk-[A-Za-z0-9]{48}(?![A-Za-z0-9_-])/g],
  ["groq", /\bgsk_[A-Za-z0-9]{52}\b/g],
  ["xai", /\bxai-[A-Za-z0-9]{80}\b/g],
  ["github", /\bgh[pousr]_[A-Za-z0-9]{36}\b/g],
  ["github_fine", /\bgithub_pat_[A-Za-z0-9_]{82}\b/g],
  ["aws", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["google", /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g],
  ["slack", /\bxox[abposr]-[A-Za-z0-9-]{10,200}/g],
  ["stripe", /\b[sr]k_live_[A-Za-z0-9]{24,99}\b/g],
  ["huggingface", /\bhf_[A-Za-z]{34}\b/g],
  ["passcontrol_agent", /\bpc_agent_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g],
  ["passcontrol_control", /\bpc_(?!agent_)[A-Za-z0-9_-]{32,80}(?![A-Za-z0-9_-])/g],
  ["passport_secret", /PASSPORT_SECRET\s{0,4}[=:]\s{0,4}["']?[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g],
  ["telegram", /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g],
  ["notion", /\b(?:secret_|ntn_)[A-Za-z0-9]{43,50}\b/g],
  // Detection is the header; redaction takes the whole block (bounded). The regex is
  // the definition; `privateKeyMatches` finds what it would, without its cost.
  ["private_key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----(?:[\s\S]{0,16384}?-----END (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----)?/g],
];

/** Committed on purpose for the keyless demo (lib/demo/identity.ts): public, not secrets. */
const PUBLIC_VALUES: readonly string[] = publiclyCommittedDemoValues();

// Long give-away words count anywhere: seven random characters spelling "example" do not
// happen. Short ones count only as a separate word (`-ECHO_TEST`), because four random
// characters can spell "test" inside a real key, and dismissing a real key is the
// failure that matters.
const FAKE_WORDS = /example|dummy|placeholder|redacted|not-ours|your[_-]?key/i;
const FAKE_SHORT_WORDS = /(?:^|[_\-:.])(?:test|echo|sample|fake|xxxx)(?:$|[_\-:.])/i;

/** The part after a known prefix, which is what a fake gives itself away in. */
function payloadOf(match: string): string {
  const cut = /^(?:sk-ant-(?:api|admin)\d{2}-|sk-or-v1-|sk-(?:proj|svcacct|admin)-|sk-|gsk_|xai-|gh[pousr]_|github_pat_|AKIA|ASIA|AIza|xox[abposr]-|[sr]k_live_|hf_|pc_agent_|pc_|secret_|ntn_)/.exec(match);
  return cut ? match.slice(cut[0].length) : match;
}

/** Whether a match is plainly made up. Each rule here was needed by a real fixture. */
function looksMadeUp(match: string): boolean {
  if (FAKE_WORDS.test(match) || FAKE_SHORT_WORDS.test(match)) return true;
  const telegram = /^(\d{8,10}):AA/.exec(match);
  if (telegram && isCounting(telegram[1]!)) return true;
  const body = payloadOf(match);
  if (/(.)\1{5,}/.test(body)) return true;
  if (isCounting(body)) return true;
  // An alphabet walk with digits mixed in ("Ab3dEf6hIj9kLm…"): its letters ascend.
  const letters = body.toLowerCase().replace(/[^a-z]/g, "");
  if (letters.length >= 12) {
    let up = 0;
    for (let i = 1; i < letters.length; i++) if (letters.charCodeAt(i) > letters.charCodeAt(i - 1)) up++;
    if (up / (letters.length - 1) >= 0.85) return true;
  }
  return new Set(body).size < 10;
}

/** "0123456789abcdef…": most neighbours one apart. */
function isCounting(s: string): boolean {
  if (s.length < 8) return false;
  let steps = 0;
  for (let i = 1; i < s.length; i++) if (s.charCodeAt(i) === s.charCodeAt(i - 1) + 1) steps++;
  return steps / (s.length - 1) > 0.4;
}

function isPublic(match: string): boolean {
  return PUBLIC_VALUES.some((value) => match.includes(value));
}

// The private-key rule's two halves, for `privateKeyMatches` below.
const PEM_HEADER = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g;
const PEM_END = /-----END (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/g;
const PEM_REACH = 16_384;

/**
 * What `text.matchAll` gives for the private-key rule in RULES, found without it.
 *
 * The rule's lazy `[\s\S]{0,16384}?` read up to 16 KB ahead of EVERY header that had no
 * END, so a body of bare headers cost 16 KB a header: 4.65 s for 1.1 MB (cloud review
 * 2026-11-03, B3). The block's end is the first END of any variant that starts within
 * 16,384 characters of the header's end. That first END is found by one search and
 * reused for every header before it, so each part of the text is searched about once.
 * Same matches, same order, same non-overlap: `tests/secret-guard.test.ts` pins the edges.
 */
function* privateKeyMatches(text: string): Generator<{ value: string; index: number }> {
  PEM_HEADER.lastIndex = 0;
  // The first END at or after `endFrom`: its start, or -1 for none left in the text.
  let endFrom = -1;
  let endAt = -1;
  let endLength = 0;
  for (let h = PEM_HEADER.exec(text); h; h = PEM_HEADER.exec(text)) {
    const headerEnd = h.index + h[0].length;
    if (endFrom === -1 || (endAt !== -1 && endAt < headerEnd)) {
      PEM_END.lastIndex = headerEnd;
      const e = PEM_END.exec(text);
      endFrom = headerEnd;
      endAt = e ? e.index : -1;
      endLength = e ? e[0].length : 0;
    }
    const end = endAt !== -1 && endAt - headerEnd <= PEM_REACH ? endAt + endLength : headerEnd;
    yield { value: text.slice(h.index, end), index: h.index };
    PEM_HEADER.lastIndex = end;
  }
}

interface Match { kind: SecretKind; start: number; end: number; value: string }

/**
 * Every real-looking secret in one string, in order.
 *
 * A later rule's match that overlaps an earlier rule's is the same secret, and is
 * dropped. That was a comparison with every match so far, which made 100,000 repeats
 * of one key cost 8.5 s (B3). One rule's matches arrive in order and never overlap
 * each other, so each is checked against the sorted matches of the rules before it
 * with one moving cursor, then merged in: linear per rule, same answer.
 */
function matchesIn(text: string): Match[] {
  let kept: Match[] = [];
  for (const [kind, re] of RULES) {
    re.lastIndex = 0;
    const found = kind === "private_key" ? privateKeyMatches(text) : text.matchAll(re);
    const added: Match[] = [];
    let cursor = 0;
    for (const m of found) {
      const value = "value" in m ? m.value : m[0];
      if (isPublic(value) || looksMadeUp(value)) continue;
      const start = m.index ?? 0;
      const end = start + value.length;
      // Earlier rules' matches are disjoint and sorted, so their ends ascend too: skip
      // those that end at or before this start; the next one overlaps iff it starts
      // before this end.
      while (cursor < kept.length && kept[cursor]!.end <= start) cursor++;
      if (cursor < kept.length && kept[cursor]!.start < end) continue;
      added.push({ kind, start, end, value });
    }
    if (added.length) kept = mergeByStart(kept, added);
  }
  return kept;
}

function mergeByStart(a: Match[], b: Match[]): Match[] {
  const out: Match[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(a[i]!.start <= b[j]!.start ? a[i++]! : b[j++]!);
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

/** A string that is base64 media, not text: never scanned, never changed. */
function isMedia(key: string, value: string, parent: Record<string, unknown>): boolean {
  return (key === "data" && parent.type === "base64") || key === "file_data" || value.startsWith("data:");
}

const pathKey = (base: string, key: string) => (base ? `${base}.${key}` : key);

function walk(
  value: unknown,
  path: string,
  depth: number,
  visit: (text: string, path: string) => string | null
): unknown {
  if (depth > 64 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    value.forEach((item, i) => {
      const p = `${path}[${i}]`;
      const next = typeof item === "string" ? (visit(item, p) ?? item) : walk(item, p, depth + 1, visit);
      if (next !== item) (copy ??= [...value])[i] = next;
    });
    return copy ?? value;
  }
  const o = value as Record<string, unknown>;
  let copy: Record<string, unknown> | null = null;
  for (const [key, item] of Object.entries(o)) {
    const p = pathKey(path, key);
    let next: unknown = item;
    if (typeof item === "string") {
      if (!isMedia(key, item, o)) next = visit(item, p) ?? item;
    } else {
      next = walk(item, p, depth + 1, visit);
    }
    if (next !== item) (copy ??= { ...o })[key] = next;
  }
  return copy ?? value;
}

/** Every secret in a request body, as kind and path. Base64 media is skipped. */
export function findSecrets(body: unknown): SecretFinding[] {
  const findings: SecretFinding[] = [];
  walk(body, "", 0, (text, path) => {
    for (const m of matchesIn(text)) findings.push({ kind: m.kind, path });
    return null;
  });
  return findings;
}

/**
 * `[SECRET_REDACTED:<kind>:<8 hex>]`: the same secret always gives the same placeholder,
 * so a conversation re-sent on every call keeps the same bytes (Claude Code's prompt
 * cache prefix survives); the fingerprint is keyed, so it reveals nothing about the key.
 * No quotes or backslashes, so it is safe inside JSON.
 */
function placeholder(kind: SecretKind, secret: string, fingerprintKey: string): string {
  const mac = hmac(sha256, new TextEncoder().encode(fingerprintKey), new TextEncoder().encode(secret));
  const fp = Array.from(mac.subarray(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
  return `[SECRET_REDACTED:${kind}:${fp}]`;
}

function redactText(text: string, fingerprintKey: string): { text: string; kinds: SecretKind[] } {
  const matches = matchesIn(text);
  if (matches.length === 0) return { text, kinds: [] };
  let out = "";
  let at = 0;
  for (const m of matches) {
    out += text.slice(at, m.start) + placeholder(m.kind, m.value, fingerprintKey);
    at = m.end;
  }
  return { text: out + text.slice(at), kinds: matches.map((m) => m.kind) };
}

/**
 * The body with every secret replaced by its placeholder, and what was found. The SAME
 * object when nothing was, so an ordinary call is untouched.
 */
export function redactSecrets<T>(body: T, fingerprintKey: string): { value: T; findings: SecretFinding[] } {
  const findings: SecretFinding[] = [];
  const value = walk(body, "", 0, (text, path) => {
    const r = redactText(text, fingerprintKey);
    if (r.kinds.length === 0) return null;
    for (const kind of r.kinds) findings.push({ kind, path });
    return r.text;
  }) as T;
  return { value, findings };
}

/** A provider's buffered answer, as text: secrets replaced, kinds reported. */
export function redactSecretsInText(text: string, fingerprintKey: string): { text: string; findings: SecretKind[] } {
  const r = redactText(text, fingerprintKey);
  return { text: r.text, findings: r.kinds };
}

/**
 * For a streamed answer, which arrives as fragments a few characters long: the text is
 * reassembled in a bounded window and scanned as it grows. It DETECTS; it does not
 * redact mid-stream (v1), so a finding is reported after the fact.
 */
export function createStreamSecretDetector(): {
  push(fragment: string): void;
  findings(): SecretKind[];
} {
  // Scanned in steps, keeping a tail longer than any key, so a key arriving across a
  // step is still seen whole, and the work stays linear in the answer's length.
  const STEP = 1024;
  const TAIL = 300;
  let window = "";
  const found = new Set<string>();
  const kinds: SecretKind[] = [];
  const scan = () => {
    for (const m of matchesIn(window)) {
      const id = `${m.kind}:${m.value}`;
      if (!found.has(id)) {
        found.add(id);
        kinds.push(m.kind);
      }
    }
  };
  return {
    push(fragment) {
      if (!fragment) return;
      window += fragment;
      if (window.length < STEP) return;
      scan();
      window = window.slice(-TAIL);
    },
    findings() {
      scan();
      return [...kinds];
    },
  };
}

/** The kinds found, de-duplicated, in order: what a log or event may say. */
export function secretKinds(findings: readonly { kind: SecretKind }[]): SecretKind[] {
  return [...new Set(findings.map((f) => f.kind))];
}

/**
 * The refusal a blocked call gets: what was found and where (never the value), and how
 * to get the session going again. A coding agent re-sends the whole conversation on every
 * call, so the key has to leave the history, not only the next message.
 */
export function secretRefusalMessage(findings: readonly SecretFinding[]): string {
  const where = findings
    .slice(0, 3)
    .map((f) => `${f.kind} at ${f.path}`)
    .join(", ");
  const more = findings.length > 3 ? ` and ${findings.length - 3} more` : "";
  return (
    `PassControl refused this call: it carries what looks like a secret (${where}${more}). Nothing was sent. ` +
    "Remove it from the conversation: Claude Code and Codex re-send the whole history on every call, so use /rewind " +
    "(or /clear) to go back to before it appeared. The agent's owner can switch this check to replace keys with a " +
    "placeholder instead of refusing."
  );
}

// Where a streamed answer carries the model's words, per provider shape: Anthropic's
// `delta.text` / `delta.partial_json` (tool input) / `delta.thinking`, OpenAI chat's
// `choices[].delta.content` and tool-call `arguments`, and the Responses API's string
// `delta`. Collected by key, so a shape this list does not name is still read.
const STREAM_TEXT_KEYS = new Set(["text", "partial_json", "thinking", "content", "arguments", "delta"]);

function streamFragments(event: unknown, out: string[], depth = 0): void {
  if (depth > 8 || event === null || typeof event !== "object") return;
  if (Array.isArray(event)) {
    for (const item of event) streamFragments(item, out, depth + 1);
    return;
  }
  for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
    if (typeof value === "string") {
      if (STREAM_TEXT_KEYS.has(key)) out.push(value);
    } else {
      streamFragments(value, out, depth + 1);
    }
  }
}

/**
 * A pass-through for a streamed answer that reports the kinds of secret the model wrote,
 * once, when the stream ends. Every byte goes through unchanged: v1 detects in streams,
 * it does not redact them (a buffered answer is redacted instead).
 */
export function createSecretWatchStream(onFindings: (kinds: SecretKind[]) => void): TransformStream<Uint8Array, Uint8Array> {
  const detector = createStreamSecretDetector();
  const decoder = new TextDecoder();
  let buffer = "";
  const feed = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const fragments: string[] = [];
      streamFragments(JSON.parse(data), fragments);
      for (const fragment of fragments) detector.push(fragment);
    } catch {
      // Not JSON: nothing the model wrote that this can read.
    }
  };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      try {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          feed(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
        // A runaway line without a newline is not an SSE event; drop it rather than grow.
        if (buffer.length > 1_000_000) buffer = "";
      } catch {
        // Detection must never break the answer.
      }
    },
    flush() {
      try {
        if (buffer) feed(buffer);
        const kinds = detector.findings();
        if (kinds.length > 0) onFindings(kinds);
      } catch {
        // As above.
      }
    },
  });
}
