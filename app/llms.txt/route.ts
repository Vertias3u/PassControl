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

> Source-available identity and credential gateway for AI agents. Each agent holds
> a sign-only Ed25519 "passport" and mints short-lived, scoped "work-visas"; the
> gateway verifies the request, enforces per-agent budgets and a kill switch,
> injects the real provider key from a vault, and proxies the call — so the agent
> never holds your API key. ${BUILD_CONTEXT}

## What it is
PassControl removes the "one shared API key inside every agent" problem. Instead of
putting an OpenAI/Anthropic key in an agent's environment — where it has no per-agent
spend limit, can't be shut off without rotating it everywhere, and leaves no record of
which agent did what — each agent gets a cryptographic identity and a time-limited,
budget-scoped token. Revocation is instant and per-agent; every call is audited.

## How it works
- Each agent holds an Ed25519 private key (a "passport") that only ever signs — it never
  leaves the agent.
- The agent signs a one-time challenge (timestamped, single-use nonce, verified and burned
  server-side so it can't be replayed) and receives a short-lived (~5 min) signed "work-visa"
  carrying its identity, scope, and budget.
- The gateway verifies the visa, checks the kill switch, checks scope (provider + model +
  endpoint), reserves budget atomically, resolves the real provider key from a vault, injects
  it, and proxies the call. The agent never sees the key.

## Key facts
- License: Business Source License 1.1 (source-available, not OSI open-source). The full
  working core is free to self-host.
- Providers: OpenAI, Anthropic, Groq, Mistral, Together, DeepSeek.
- Stack: Next.js, Supabase (Postgres/Vault/Auth), Redis.
- Status: ${STATUS_CONTEXT}
- By design the gateway sees plaintext provider traffic (it must, to inject the key), so the
  boundary is "the agent doesn't hold the key," not "nobody does." Self-hosted, the vault and
  gateway are your own infrastructure.

## How it compares
- vs. provider-side budgets / virtual keys: those are per-key, not per-agent-identity, and you
  still hand the agent a bearer secret. PassControl proves agent identity by signature — no
  shared secret to leak — and revocation is instant per agent.
- vs. an LLM proxy/router (LiteLLM, Portkey, Cloudflare AI Gateway): those center on routing,
  caching, and observability behind a shared key. PassControl centers on per-agent
  cryptographic identity, capability scoping, budgets, and revocation. It runs drop-in
  alongside them — point your existing SDK at the gateway URL.

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
