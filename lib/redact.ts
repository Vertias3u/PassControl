/**
 * Secret-shaped-value redaction for free text.
 *
 * These patterns were module-private inside lib/observability.ts, where they
 * scrub Sentry events. They live here now because a second caller needs them —
 * problem reports, the one durable table in the product whose contents a human
 * types by hand. One definition means a pattern added for either caller
 * protects both; two copies would drift on the first addition.
 *
 * The doctrine everywhere else in this codebase is to CONSTRUCT from an
 * allowlist rather than scrub a blob — see buildCloudSupportBundle, which never
 * serializes a database row so a future secret-bearing column cannot leak by
 * being added to a SELECT. That is the stronger guarantee and it is unavailable
 * here: nobody can allowlist the sentences a person writes. Pattern scrubbing
 * is the weaker second layer, used only where the first one cannot reach.
 */
import { sanitizeValue } from "./seclog";

/**
 * Ordered from most specific to least. The last entry is a deliberate
 * catch-all: any unbroken 40+ character token-shaped run. It will also eat a
 * base64 blob or a 40-character commit sha that someone pasted on purpose, and
 * that is the correct trade for a table that must never hold a credential —
 * a report reading "[redacted]" where a sha was is a small cost, a report
 * holding a live key is an incident. Do not "fix" this by narrowing it.
 */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9._-]{6,}\b/g,
  /\bpc_[A-Za-z0-9._-]{6,}\b/g,
  // Google/Gemini API keys are normally 39 characters, so the generic 40+
  // catch-all below cannot protect them. Keep this provider-specific guard.
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];

/**
 * Does this string contain something secret-shaped?
 *
 * Callers that want to REFUSE a value rather than scrub it need this, and the
 * obvious spelling of it is a live bug:
 *
 *     SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))   // WRONG
 *
 * Every pattern above is `/g`, and `.test()` on a `/g` regex persists
 * `lastIndex` on the shared regex object after a match. The array is module
 * state: one per isolate, shared by every request and every operator. So a
 * value that matches at offset 75 parks `lastIndex` at 114, and the NEXT value
 * carrying the same class of credential is tested from offset 114 — it misses,
 * returns false, and is accepted. The checks alternate: refuse, accept, refuse.
 *
 * That is not a theoretical hazard — it shipped, and every second value
 * bearing a credential was accepted and stored verbatim. The exposure window is
 * a credential long enough to match its own provider pattern but shorter than
 * the 40-character catch-all that would otherwise catch it on a second pass —
 * a 39-character Gemini key sits exactly there.
 *
 * `lastIndex` is therefore reset on both sides of every test, so the shared
 * objects are left exactly as they were found. Use this instead of `.test()`;
 * `.replace()` is already safe (it zeroes `lastIndex` itself) and needs no
 * equivalent.
 *
 * NOT implemented as `redactSecrets(value) !== value`: that reports true for a
 * value whose only change was the control-character strip, which would refuse
 * an operator's reason for containing a tab.
 */
export function containsSecret(value: string): boolean {
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    const hit = pattern.test(value);
    pattern.lastIndex = 0;
    if (hit) return true;
  }
  return false;
}

/**
 * Replace every secret-shaped run with `[redacted]`, and strip control
 * characters that could smuggle terminal escapes into whatever renders the
 * text. Newlines survive: in a bug report they are content (stack traces,
 * numbered steps), and nothing here is written to a log line, so the
 * log-injection reasoning behind sanitizeValue's CR/LF strip does not apply.
 *
 * Deliberately does NOT bound length. `sanitizeValue` caps a string at 256
 * characters, which is right for a log field and wrong for a 4000-character
 * report — an operator would read the truncation as the whole report. Callers
 * that want both compose them, as redactLogString below does.
 *
 * `String.replace` with a /g regex resets lastIndex itself, so these shared
 * patterns are safe to reuse across calls. `.test()` on them would not be.
 */
export function redactSecrets(value: string): string {
  let out = value.replace(/[\r\t\x00-\x09\x0b-\x1f\x7f]/g, " ");
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

/**
 * The log-field variant: bounded and single-line, for values that become part
 * of a structured log entry or a Sentry field. This is the behaviour
 * lib/observability.ts has always had.
 */
export function redactLogString(value: string): string {
  let out = String(sanitizeValue(value));
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}
