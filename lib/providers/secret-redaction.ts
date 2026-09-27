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
// It removes the EXACT key (and its JSON-escaped spelling, which differs only
// when the key contains "/"). It cannot recognise a key an upstream has
// transformed — base64'd, truncated, split by other text. Those are not the
// reflection shapes seen, and chasing them would mean guessing at every byte
// that passes through. The guarantee is narrow and exact: the bytes of the key
// PassControl sent do not appear in what it returns.
//
// ── Why the stream holds back only a key PREFIX ─────────────────────────────
// A key can arrive split across chunks at any byte. The simple fix — always
// hold back the last (key length − 1) bytes — delays every SSE event until the
// next one arrives, so a streaming client would see each token one event late.
// Instead only a tail that could still BECOME the key is held: an SSE chunk
// ends in "\n\n", which begins no provider key, so ordinary output passes with
// no added delay and only a genuine partial match waits for the next chunk.

/** What an echoed key becomes. No quotes or backslashes, so JSON stays valid. */
export const PROVIDER_KEY_REDACTION = "[REDACTED_PROVIDER_KEY]";

/**
 * Shorter than any provider key PassControl stores. Replacing a short value
 * everywhere would corrupt ordinary output, and nothing that short is a key.
 */
const MIN_SECRET_LENGTH = 16;

/** The spellings of `key` to remove: itself, plus its JSON-escaped form if different. */
export function secretsToRedact(key: string | null | undefined): string[] {
  if (typeof key !== "string" || key.length < MIN_SECRET_LENGTH) return [];
  const escaped = JSON.stringify(key).slice(1, -1).replaceAll("/", "\\/");
  return escaped === key ? [key] : [key, escaped];
}

export function redactSecretsInText(text: string, secrets: readonly string[]): { text: string; redacted: boolean } {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.replaceAll(secret, PROVIDER_KEY_REDACTION);
  }
  return { text: out, redacted: out !== text };
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** Longest k < needle.length such that the last k bytes of `buf` are needle's first k. */
function heldPrefixLength(buf: Uint8Array, needle: Uint8Array): number {
  const max = Math.min(needle.length - 1, buf.length);
  for (let k = max; k > 0; k--) {
    let match = true;
    for (let j = 0; j < k; j++) {
      if (buf[buf.length - k + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) return k;
  }
  return 0;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Byte stream → byte stream with every occurrence of every secret replaced.
 * Works on bytes, not decoded text, so a multi-byte character split across
 * chunks is never re-encoded. `onRedact` fires once, on the first replacement.
 */
export function redactingStream(
  secrets: readonly string[],
  onRedact?: () => void
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const needles = secrets.filter(Boolean).map((s) => encoder.encode(s));
  const replacement = encoder.encode(PROVIDER_KEY_REDACTION);
  let pending: Uint8Array = new Uint8Array(0);
  let reported = false;

  const replaceAll = (buf: Uint8Array): Uint8Array => {
    let current = buf;
    for (const needle of needles) {
      let at = indexOf(current, needle, 0);
      if (at === -1) continue;
      const parts: Uint8Array[] = [];
      let start = 0;
      while (at !== -1) {
        parts.push(current.subarray(start, at), replacement);
        start = at + needle.length;
        at = indexOf(current, needle, start);
      }
      parts.push(current.subarray(start));
      const total = parts.reduce((n, p) => n + p.length, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const p of parts) {
        joined.set(p, offset);
        offset += p.length;
      }
      current = joined;
      if (!reported) {
        reported = true;
        onRedact?.();
      }
    }
    return current;
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (needles.length === 0) {
        controller.enqueue(chunk);
        return;
      }
      const buf = replaceAll(concat(pending, chunk));
      const hold = Math.max(0, ...needles.map((n) => heldPrefixLength(buf, n)));
      const emit = buf.subarray(0, buf.length - hold);
      pending = buf.slice(buf.length - hold);
      if (emit.length > 0) controller.enqueue(emit);
    },
    flush(controller) {
      // Whatever is held could not complete a key: the stream ended.
      if (pending.length > 0) controller.enqueue(pending);
      pending = new Uint8Array(0);
    },
  });
}
