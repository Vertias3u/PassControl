// The gateway rule, shared by both credential-bearing SDK clients.
//
// `PassControl` carries a short-lived visa and `ControlClient` carries a
// long-lived `pc_` control-plane key, but the question each one asks of its
// `gateway` option is identical: *is this a destination I may hand a bearer
// credential to?* That answer used to exist in one client and not the other —
// ControlClient accepted any non-empty string and concatenated it — so this file
// exists to make drift between the two impossible rather than merely unlikely.
//
// It is internal. `sdk/index.ts` deliberately does not re-export it, and the
// generated package's `exports` map exposes only `./sdk`, so no consumer gains a
// new supported surface from it.

/**
 * The only hosts allowed to speak plain HTTP.
 *
 * Deliberately an exact-match set, never a prefix, suffix or regex: `localhost.`,
 * `localhost.example` and `127.0.0.1.attacker.example` are all *someone else's*
 * hostnames that a looser test would read as local. Docker service names,
 * `host.docker.internal` and LAN addresses are excluded on purpose — they are
 * real networks, and a credential crossing one in cleartext is on the wire.
 * Matched against the parsed `hostname`, which the URL parser has already
 * lowercased and canonicalised (`127.1` → `127.0.0.1`, `[0:0:0:0:0:0:0:1]` →
 * `[::1]`), so shorthand spellings of loopback resolve here instead of slipping
 * past a string comparison.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validate a `gateway` option and return the origin to build URLs from.
 *
 * Accepts a **bare HTTPS origin** — scheme, host, optional port — with nothing
 * else attached: no path beyond `/`, no query, no fragment, and no embedded
 * username or password. HTTP is accepted only on the loopback hosts above.
 *
 * The value is parsed, then the return value is re-derived from `URL.origin`
 * rather than echoed back. That is what stops attacker-controlled path material
 * from surviving into a later concatenation, and it is why a deceptive
 * `https://trusted.example@attacker.example` cannot be laundered into looking
 * like the trusted host: the parser assigns `trusted.example` to `username`, and
 * userinfo is rejected outright.
 *
 * Throws synchronously, and the message never quotes the offending value — a
 * rejected gateway can itself contain a credential (`https://user:pass@host`),
 * and a refusal that lands in a log should not be the thing that leaks it.
 *
 * @param clientName Prefix for the thrown message, so the caller can tell which
 *   client refused (`PassControl` / `ControlClient`).
 */
export function requireGatewayOrigin(clientName: string, gateway: string): string {
  let url: URL;
  try {
    url = new URL(gateway);
  } catch {
    throw new Error(`${clientName}: gateway must be an absolute URL.`);
  }
  const loopback = LOOPBACK_HOSTNAMES.has(url.hostname);
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      `${clientName}: gateway must be a bare HTTPS origin (HTTP is allowed only for localhost).`
    );
  }
  return url.origin;
}
