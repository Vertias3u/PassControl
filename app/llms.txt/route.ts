import { RELEASE_SERIES } from "@/lib/version";

export const runtime = "edge";

// Served at /llms.txt — a concise, factual description for AI answer engines
// (AEO). Honest by design: source-available (not OSI), solo-built, early, not
// audited. Keep claims in sync with SHOW_HN.md / the landing page.
// The Links section. Defined out here, not inline in the document below, because a
// curate marker inside a template literal is not a comment — it would be served as a
// line of the actual llms.txt.
// Core keeps the two links that are about the software and drops the four that are
// about our deployment. The contact address goes with them: an assistant reading a
// self-hosted instance's llms.txt should not be told to email us about it.
const LINKS = `- Source code: https://github.com/Vertias3u/PassControl
- Security policy: https://github.com/Vertias3u/PassControl/blob/main/SECURITY.md`;

const BUILD_CONTEXT = `Early (${RELEASE_SERIES}), self-hostable, and not yet independently audited.`;
const STATUS_CONTEXT = `${RELEASE_SERIES}, not independently audited — run it against a non-critical key first.`;

const BODY = `# PassControl

> Source-available identity and credential gateway for AI agents. An agent uses a
> Direct Agent Key or a Passport-derived short-lived work-visa. The gateway checks
> authorization and budgets, injects a provider credential from Vault and forwards
> the request. The Passport private key stays client-side. ${BUILD_CONTEXT}

## What it is
PassControl keeps provider keys out of agent configuration. Cloud stores them in a
managed server-side Vault; self-hosters operate their own gateway, Supabase and Redis.
The gateway sees plaintext traffic and credentials during forwarding. Its operator
is trusted. Requests that bypass this gateway are outside its controls.

## Authentication
- Direct Agent Keys are named, independently revocable bearer credentials for one agent.
- Passports sign replay-protected challenges to mint visas (default five minutes,
  configurable up to fifteen). Expiry and rotation grace are checked at mint.
- Sender-proof modes are off, observe and required. Only required mode enforces a fresh
  request proof. The current sidecar attaches proofs; direct CLI calls, MCP chat and the
  TypeScript SDK do not. Proofs bind method, origin/path, timestamp, nonce and visa hash,
  not body/query or hardware custody.
- OS key storage is supported by the CLI. Gateway custody evidence is DECLARED, not
  verified storage. A signed revocation list needs freshness checks and excludes
  expiry, suspension and kill-switch state.

## Capabilities and limits
- Providers: OpenAI, Anthropic, Groq, Mistral, Together, DeepSeek, Gemini.
- OpenAI POST Responses and Chat Completions; Anthropic Messages; other providers use
  OpenAI-compatible chat. Gemini native generateContent is not supported.
- Custom endpoints require operator opt-in. Selfhost mode permits private HTTP services;
  hostname-list validation is not full SSRF prevention. Provider redirects are refused.
- Budgets reserve estimates. Unknown usage retains conservative charges; abandoned holds
  do not expire. Lost established state blocks rather than granting fresh capacity.
  Custom endpoints are unpriced, not free; token accounting continues.
- Stop controls block subsequent requests, not already-dispatched calls. Kill-state reads
  default fail-open; an operator can choose fail-closed. Persistence/no-eviction matters.
- Logs and signed receipts are best-effort. Signatures authenticate issuer assertions,
  not provider execution, invoice accuracy or complete traffic coverage.
- Cloud spend statements commit to receipt sets with Merkle roots. They are not an
  independent audit. The public tree ships verifiers and format, not chain operations.
- Owner claims are declared unless a domain/GitHub control check succeeded. Neither
  control check proves legal identity. Company registry evidence does not prove authority.
- License: Business Source License 1.1 (source-available, not OSI open-source).
- Stack: Next.js, Supabase (Postgres/Vault/Auth), Redis with a REST interface.
- Status: ${STATUS_CONTEXT}

## Links
${LINKS}
`;

export function GET(): Response {
  return new Response(BODY, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
