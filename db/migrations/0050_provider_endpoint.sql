-- ============================================================================
-- PassControl — a provider credential can name its own endpoint.
--
-- Every base URL in lib/providers.ts is a compile-time constant, so the gateway
-- could only ever reach seven fixed hosts. That blocks the thing self-hosters
-- actually ask for — pointing it at their own OpenAI-compatible server: vLLM,
-- LiteLLM, Ollama, an internal gateway — and it is what makes Azure OpenAI,
-- whose URL is per-resource, impossible rather than merely unimplemented.
--
-- ── Why this is NOT in get_provider_key ─────────────────────────────────────
--
-- An endpoint is configuration, not secret material. `get_provider_key` is the
-- only path in this product that returns decrypted secrets, it is SECURITY
-- DEFINER and service_role-only, and trust boundary #5 says it is the vault of
-- last resort. Widening its return type would mean a DROP and recreate — which
-- discards the function's ACL, the trap 0017 and 0048 both document at length —
-- for a value that is not a secret and can be read by an ordinary tenant-scoped
-- select. So the decrypt path is left byte-unchanged.
--
-- ── What the column does NOT do ─────────────────────────────────────────────
--
-- It does not change the wire protocol. An OpenAI credential pointed at a custom
-- endpoint still speaks OpenAI; an Anthropic one still speaks Anthropic. The
-- endpoint moves, the provider does not — otherwise somebody points an Anthropic
-- key at Ollama and reasonably wonders why it explodes.
--
-- It does not make the target trusted. A tenant-supplied URL the gateway then
-- fetches is an SSRF primitive, and the shape validation in
-- lib/providers/endpoint.ts cannot prevent that — a hostname can resolve to a
-- private address and the edge cannot check. The control is the operator gate
-- (`PROVIDER_ENDPOINT_MODE`), which is OFF unless a deployment turns it on.
--
-- It does not make the traffic priced. See lib/pricing.ts: a custom endpoint is
-- unpriced even when the model name matches one we know, because a proxy may
-- mark up, re-route, or serve something else entirely under that name.
-- ============================================================================

-- Apply via scripts/migrate.sh, which ledgers each file in
-- public.schema_migrations and will not run this twice.

alter table public.provider_credentials
  add column if not exists endpoint_base_url text;

comment on column public.provider_credentials.endpoint_base_url is
  'Optional base URL this credential is sent to instead of the built-in provider '
  'host, e.g. http://vllm.internal:8000/v1. NULL means the built-in constant. '
  'Validated by lib/providers/endpoint.ts on write AND on read, and refused '
  'entirely unless PROVIDER_ENDPOINT_MODE is set. Never a secret: it is an '
  'address, and it is deliberately NOT returned through get_provider_key.';

-- No grant changes. 0027 already governs who may write this table, and an
-- endpoint is written by the same dashboard path that writes `label` — a client
-- that could set it arbitrarily would be choosing where its own key is sent,
-- which is exactly what the operator gate exists to decide.
