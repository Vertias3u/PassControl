// Destination policy for the sidecar's forward-proxy front door.
//
// Everything else in the sidecar routes to a destination WE configured. This
// module is the one place that judges a destination the CLIENT chose, which is
// what `HTTPS_PROXY=http://127.0.0.1:8788` turns every agent request into. Two
// failures are possible and both are bad:
//
//   * tunnel a provider host  → an ungoverned provider call carried by the
//     component whose entire job is governing it, with the operator believing
//     scope and budget applied;
//   * tunnel anything asked   → an open proxy on a developer laptop.
//
// So the rule is deny-by-default with two narrow exits: the gateway we already
// send visas to, and hosts the operator named on the command line.
//
// Why a provider CONNECT is refused rather than governed: injecting the key
// would mean terminating the TLS, which means a locally trusted CA that can
// impersonate any host to any process trusting it. PassControl exists to get a
// secret with a one-provider blast radius off the agent's machine; installing a
// broader one to save an environment variable is the wrong trade, and every
// mainstream provider SDK already honours a base-URL variable that needs no CA.

/**
 * The provider upstreams, as host + base path.
 *
 * A second copy of `lib/providers.ts`'s `upstreamBaseUrl`, for the same reason
 * `bareGatewayOrigin` exists twice: `cli/` is plain .mjs run straight from the
 * checkout and published as-is, so it cannot import TypeScript that only exists
 * after `tsc`. `tests/cli-provider-hosts.test.ts` runs both through one table and
 * fails the moment they disagree — a provider added there and missed here is a
 * provider this file would let through.
 */
export const PROVIDER_UPSTREAMS = {
  openai: { hostname: "api.openai.com", basePath: "" },
  anthropic: { hostname: "api.anthropic.com", basePath: "" },
  groq: { hostname: "api.groq.com", basePath: "/openai" },
  mistral: { hostname: "api.mistral.ai", basePath: "" },
  together: { hostname: "api.together.ai", basePath: "" },
  deepseek: { hostname: "api.deepseek.com", basePath: "" },
  // Gemini's OpenAI-compat base carries a two-segment prefix, unlike groq's
  // single `/openai`. Listing it here is what makes a CONNECT to Google refuse
  // as `provider_tunnel_not_governed` — and, deliberately, what makes it
  // permanently ineligible for `--allow-connect`.
  gemini: { hostname: "generativelanguage.googleapis.com", basePath: "/v1beta/openai" },
};

const HOST_BY_NAME = new Map(
  Object.entries(PROVIDER_UPSTREAMS).map(([provider, entry]) => [entry.hostname, { provider, ...entry }])
);

// A hostname carrying any of these is not a hostname. Checked rather than
// assumed because the value arrives on a request line from whatever the client
// felt like sending.
const NOT_IN_A_HOSTNAME = /[\s/\\@?#]/;

/**
 * Lower-case, unbracket, and drop the fully-qualified trailing dot.
 *
 * `api.anthropic.com.` resolves to exactly the same address as
 * `api.anthropic.com`, so a string comparison that treats them as different
 * hosts is a one-character bypass of the provider refusal below.
 */
function normalizeHostname(value) {
  let host = String(value ?? "").trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host;
}

/** Exact match only — `evil-api.anthropic.com` is somebody else's hostname. */
export function providerForHost(hostname) {
  return HOST_BY_NAME.get(normalizeHostname(hostname)) ?? null;
}

function parsePort(value) {
  if (!/^\d{1,5}$/.test(String(value))) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

/**
 * Split a CONNECT authority-form target (`host:port`) as RFC 9110 defines it.
 *
 * The port is mandatory: a bare host is not a valid CONNECT target, and guessing
 * 443 for it would mean inventing a destination the client never named.
 */
export function parseConnectTarget(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  let hostPart;
  let portPart;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close === -1 || value[close + 1] !== ":") return null;
    hostPart = value.slice(0, close + 1);
    portPart = value.slice(close + 2);
  } else {
    const colon = value.indexOf(":");
    // Exactly one colon outside brackets. `a:1:2` is malformed, not an address.
    if (colon === -1 || value.indexOf(":", colon + 1) !== -1) return null;
    hostPart = value.slice(0, colon);
    portPart = value.slice(colon + 1);
  }

  const hostname = normalizeHostname(hostPart);
  const port = parsePort(portPart);
  if (!hostname || port === null || NOT_IN_A_HOSTNAME.test(hostname)) return null;
  return { hostname, port };
}

/** The gateway's own host and effective port, which CONNECT is allowed to reach. */
function gatewayTarget(gatewayOrigin) {
  let url;
  try {
    url = new URL(String(gatewayOrigin ?? ""));
  } catch {
    return null;
  }
  const port = url.port ? parsePort(url.port) : url.protocol === "https:" ? 443 : 80;
  if (port === null) return null;
  return { hostname: normalizeHostname(url.hostname), port };
}

/** `host` (any port) or `host:port` (that port only). */
function parseAllowEntry(entry) {
  const value = String(entry ?? "").trim();
  if (!value) return null;
  const withPort = parseConnectTarget(value);
  if (withPort) return withPort;

  const hostname = normalizeHostname(value);
  if (!hostname || NOT_IN_A_HOSTNAME.test(hostname) || hostname.includes(":")) return null;
  return { hostname, port: null };
}

export function parseAllowHosts(entries) {
  const list = Array.isArray(entries)
    ? entries
    : String(entries ?? "")
        .split(",")
        .filter(Boolean);
  return list.map(parseAllowEntry).filter(Boolean);
}

function refuse(status, code, message, help) {
  return { allow: false, status, code, message, help };
}

function governedPathHelp(provider, localBaseUrl) {
  const base = localBaseUrl ? String(localBaseUrl).replace(/\/+$/, "") : "";
  return `${base}/api/v1/${provider}`;
}

/**
 * Decide what to do with `CONNECT host:port`.
 *
 * Order matters: the provider check runs FIRST, before the operator allowlist.
 * An allowlist that could name a provider would stop being an egress control and
 * become an off-switch for governance.
 */
export function classifyConnect({ target, gatewayOrigin, allowHosts = [], localBaseUrl = "" } = {}) {
  const parsed = parseConnectTarget(target);
  if (!parsed) {
    return refuse(
      400,
      "bad_connect_target",
      "CONNECT needs an authority-form target, for example api.example.com:443.",
      "Check the proxy setting; PassControl received a target it could not parse."
    );
  }

  const provider = providerForHost(parsed.hostname);
  if (provider) {
    return refuse(
      403,
      "provider_tunnel_not_governed",
      `PassControl will not tunnel TLS to ${parsed.hostname}. It cannot see inside that connection, so it could ` +
        "neither inject the provider key nor apply scope, budget or the kill switch — the call would leave " +
        "ungoverned while appearing to be governed.",
      `Point the client's base URL at ${governedPathHelp(provider.provider, localBaseUrl)} instead. ` +
        "PassControl does not install a TLS-intercepting CA."
    );
  }

  const gateway = gatewayTarget(gatewayOrigin);
  if (gateway && parsed.hostname === gateway.hostname && parsed.port === gateway.port) {
    return { allow: true, ...parsed, reason: "gateway" };
  }

  const allowed = parseAllowHosts(allowHosts).some(
    (entry) => entry.hostname === parsed.hostname && (entry.port === null || entry.port === parsed.port)
  );
  if (allowed) return { allow: true, ...parsed, reason: "allowlist" };

  return refuse(
    403,
    "host_not_allowed",
    `PassControl is not an open proxy and will not tunnel to ${parsed.hostname}.`,
    `Allow it explicitly with \`passcontrol sidecar --allow-connect ${parsed.hostname}\` if the agent needs it.`
  );
}

/**
 * Decide what to do with a request line.
 *
 * Origin-form (`/api/v1/…`) is the sidecar's original mode and passes through.
 * Absolute-form (`http://api.anthropic.com/v1/messages`) is what a proxy client
 * sends for a plain-HTTP URL; it used to be concatenated onto the gateway origin
 * verbatim, producing `https://gateway/http://api.anthropic.com/v1/messages`.
 */
export function classifyProxyRequest({ url, gatewayOrigin, localBaseUrl = "" } = {}) {
  const target = String(url ?? "");
  if (target.startsWith("/")) return { allow: true, path: target, reason: "origin-form" };

  if (!/^https?:\/\//i.test(target)) {
    return refuse(
      400,
      "bad_request_target",
      "PassControl received a request target that is neither a path nor an absolute URL.",
      "Point the client at the sidecar's base URL, or set HTTP_PROXY/HTTPS_PROXY to it."
    );
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return refuse(400, "bad_request_target", "PassControl could not parse that request target.", "Check the client's base URL.");
  }
  // Never echoed anywhere below, and refused outright: a URL carrying userinfo
  // is a credential in a request line, and the same rule already governs
  // PASSCONTROL_GATEWAY in `bareGatewayOrigin`.
  if (parsed.username || parsed.password) {
    return refuse(
      400,
      "bad_request_target",
      "PassControl refuses a request target with embedded credentials.",
      "Remove the user:password@ prefix from the client's base URL."
    );
  }

  const hostname = normalizeHostname(parsed.hostname);
  const provider = providerForHost(hostname);
  if (provider) {
    // The gateway re-adds the provider's base path from `upstreamBaseUrl`, so
    // forwarding groq's `/openai` prefix as well would double it.
    let rest = parsed.pathname;
    if (provider.basePath && (rest === provider.basePath || rest.startsWith(`${provider.basePath}/`))) {
      rest = rest.slice(provider.basePath.length);
    }
    if (!rest.startsWith("/")) rest = `/${rest}`;
    return { allow: true, path: `/api/v1/${provider.provider}${rest}${parsed.search}`, reason: "provider" };
  }

  const gateway = gatewayTarget(gatewayOrigin);
  const port = parsed.port ? parsePort(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (gateway && hostname === gateway.hostname && port === gateway.port) {
    return { allow: true, path: `${parsed.pathname}${parsed.search}`, reason: "gateway" };
  }

  return refuse(
    403,
    "host_not_allowed",
    `PassControl is not an open proxy and will not forward to ${hostname}.`,
    "Only the configured gateway and the supported providers are routed."
  );
}

/**
 * Loopback bind addresses.
 *
 * The sidecar holds the passport and mints visas on demand, so a listener
 * reachable off-host is a credential-issuing endpoint for anyone who can route
 * to it. `127.0.0.0/8` in full, because `127.0.0.2` is as loopback as `127.0.0.1`.
 */
export function isLoopbackBindHost(host) {
  const value = normalizeHostname(host);
  if (!value) return false;
  return value === "localhost" || value === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);
}
