// This deployment's own origin, for the dashboard link in an alert sent from a
// server action (the gateway uses new URL(req.url).origin instead).
//
// A server action arrives with an Origin header that Next checks against the
// Host before running the action, so it is the first choice. Anything that is
// not a bare http(s) origin is refused rather than repaired: the result goes
// into a link in someone's chat channel.
export function originFromHeaders(headers: Headers): string | null {
  const origin = headers.get("origin");
  if (origin) {
    try {
      const url = new URL(origin);
      if ((url.protocol === "https:" || url.protocol === "http:") && url.origin === origin) return url.origin;
    } catch {
      // fall through to the host
    }
  }
  const host = headers.get("host") ?? "";
  if (!/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/u.test(host)) return null;
  const proto = headers.get("x-forwarded-proto") === "http" ? "http" : "https";
  return `${proto}://${host}`;
}
