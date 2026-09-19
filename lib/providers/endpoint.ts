// Pointing a provider credential at an endpoint we did not choose.
//
// ── READ THIS BEFORE WIDENING ANYTHING HERE ─────────────────────────────────
//
// A tenant-supplied URL that the gateway then fetches IS A SERVER-SIDE REQUEST
// FORGERY PRIMITIVE. The response body is returned to the caller, so it is also
// a read primitive against anything the gateway can reach on the network.
//
// AND THE VALIDATION BELOW DOES NOT PREVENT THAT. It cannot. Rejecting IP
// literals and `localhost` does not stop a hostname resolving to a private
// address — `models.tenant.com` can point at 10.0.0.5 today and somewhere else
// tomorrow — and the edge runtime cannot resolve DNS to check, for the reasons
// lib/owner/domain.ts sets out at length. Anyone who reads this file and
// concludes "PassControl prevents private-network SSRF" has read it wrong.
//
// THE CONTROL IS THE OPERATOR GATE, NOT THE REGEX. `PROVIDER_ENDPOINT_MODE` is
// unset by default, which refuses every custom endpoint. What the shape checks
// below actually buy is narrower and still worth having: no credentials in the
// URL, no scheme we do not speak, no query or fragment a caller could smuggle
// state through, no control characters, and one canonical way to build the
// final path.
//
// ── Why self-host and Cloud get different rules ─────────────────────────────
//
// The strict shape — HTTPS, port 443, public hostnames — is right for a hosted
// multi-tenant beta, where the tenant is not the operator and our egress is not
// theirs to aim.
//
// It is wrong for self-hosting, and it would make this feature useless there:
// Ollama answers on http://localhost:11434, vLLM on http://<private-ip>:8000,
// LiteLLM on http://<internal-host>:4000. All three fail every one of those
// rules, and they are the deployments this exists for. A self-hoster also owns
// the gateway process, so refusing to let them point their own server at their
// own 10.0.0.5 protects nobody — it is not a trust boundary, it is a locked
// door in an open field.
//
// So `selfhost` admits plain HTTP, any port, IP literals and private addresses,
// and keeps only the structural checks. That is a real capability, and
// .env.example says so in plain words rather than burying it.
import { isVerifiableDomain } from "../owner/domain";

/** Long enough for a real base URL, short enough that no query survives here. */
const MAX_ENDPOINT_LENGTH = 512;

/** Whitespace or a C0 control character — the header-injection shapes. */
const UNSAFE_CHARS = /[\s\u0000-\u001F\u007F]/u;

export type EndpointPolicy =
  | { kind: "off" }
  | { kind: "selfhost" }
  | { kind: "allowlist"; hosts: string[] };

/**
 * What this deployment permits. Read per call rather than cached at module load,
 * so a test — and an operator restarting with a new value — sees the change.
 *
 * Anything unrecognised resolves to `off`. That is the only safe reading of a
 * setting we do not understand, and it is also the one that fails visibly: a
 * refused endpoint gets reported, a silently widened one does not.
 */
export function endpointPolicy(): EndpointPolicy {
  const raw = (process.env.PROVIDER_ENDPOINT_MODE ?? "").trim();
  if (!raw || raw.toLowerCase() === "off") return { kind: "off" };
  if (raw.toLowerCase() === "selfhost") return { kind: "selfhost" };

  const hosts = raw
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return hosts.length ? { kind: "allowlist", hosts } : { kind: "off" };
}

/**
 * The checks that apply in EVERY mode.
 *
 * None of these is a network-policy question. They are strings that have no
 * business in a URL we build an authenticated request from, whoever owns the
 * gateway — so `selfhost` relaxes the network rules and not these.
 */
function parseStructurally(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > MAX_ENDPOINT_LENGTH) return null;
  if (UNSAFE_CHARS.test(candidate)) return null;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // Credentials in a base URL would be sent on every call and stored in a row an
  // export can read. The provider key is the credential; this is an address.
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;

  // A base path is allowed and is the point (`/openai/v1`), but it is a PREFIX,
  // not a place to hide a traversal that changes which endpoint gets the key.
  //
  // Checked against the RAW STRING, not `url.pathname`, and that distinction is
  // the whole guard: the WHATWG parser RESOLVES `..` while parsing, so
  //   new URL("http://h:8000/v1/../../admin").pathname === "/admin"
  // — by the time it is a URL the traversal is gone and the value that would be
  // stored is a different endpoint from the one the operator typed, silently.
  // Refusing it here means what they see is what gets the credential.
  const rawPath = candidate.slice(candidate.indexOf(url.host) + url.host.length);
  if (rawPath.split("/").some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return url;
}

/** An IPv4 or bracketed IPv6 literal, which `isVerifiableDomain` also refuses. */
function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/u.test(hostname) || hostname.includes(":");
}

export function isEndpointAllowed(value: unknown, policy: EndpointPolicy): boolean {
  const url = parseStructurally(value);
  if (!url) return false;
  if (policy.kind === "off") return false;

  // Self-host: the operator IS the tenant. Plain HTTP, any port, IP literals and
  // private addresses are all normal here — see the header.
  if (policy.kind === "selfhost") return true;

  // Hosted: exact host match against what the operator named, and nothing else.
  // The allowlist is the security control; the rules below are what stops a
  // listed name being reached in a way the operator did not mean.
  if (url.protocol !== "https:") return false;
  if (url.port && url.port !== "443") return false;
  const hostname = url.hostname.toLowerCase();
  if (isIpLiteral(hostname) || !isVerifiableDomain(hostname)) return false;
  // Exact, not suffix: `a.gateway.company.com` is a different host from
  // `gateway.company.com`, and a suffix match would hand a subdomain takeover
  // the same trust as the name the operator actually reviewed.
  return policy.hosts.includes(hostname);
}

/**
 * The stored form: lower-cased scheme and host, no trailing slash, everything
 * else exactly as the operator typed it. Returns null for anything this
 * deployment would not admit, so a value cannot be stored that a later read
 * would refuse — validate on write AND on read, and let them agree.
 */
export function normalizeEndpoint(
  value: unknown,
  policy: EndpointPolicy = endpointPolicy()
): string | null {
  const url = parseStructurally(value);
  if (!url || !isEndpointAllowed(value, policy)) return null;
  const path = url.pathname.replace(/\/+$/u, "");
  return `${url.protocol}//${url.host}${path}`;
}

/**
 * Build the upstream URL. The ONLY place a base and a client path are joined.
 *
 * `new URL` is deliberately not used, because it has three answers here and two
 * of them silently discard part of the operator's base path:
 *
 *   new URL("/chat", "https://h/openai/v1/")  -> https://h/chat
 *   new URL("chat",  "https://h/openai/v1")   -> https://h/openai/chat
 *   new URL("chat",  "https://h/openai/v1/")  -> https://h/openai/v1/chat
 *
 * A gateway that quietly drops `/openai/v1` sends a real provider credential to
 * a path the operator never named. So the join is string concatenation with the
 * separators normalised, and the segments are checked rather than trusted:
 * `upstreamPath` comes from the client's own URL, and a segment carrying its own
 * `/` or a traversal would let a caller climb out of the base they were given.
 */
/**
 * The canonical path MINUS the version segment our own base would have supplied.
 *
 * A built-in base carries no version (`https://api.openai.com`) and the
 * canonical path supplies it (`v1/chat/completions`). A custom base is written
 * by an operator, and every OpenAI-shaped SDK spells `base_url` with the
 * version already on it — `http://vllm.internal:8000/v1`, which is also the
 * example 0050's own column comment advertises. Appending our version to theirs
 * produced `/v1/v1/chat/completions`, which vLLM answers with a 404: the
 * documented configuration could not work.
 *
 * So the rule is one sentence: **a custom base owns its version segment.** The
 * gateway never invents one the operator did not write, and never repeats one
 * they did. A base with no version gets a path with no version — LiteLLM serves
 * that; an operator who needs `/v1` writes it in the endpoint, where they can
 * see it.
 *
 * The strip is safe because it only ever runs on OUR canonical constants
 * (lib/scope.ts maps every accepted client spelling onto one of them, and the
 * only client-supplied segment — a model id on a listing route — is appended
 * last, never first). It is deliberately not a general "normalise the path"
 * helper: this file's whole argument is that silent rewriting of a
 * credential-bearing URL is how a key reaches a place nobody named.
 *
 * The in-tree precedent is DEEPSEEK_CHAT_PATH / VERSIONLESS_MODELS_PATH in
 * lib/scope.ts, which say the same thing for the two built-in providers whose
 * base already carries a version. This is that idea where the base is not ours.
 */
const VERSION_SEGMENT = /^v[0-9]+[a-z0-9]*$/u;

export function versionlessUpstreamPath(upstreamPath: readonly string[]): readonly string[] {
  const [first, ...rest] = upstreamPath;
  return first !== undefined && VERSION_SEGMENT.test(first) ? rest : upstreamPath;
}

export function joinUpstream(base: string, upstreamPath: readonly string[]): string {
  for (const segment of upstreamPath) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error("unsafe upstream path segment");
    }
    if (/[/\\]/u.test(segment) || UNSAFE_CHARS.test(segment)) {
      throw new Error("unsafe upstream path segment");
    }
  }
  // Trailing separators collapse; the segments are already known to carry none.
  return `${base.replace(/\/+$/u, "")}/${upstreamPath.join("/")}`;
}

/**
 * The client's own query string, with this route's framework-injected routing
 * parameters removed.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The proxy lives at `app/api/v1/[provider]/[...path]`, and Next does not hand
 * a dynamic route's parameters to the handler through `ctx.params` ALONE. The
 * router carries them in the query string under its own `nxtP` prefix, and the
 * edge adapter then strips that prefix and re-appends them as ORDINARY query
 * parameters before the handler ever sees the request
 * (`next/dist/server/web/adapter.js` — `normalizeNextQueryParam`). So a request
 * the SDK sent as
 *
 *   POST /api/v1/openai/v1/chat/completions
 *
 * arrives with `req.url` reading
 *
 *   ...?provider=openai&path=v1&path=chat&path=completions
 *
 * — verified against a running server, not inferred. Forwarding `req.url`'s
 * search verbatim therefore appended OUR ROUTER'S INTERNALS to a
 * credential-bearing upstream request. OpenAI rejects it outright ("Duplicate
 * parameter: 'path'"); every other provider silently ignored the junk, which is
 * why this survived heavy Anthropic testing. The leak was never
 * provider-specific — only the symptom was.
 *
 * ── Why the parameters are DROPPED rather than reconstructed ─────────────────
 *
 * The adapter deletes any same-named parameter the client sent before appending
 * the route segments, so a genuine `?path=…` from a caller is already gone by
 * the time this runs. There is nothing left to preserve, and inventing a value
 * for it would be a fabrication on the path that carries a provider key. A key
 * whose name cannot be decoded is dropped for the same reason: it cannot be
 * compared against the route's own names, and an undecidable parameter does not
 * get to ride along with a credential. Every endpoint on the allowlist treats
 * its query string as optional, so dropping is always safe and never silent
 * about a value that mattered.
 *
 * Everything else is forwarded BYTE FOR BYTE, original percent-encoding intact.
 * Anthropic's `GET /v1/models` pagination (`limit`, `after_id`, `before_id`) is
 * a real client parameter on a real allowlisted endpoint, and re-encoding a
 * query the caller built is not this function's business.
 *
 * `routeParamNames` is asked of the params object rather than written out here,
 * so renaming a route segment cannot leave a stale name behind. The `nxt`
 * prefixes are belt-and-braces: nothing prefixed reaches a handler today, and
 * the day one does it must not reach a provider either.
 */
const NEXT_ROUTER_PARAM_PREFIX = /^nxt[PI]/u;

export function forwardableUpstreamSearch(
  requestUrl: string,
  routeParamNames: readonly string[]
): string {
  const raw = new URL(requestUrl).search.replace(/^\?/u, "");
  if (!raw) return "";
  const kept = raw.split("&").filter((pair) => {
    if (!pair) return false;
    const rawKey = pair.split("=")[0] ?? "";
    let key: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/gu, " "));
    } catch {
      // Undecodable: unprovable, so it does not travel with the credential.
      return false;
    }
    if (routeParamNames.includes(key)) return false;
    return !NEXT_ROUTER_PARAM_PREFIX.test(key);
  });
  return kept.length ? `?${kept.join("&")}` : "";
}
