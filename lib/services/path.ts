// The path an agent asked a service for: decoded once, checked, re-encoded.
//
// Read from the request URL's PATHNAME, not from Next's route params, so what
// is matched and what is sent cannot come from two different parsers. The
// WHATWG URL parser has already resolved literal `.`/`..` segments by the time a
// pathname exists; this refuses anything that DECODES to a separator or a dot
// segment, then re-encodes every segment for the upstream URL. The invariant is
// that the segments a rule matched are exactly the segments sent upstream
// (plans/any-api-credentials.md T2).

export const MAX_PATH_SEGMENTS = 32;
export const MAX_SEGMENT_LENGTH = 256;

export type ServicePath =
  | {
      ok: true;
      /** Decoded segments, as rules are matched against them. */
      segments: string[];
      /** Leading slash, each segment re-encoded. Appended to the catalog origin. */
      upstreamPath: string;
    }
  | { ok: false; reason: string };

// Anything that is a separator, a dot segment or a control character once
// decoded. `%` survives decoding only from a double encoding, which is a legal
// literal name and is re-encoded as such.
function badDecodedSegment(segment: string): boolean {
  return (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.length > MAX_SEGMENT_LENGTH ||
    /[/\\]/u.test(segment) ||
    // Control characters, including NUL and DEL.
    /[\u0000-\u001f\u007f]/u.test(segment)
  );
}

export function parseServicePath(pathname: string, service: string): ServicePath {
  const prefix = `/api/v1/svc/${service}`;
  if (!pathname.startsWith(`${prefix}/`)) return { ok: false, reason: "not_this_service" };
  const rest = pathname.slice(prefix.length + 1);
  if (!rest) return { ok: false, reason: "no_path" };
  const raw = rest.split("/");
  if (raw.length > MAX_PATH_SEGMENTS) return { ok: false, reason: "too_deep" };

  const segments: string[] = [];
  for (const piece of raw) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(piece);
    } catch {
      return { ok: false, reason: "bad_escape" };
    }
    if (badDecodedSegment(decoded)) return { ok: false, reason: "bad_segment" };
    segments.push(decoded);
  }
  return {
    ok: true,
    segments,
    upstreamPath: `/${segments.map((s) => encodeURIComponent(s)).join("/")}`,
  };
}
