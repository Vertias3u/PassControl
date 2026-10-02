// Reads the top-level `usage` value out of a JSON response without holding the
// response.
//
// Why this exists: an embeddings response is one JSON document that can run to
// tens of megabytes (a batch of 2048 inputs × a 3072-dimension vector), and the
// provider writes the usage report as one of its top-level keys, usually last.
// Parsing the document to find it means holding all of it. This scanner walks
// the text once, tracks only nesting depth and string state, and keeps just two
// small things: the key it is reading and the `usage` value once it starts.
//
// It is not a JSON validator. It answers three questions, and each is
// conservative in the direction that charges more, never less:
//   * was exactly one top-level `usage` value present, and what was it
//     (a duplicate is ambiguous, so neither copy is used);
//   * did that value fit in USAGE_VALUE_LIMIT characters (a report bigger than
//     that is not a usage report, and holding it is what this file avoids);
//   * did the document close: one top-level object, ended, with nothing after
//     it. A body cut off mid-flight never closes.

/** Longest `usage` value kept. A real one is under 200 characters. */
export const USAGE_VALUE_LIMIT = 16 * 1024;
/** Longest top-level key kept for comparison. `usage` is five characters. */
const KEY_LIMIT = 256;

export interface TopLevelUsage {
  /** The parsed `usage` value, when exactly one was present, bounded and parseable. */
  usage?: unknown;
  /** How many top-level `usage` keys the document had. */
  usageCount: number;
  /** One top-level object, closed, with only whitespace after it. */
  documentComplete: boolean;
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const COMMA = 0x2c;
const COLON = 0x3a;

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** A raw key, as written between its quotes, is `usage` once JSON-decoded. */
function keyIsUsage(raw: string): boolean {
  if (raw === "usage") return true;
  if (!raw.includes("\\")) return false;
  try {
    return JSON.parse(`"${raw}"`) === "usage";
  } catch {
    return false;
  }
}

export class TopLevelUsageScanner {
  private depth = 0;
  private started = false;
  private closed = false;
  private invalid = false;

  private inString = false;
  private escape = false;

  /** At depth 1, the next string is a key (after `{` or `,`). */
  private expectKey = false;
  private keyCapturing = false;
  private keyRaw = "";
  private keyOverflow = false;
  private pendingUsage = false;

  private capturing = false;
  private captured = "";
  private captureOverflow = false;
  private captureEnded = false;
  private usageCount = 0;

  /** Feed the next piece of the document, already decoded to text. */
  feed(text: string): void {
    // Once the document is known not to be one closed object, nothing later can
    // make it one, so the rest of the body is not worth scanning.
    if (this.invalid) return;
    const n = text.length;
    // The next backslash in THIS text, found lazily and reused, so that skipping
    // many long strings does not search to the end of the chunk once per string.
    let nextBackslash = -2;
    let i = 0;
    while (i < n) {
      if (this.inString) {
        if (this.escape) {
          this.escape = false;
          this.append(text[i]!);
          i++;
          continue;
        }
        if (nextBackslash !== -1 && nextBackslash < i) nextBackslash = text.indexOf("\\", i);
        const quote = text.indexOf('"', i);
        const stop =
          quote === -1 ? nextBackslash : nextBackslash === -1 ? quote : Math.min(quote, nextBackslash);
        if (stop === -1) {
          this.append(text.slice(i));
          return;
        }
        if (stop > i) this.append(text.slice(i, stop));
        i = stop;
        if (text.charCodeAt(i) === BACKSLASH) {
          this.escape = true;
          this.append("\\");
        } else {
          this.inString = false;
          if (this.keyCapturing) this.endKey();
          else if (this.capturing) this.appendCapture('"');
        }
        i++;
        continue;
      }

      const code = text.charCodeAt(i);
      if (isWhitespace(code)) {
        if (this.capturing) this.appendCapture(text[i]!);
        i++;
        continue;
      }
      if (!this.started) {
        if (code !== OPEN_BRACE) {
          this.invalid = true;
          return;
        }
        this.started = true;
        this.depth = 1;
        this.expectKey = true;
        i++;
        continue;
      }
      if (this.closed) {
        this.invalid = true;
        return;
      }

      switch (code) {
        case QUOTE:
          this.inString = true;
          if (this.depth === 1 && this.expectKey && !this.capturing) {
            this.keyCapturing = true;
            this.keyRaw = "";
            this.keyOverflow = false;
          } else if (this.capturing) {
            this.appendCapture('"');
          }
          break;
        case OPEN_BRACE:
        case OPEN_BRACKET:
          if (this.capturing) this.appendCapture(text[i]!);
          this.depth++;
          break;
        case CLOSE_BRACE:
        case CLOSE_BRACKET:
          if (this.depth === 1) {
            if (this.capturing) this.endCapture();
            this.depth = 0;
            this.closed = true;
            if (code !== CLOSE_BRACE) this.invalid = true;
          } else {
            if (this.capturing) this.appendCapture(text[i]!);
            this.depth--;
          }
          break;
        case COMMA:
          if (this.depth === 1) {
            if (this.capturing) this.endCapture();
            this.expectKey = true;
          } else if (this.capturing) {
            this.appendCapture(",");
          }
          break;
        case COLON:
          if (this.depth === 1 && !this.capturing) {
            if (this.pendingUsage) this.startCapture();
            this.pendingUsage = false;
          } else if (this.capturing) {
            this.appendCapture(":");
          }
          break;
        default:
          if (this.capturing) this.appendCapture(text[i]!);
      }
      i++;
    }
  }

  finish(): TopLevelUsage {
    const documentComplete = this.started && this.closed && !this.invalid && !this.inString;
    const result: TopLevelUsage = { usageCount: this.usageCount, documentComplete };
    if (this.usageCount === 1 && this.captureEnded && !this.captureOverflow) {
      try {
        result.usage = JSON.parse(this.captured);
      } catch {
        // Present but not JSON: reported by usageCount, used by nobody.
      }
    }
    return result;
  }

  /** Characters held right now. Bounded by KEY_LIMIT + USAGE_VALUE_LIMIT. */
  retainedChars(): number {
    return this.keyRaw.length + this.captured.length;
  }

  private append(text: string): void {
    if (this.keyCapturing) {
      if (this.keyRaw.length + text.length > KEY_LIMIT) {
        this.keyOverflow = true;
        this.keyRaw = "";
      } else if (!this.keyOverflow) {
        this.keyRaw += text;
      }
    } else if (this.capturing) {
      this.appendCapture(text);
    }
  }

  private endKey(): void {
    this.keyCapturing = false;
    this.expectKey = false;
    this.pendingUsage = !this.keyOverflow && keyIsUsage(this.keyRaw);
    this.keyRaw = "";
  }

  private startCapture(): void {
    this.usageCount++;
    this.capturing = true;
    this.captured = "";
    this.captureOverflow = false;
    this.captureEnded = false;
  }

  private appendCapture(text: string): void {
    if (this.captureOverflow) return;
    if (this.captured.length + text.length > USAGE_VALUE_LIMIT) {
      this.captureOverflow = true;
      this.captured = "";
      return;
    }
    this.captured += text;
  }

  private endCapture(): void {
    this.capturing = false;
    this.captureEnded = true;
  }
}
