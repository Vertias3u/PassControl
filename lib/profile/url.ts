// The operator's website link — the only operator-controlled string this
// feature renders as an `href` on a page a stranger reads.
//
// 0033 backs this with `users_website_url_scheme check (website_url ~
// '^https?://')`, so a bypass here is unstorable. But a CHECK constraint sees a
// string, not a URL, and two real attacks start with `https://`:
//
//   https://vertias.eu@evil.example/   — the authority's userinfo. Reads as
//                                        vertias.eu to a human scanning the
//                                        link text; navigates to evil.example.
//   //evil.example/path                — protocol-relative. Not accepted by the
//                                        constraint, but it is the shape a
//                                        "just prepend https://" helper turns
//                                        into `https:////evil.example`.
//
// So the constraint is the backstop and this is the control. Rendering adds the
// third layer: `rel="nofollow ugc noopener noreferrer"` at the call site.
//
// Whitespace and NULs are stripped-then-rejected rather than ignored, because
// browsers remove them before parsing a URL and validators generally do not —
// `java\nscript:` is how a scheme check gets walked past.

/** Matches 0033's `users_website_url_len`. */
export const WEBSITE_URL_MAX_LENGTH = 200;

/** A leading scheme, if the operator typed one. */
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

/** Anything a browser would strip before parsing. Presence means obfuscation. */
const CONTROL_OR_SPACE_RE = /[\u0000-\u0020\u007f-\u009f\u2028\u2029]/;

/**
 * A hostname a stranger could actually resolve. Requires a dot, which rules out
 * `localhost` and bare intranet names — a public profile linking to `http://nas`
 * is a broken link at best and an SSRF-flavoured curiosity at worst.
 */
const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export type WebsiteUrlResult =
  | { ok: true; url: string | null }
  | { ok: false; reason: "invalid_url" };

/**
 * Normalise an operator-supplied website into something safe to render, or
 * refuse it.
 *
 * Blank input is `{ ok: true, url: null }` — clearing the field is a legitimate
 * edit, not an error.
 */
export function normalizeWebsiteUrl(value: unknown): WebsiteUrlResult {
  if (typeof value !== "string") return { ok: true, url: null };
  const raw = value.trim();
  if (!raw) return { ok: true, url: null };

  // After trimming the ends, any remaining whitespace or control character is
  // deliberate. Reject rather than strip: stripping would silently turn a
  // hostile string into a different, accepted one.
  if (CONTROL_OR_SPACE_RE.test(raw)) return { ok: false, reason: "invalid_url" };
  if (raw.length > WEBSITE_URL_MAX_LENGTH) return { ok: false, reason: "invalid_url" };

  const scheme = SCHEME_RE.exec(raw);
  let candidate: string;
  if (scheme) {
    // Decide on the scheme the operator actually typed, before URL parsing gets
    // a chance to reinterpret it.
    if (!/^https?$/i.test(scheme[1]!)) return { ok: false, reason: "invalid_url" };
    candidate = raw;
  } else {
    // `//evil.example` inherits whatever scheme the page was served over. It is
    // not a bare domain, and prepending https:// to it would produce a URL
    // pointing somewhere the operator did not type.
    if (raw.startsWith("//")) return { ok: false, reason: "invalid_url" };
    candidate = `https://${raw}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "invalid_url" };
  }
  // The disguised-host attack. There is no legitimate reason for a profile link
  // to carry credentials, and the only thing they do here is hide the real host.
  if (url.username || url.password) return { ok: false, reason: "invalid_url" };
  if (!HOSTNAME_RE.test(url.hostname)) return { ok: false, reason: "invalid_url" };

  const normalized = url.toString();
  // Serialising can lengthen the string (a bare domain gains `https://` and a
  // trailing slash), so the column bound is re-checked on the value that will
  // actually be written.
  if (normalized.length > WEBSITE_URL_MAX_LENGTH) return { ok: false, reason: "invalid_url" };

  return { ok: true, url: normalized };
}
