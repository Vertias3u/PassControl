// The service catalog: every non-LLM API the gateway will hold a credential for.
//
// Each entry is CODE, reviewed like `ENDPOINT_ALLOWLIST` in lib/scope.ts, and
// never data a tenant can write. That is the SSRF control (plans/any-api-
// credentials.md T1): the upstream origin comes from this file, never from the
// request or from a tenant column. Custom services are a self-host-only phase 4.
//
// GitHub facts below were read from GitHub's REST docs on 2026-09-29:
//   - docs.github.com/en/rest/authentication/authenticating-to-the-rest-api:
//     "In most cases, you can use `Authorization: Bearer` or `Authorization:
//     token` to pass a token" (classic and fine-grained PATs alike).
//   - …/rest/using-the-rest-api/getting-started-with-the-rest-api: "All API
//     requests must include a valid `User-Agent` header. Requests with no
//     `User-Agent` header will be rejected." Base URL https://api.github.com.
//   - …/rest/about-the-rest-api/api-versions: supported versions 2026-03-10 and
//     2022-11-28; no header means 2022-11-28; an unsupported one is 410. The
//     gateway forwards the agent's `X-GitHub-Api-Version` and never sets one.
//   - …/rest/using-the-rest-api/using-pagination-in-the-rest-api: `link` holds
//     absolute api.github.com URLs, and pagination uses `page`, `before`/`after`
//     or `since` query parameters (see lib/services/wire.ts for the rewrite).

export const SERVICE_IDS = ["github", "telegram"] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

/** The `provider_credentials.provider` value a service's token is stored under. */
export type ServiceCredentialProvider = `svc:${ServiceId}`;

export interface ServiceCatalogEntry {
  id: ServiceId;
  /** Human name, for refusals and the dashboard. */
  label: string;
  /**
   * The namespaced provider id in `provider_credentials`. Namespaced so the one
   * decrypt path (`get_provider_key`) serves it unchanged (invariant 5), and so
   * `isProvider()` — which every LLM reader filters on — can never admit it.
   */
  credentialProvider: ServiceCredentialProvider;
  /** Fixed upstream origin. Scheme + host only, no path, no trailing slash. */
  origin: string;
  /**
   * The upstream URL for an admitted call: always `origin` plus the re-encoded
   * path and the forwardable query, and — for a service that authenticates in
   * the URL (Telegram) — the token. Null when the stored token cannot be put
   * into a URL safely, which refuses the call rather than sending it anywhere.
   */
  upstreamUrl(token: string, upstreamPath: string, search: string): string | null;
  /** Headers the gateway sets to authenticate (empty where the URL carries it). */
  authHeaders(token: string): Record<string, string>;
  /**
   * How this service's rules are written. `http`: a method and a path pattern
   * (GitHub). `call`: a method NAME (`{ "call": "sendMessage" }`), for an API
   * where the HTTP verb decides nothing (Telegram accepts GET and POST for
   * every method).
   */
  ruleShape: "http" | "call";
  /** Whether an admitted rule can change something (shown on the Services page). */
  isWriteRule(rule: { method: string; path: string }): boolean;
  /** Request body media types forwarded on a write. Anything else is 415. */
  bodyTypes: readonly string[];
  /**
   * Whether `link` and `location` are rewritten back through the gateway. Only
   * for a service whose URLs carry no credential; otherwise both are dropped.
   */
  rewritesUrls: boolean;
  /**
   * The shape a stored token must have, checked when it is added and again
   * before every use. Required where the token is put into a URL.
   */
  tokenShape?: RegExp;
  /** How to describe a token that does not match `tokenShape`. */
  tokenShapeHint?: string;
  /** One sentence for operators: what this service refuses whatever the rules say. */
  neverSummary: string;
  /** Lower-case request headers an agent may send on to the service. */
  requestHeaders: readonly string[];
  /**
   * The largest write body forwarded, in bytes. Read only once a write is
   * admitted, and refused 413 above this. Vercel refuses a request body over
   * 4.5 MB before it reaches the route anyway.
   */
  maxBodyBytes: number;
  /** Lower-case response headers passed back, besides `link`/`location` (rewritten). */
  responseHeaders: readonly string[];
  /**
   * Calls refused whatever the tenant's rules say, as a reason string, or null.
   * Two kinds: an endpoint a path rule cannot scope (T3), and writes that change
   * who can reach the tenant's data, where its events go, what secrets it holds,
   * or whether it exists (the never list, phase 2). A rule is written by a person
   * in a hurry; this list is reviewed code.
   */
  refused(method: string, segments: readonly string[]): string | null;
}

// ── GitHub's never list (phase 2) ────────────────────────────────────────────
//
// Writes refused whatever the tenant's rules say. Matched on LOWER-CASED
// segments: a rule's `*` matches any casing, so `DELETE /*/acme/web` would
// otherwise reach a repository delete as `/REPOS/acme/web`. Reads are never on
// this list; it is about changes. Endpoint paths are GitHub's REST reference
// (docs.github.com/en/rest, read 2026-10-01). Refusing more is the safe
// direction: the owner loosens it deliberately, by editing this code.
const GITHUB_REFUSAL = {
  graphql:
    "GitHub's GraphQL API is one endpoint that can do anything the token can, so a path rule cannot scope it. Use the REST API.",
  repository:
    "Deleting a repository, or changing its name, visibility, archive state or default branch, is refused through PassControl whatever the agent's rules say.",
  access:
    "Changing who can reach a repository, or how it is protected, is refused through PassControl whatever the agent's rules say: collaborators, invitations, transfers, deploy keys, branch protection, rulesets and environments.",
  hooks:
    "Creating or changing a webhook is refused through PassControl whatever the agent's rules say: one would send every event in the repository to an address the agent chose.",
  secrets:
    "Writing secrets or variables, or changing Actions permissions and runners, is refused through PassControl whatever the agent's rules say.",
  security:
    "Dismissing security alerts or turning security features off is refused through PassControl whatever the agent's rules say.",
  account:
    "Changes to a GitHub account, organization, team, OAuth app or token are refused through PassControl whatever the agent's rules say.",
  dotGithub:
    "Writing under .github/ is refused through PassControl whatever the agent's rules say: workflow files run code with the repository's secrets, and the folder also holds the actions they run and CODEOWNERS.",
  refs:
    "Updating, deleting or renaming a branch or tag is refused through PassControl whatever the agent's rules say: it can move or remove history. Creating a branch is allowed.",
} as const;

// First segment of an account-level write: none of these is a repository's
// content, and each can widen access beyond the token's repositories.
const GITHUB_ACCOUNT_ROOTS = new Set([
  "user",
  "users",
  "orgs",
  "organizations",
  "teams",
  "enterprises",
  "authorizations",
  "applications",
  "app",
  "app-manifests",
  "installation",
  "admin",
]);
const GITHUB_REPO_ACCESS = new Set(["transfer", "collaborators", "invitations", "keys", "rulesets", "environments"]);
const GITHUB_REPO_SECRETS = new Set(["dependabot", "codespaces"]);
const GITHUB_REPO_SECURITY = new Set([
  "secret-scanning",
  "code-scanning",
  "vulnerability-alerts",
  "automated-security-fixes",
  "private-vulnerability-reporting",
]);
const GITHUB_ACTIONS_NEVER = new Set(["secrets", "variables", "permissions", "runners", "runner-groups", "oidc"]);

function githubRefusal(method: string, segments: readonly string[]): string | null {
  let s = segments.map((segment) => segment.toLowerCase());
  if (s[0] === "graphql") return GITHUB_REFUSAL.graphql;
  if (method === "GET" || method === "HEAD") return null;

  if (GITHUB_ACCOUNT_ROOTS.has(s[0]!)) return GITHUB_REFUSAL.account;
  // GitHub serves every repository by numeric id too: `/repositories/{id}/...`
  // is `/repos/{owner}/{repo}/...` one segment shorter (verified live,
  // 2026-10-02). Read it as that, so the same repository meets the same list.
  if (s[0] === "repositories") s = ["repos", "", ...s.slice(1)];
  if (s[0] !== "repos") return null;
  // `/repos/{owner}/{repo}` itself, or anything shorter.
  if (s.length <= 3) return GITHUB_REFUSAL.repository;
  const area = s[3]!;
  if (GITHUB_REPO_ACCESS.has(area)) return GITHUB_REFUSAL.access;
  if (area === "hooks") return GITHUB_REFUSAL.hooks;
  if (GITHUB_REPO_SECRETS.has(area)) return GITHUB_REFUSAL.secrets;
  if (GITHUB_REPO_SECURITY.has(area)) return GITHUB_REFUSAL.security;
  if (area === "actions" && GITHUB_ACTIONS_NEVER.has(s[4] ?? "")) return GITHUB_REFUSAL.secrets;
  // /repos/{o}/{r}/branches/{branch}/protection[/...] and the older tag protection.
  if (area === "branches" && s[5] === "protection") return GITHUB_REFUSAL.access;
  if (area === "tags" && s[4] === "protection") return GITHUB_REFUSAL.access;
  // Owner decision 2026-10-02. /contents/.github/... (workflows, local actions,
  // CODEOWNERS), and any write to an existing ref: PATCH (incl. a force update,
  // which is a body flag) and DELETE on git/refs/..., and a branch rename.
  // Creating a ref (POST /git/refs) stays with the rules. The git data API can
  // also carry a workflow file inside a new commit; GitHub requires the token's
  // Workflows permission for that, so that permission is the ceiling there.
  if (area === "contents" && s[4] === ".github") return GITHUB_REFUSAL.dotGithub;
  if (area === "git" && s[4] === "refs" && s.length > 5) return GITHUB_REFUSAL.refs;
  if (area === "branches" && s[5] === "rename") return GITHUB_REFUSAL.refs;
  return null;
}

// ── Telegram ────────────────────────────────────────────────────────────────
// BotFather's format: the bot's numeric id, a colon, then the secret. Strict
// because the token is put into a URL path: a `/`, `?`, `#` or space in it
// would change the address the request goes to.
const TELEGRAM_TOKEN = /^[0-9]{1,20}:[A-Za-z0-9_-]{20,100}$/u;

// Methods that hand the bot to someone else, or end it, refused whatever the
// rules say: setWebhook sends every update to an address the agent chose (and
// getUpdates stops working for everyone else), deleteWebhook silently takes
// the bot off the operator's own webhook, and logOut / close end the bot's
// session with Telegram's servers. Lower-case: method names are case-insensitive.
const TELEGRAM_NEVER = new Set(["setwebhook", "deletewebhook", "logout", "close"]);

function telegramRefusal(_method: string, segments: readonly string[]): string | null {
  if (segments.length !== 1) {
    return segments[0]?.toLowerCase() === "file"
      ? "Telegram file downloads are not served through PassControl: their URL carries the bot token."
      : "Only Telegram Bot API methods are served, as one name: /api/v1/svc/telegram/<methodName>.";
  }
  if (TELEGRAM_NEVER.has(segments[0]!.toLowerCase())) {
    return "setWebhook, deleteWebhook, logOut and close are refused through PassControl whatever the agent's rules say: each would hand the bot's updates to someone else or end its session.";
  }
  return null;
}

const GATEWAY_USER_AGENT = "PassControl-Gateway";

export const SERVICE_CATALOG: Readonly<Record<ServiceId, ServiceCatalogEntry>> = {
  github: {
    id: "github",
    label: "GitHub",
    credentialProvider: "svc:github",
    origin: "https://api.github.com",
    upstreamUrl: (_token, upstreamPath, search) => `https://api.github.com${upstreamPath}${search}`,
    ruleShape: "http",
    isWriteRule: (rule) => rule.method !== "GET",
    neverSummary:
      "Some GitHub writes are never allowed, whatever an agent's rules say: deleting or renaming a repository or changing its visibility, access changes, webhooks, secrets and variables, security alerts, anything under .github/ (workflows), updating or deleting a branch or tag, and changes to an account or organization. GraphQL is refused.",
    bodyTypes: ["application/json"],
    rewritesUrls: true,
    authHeaders: (token) => ({
      authorization: `Bearer ${token}`,
      "user-agent": GATEWAY_USER_AGENT,
    }),
    // `content-type` for writes. Never a method override (`x-http-method-override`
    // and friends): one would let a GET the rules admitted act as a write.
    requestHeaders: ["accept", "x-github-api-version", "if-none-match", "content-type"],
    maxBodyBytes: 1_048_576,
    responseHeaders: [
      "content-type",
      "etag",
      "retry-after",
      "x-ratelimit-limit",
      "x-ratelimit-remaining",
      "x-ratelimit-reset",
      "x-ratelimit-used",
      "x-ratelimit-resource",
    ],
    refused: githubRefusal,
  },
  // Telegram Bot API facts, read from core.telegram.org/bots/api ("Making
  // requests", "getFile") on 2026-10-02:
  //   - "All queries to the Telegram Bot API must be served over HTTPS and need
  //     to be presented in this form: https://api.telegram.org/bot<token>/METHOD_NAME"
  //   - "We support GET and POST HTTP methods." Parameters may be passed in the
  //     query string, as application/x-www-form-urlencoded, as application/json
  //     ("except for uploading files"), or as multipart/form-data (uploads).
  //   - "All methods in the Bot API are case-insensitive."
  //   - Files download from https://api.telegram.org/file/bot<token>/<file_path>.
  // The token is in the URL, so the URL is a secret here: built only by
  // upstreamUrl, never logged, never echoed, never rewritten back to an agent.
  telegram: {
    id: "telegram",
    label: "Telegram",
    credentialProvider: "svc:telegram",
    origin: "https://api.telegram.org",
    upstreamUrl: (token, upstreamPath, search) =>
      TELEGRAM_TOKEN.test(token) ? `https://api.telegram.org/bot${token}${upstreamPath}${search}` : null,
    // Nothing in a header: the URL carries the token. No User-Agent rule applies.
    authHeaders: () => ({}),
    ruleShape: "call",
    neverSummary:
      "setWebhook, deleteWebhook, logOut and close are never allowed, whatever an agent's rules say, and file downloads and uploads are not supported.",
    // Telegram's reads are its `get…` methods. (getUpdates also moves the bot's
    // update offset, so two agents sharing it consume each other's updates.)
    isWriteRule: (rule) => !/^get/i.test(rule.path),
    // Uploads are multipart and binary; the gateway reads bodies as text, so
    // they are refused (send a file by URL or file_id in JSON instead).
    bodyTypes: ["application/json", "application/x-www-form-urlencoded"],
    rewritesUrls: false,
    tokenShape: TELEGRAM_TOKEN,
    tokenShapeHint: "A Telegram bot token is the bot's number, a colon, then letters, digits, _ and -, as BotFather gives it.",
    requestHeaders: ["content-type"],
    maxBodyBytes: 1_048_576,
    responseHeaders: ["content-type", "retry-after"],
    refused: telegramRefusal,
  },
};

/**
 * Whether a stored provider id names a service token (`svc:<service>`), as
 * opposed to an LLM provider key. Deliberately a prefix test, not a catalog
 * lookup: a row written for a service this build does not know is still not an
 * LLM key, and must not be counted or drawn as one.
 */
export function isServiceProviderId(value: unknown): boolean {
  return typeof value === "string" && value.startsWith("svc:");
}

export function isServiceId(value: unknown): value is ServiceId {
  return typeof value === "string" && (SERVICE_IDS as readonly string[]).includes(value);
}

/** The catalog's refusal for this call, or null when the catalog has none. */
export function serviceRefusal(
  entry: ServiceCatalogEntry,
  method: string,
  segments: readonly string[]
): string | null {
  return entry.refused(method.toUpperCase(), segments);
}

/** How a service's rules are written; `http` for a name this build does not know. */
export function ruleShapeFor(service: string): "http" | "call" {
  return isServiceId(service) ? SERVICE_CATALOG[service].ruleShape : "http";
}
