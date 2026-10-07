// Upstream provider configuration: base URLs and auth-header injection.
export const PROVIDERS = ["openai", "anthropic", "groq", "mistral", "together", "deepseek", "gemini", "xai", "openrouter", "azure", "local"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

/**
 * What a `local` credential stores when its server takes no key (Ollama, LM
 * Studio). Vault holds a value for every credential, and this one means "send
 * nothing": `authHeaders` omits the header rather than handing a local server a
 * made-up bearer token. Only `local` reads it that way; for any other provider
 * it would be an ordinary (wrong) key.
 */
export const LOCAL_NO_KEY = "passcontrol-local-no-key";

export function isProvider(p: string): p is ProviderId {
  return (PROVIDERS as readonly string[]).includes(p);
}

/**
 * Providers an agent's SCOPE may name that can never hold a credential.
 *
 * `demo` is the keyless provider: `handleDemo` synthesizes the response inside
 * the gateway, never calls `get_provider_key` and never forwards anywhere. A
 * scope naming it therefore grants no upstream reach and no spend against a
 * real key — which is why it is scope-legal while staying illegal everywhere a
 * credential or a failover target is chosen.
 *
 * It has to be scope-legal because a brand-new tenant has NO key in Vault, so a
 * demo call is the only one its first agent can lawfully make. `passcontrol
 * login` relies on exactly that to prove itself with a verified receipt, and
 * `scripts/seed.mjs` has always inserted the demo agent with this scope
 * directly — so rows of this shape already existed while the validator that
 * guards the front door rejected them. That disagreement was a live break: from
 * 2026-08-29 (36f70e9) until this fix, `passcontrol login` could not create an
 * agent at all, because the control plane answered its create with 422
 * "Unknown provider in scope."
 *
 * NOT gated on `PASSCONTROL_DEMO`. Whether the demo route answers is a property
 * of the gateway at call time, not of the tenant's data at creation time — and
 * gating here would make a self-hosted gateway with the demo off refuse a login
 * that is otherwise perfectly valid.
 */
export const SCOPE_ONLY_PROVIDERS = ["demo"] as const;

/** A provider that may appear in a scope: a real one, or the keyless demo. */
export type ScopeProviderId = ProviderId | (typeof SCOPE_ONLY_PROVIDERS)[number];

/** True for a provider an agent may hold in scope: a real one, or keyless demo. */
export function isScopeProvider(p: string): p is ScopeProviderId {
  return isProvider(p) || (SCOPE_ONLY_PROVIDERS as readonly string[]).includes(p);
}

/**
 * Every provider a scope row may name, in the order a chooser should offer them.
 *
 * Derived, never typed out, for the reason the CLI's usage strings are: a
 * hand-written list drifts from the validator, and a chooser that cannot offer
 * a provider the validator accepts will MISREPRESENT an agent that already has
 * it — the scope editor showed a saved `demo` row as the first real provider in
 * its list, which is the control tower lying about what an agent may call.
 */
export const SCOPE_PROVIDERS = [...PROVIDERS, ...SCOPE_ONLY_PROVIDERS] as const;

/**
 * The providers a chooser offers on this deployment.
 *
 * `local` is reachable only where the operator gate is open, so a deployment
 * with the gate off (hosted Cloud) does not offer it: a choice the gateway will
 * refuse on every call is clutter at best. A value already SAVED is always kept,
 * whatever the gate says, for the reason SCOPE_PROVIDERS gives: a chooser that
 * cannot name a row's provider shows the wrong one, which misrepresents it.
 */
export function offeredProviders<T extends string>(
  list: readonly T[],
  localEnabled: boolean,
  keep: readonly (string | null | undefined)[] = []
): T[] {
  return list.filter((p) => p !== "local" || localEnabled || keep.includes(p));
}

export interface ProviderGuess {
  suggested: ProviderId | null;
  candidates: ProviderId[];
  ambiguous: boolean;
}

/**
 * Best-effort UI hint only. Provider keys do not all have stable, unique public
 * prefixes, so unknown shapes deliberately stay ambiguous and a bare `sk-`
 * never silently chooses between OpenAI and DeepSeek.
 */
export function detectProviderFromKey(key: string): ProviderGuess {
  const value = String(key ?? "").trim();
  if (value.startsWith("sk-ant-")) {
    return { suggested: "anthropic", candidates: ["anthropic"], ambiguous: false };
  }
  if (value.startsWith("gsk_")) {
    return { suggested: "groq", candidates: ["groq"], ambiguous: false };
  }
  // OpenRouter's keys are `sk-or-v1-…`: checked before the bare `sk-` family,
  // which would otherwise offer OpenAI or DeepSeek for one.
  if (value.startsWith("sk-or-")) {
    return { suggested: "openrouter", candidates: ["openrouter"], ambiguous: false };
  }
  if (value.startsWith("sk-proj-") || value.startsWith("sk-svcacct-")) {
    return { suggested: "openai", candidates: ["openai"], ambiguous: false };
  }
  if (value.startsWith("sk-")) {
    return {
      suggested: "openai",
      candidates: ["openai", "deepseek"],
      ambiguous: true,
    };
  }
  // Google's API keys are the one remaining prefix that is both stable and
  // unique to a single provider here. Checked after the sk- families so a key
  // that merely CONTAINS "AIza" cannot outrank its own real prefix.
  if (value.startsWith("AIza")) {
    return { suggested: "gemini", candidates: ["gemini"], ambiguous: false };
  }
  return { suggested: null, candidates: [...PROVIDERS], ambiguous: true };
}

/** An explicit dropdown selection always outranks the key-shape heuristic. */
export function resolveProviderSelection(key: string, selected?: string | null): ProviderId {
  if (selected && isProvider(selected)) return selected;
  return detectProviderFromKey(key).suggested ?? "anthropic";
}

/**
 * Providers with no host of ours: every customer's resource is its own, so the
 * address is stored with the credential and a key without one is refused rather
 * than sent anywhere (lib/providers/endpoint.ts `isEndpointAllowedFor`).
 */
export function providerRequiresEndpoint(provider: ProviderId): boolean {
  return upstreamBaseUrl(provider) === null;
}

/**
 * The provider's own base URL, or null for a provider that has none (Azure).
 *
 * Null rather than a placeholder host on purpose: a default for Azure would be a
 * real hostname a real key could be sent to, and there is no right one.
 */
export function upstreamBaseUrl(provider: ProviderId): string | null {
  switch (provider) {
    case "openai":
      return "https://api.openai.com";
    case "anthropic":
      return "https://api.anthropic.com";
    case "groq":
      return "https://api.groq.com/openai";
    case "mistral":
      return "https://api.mistral.ai";
    case "together":
      return "https://api.together.ai";
    case "deepseek":
      return "https://api.deepseek.com";
    // Google's OpenAI-COMPATIBILITY endpoint, not the native generateContent
    // API. Picking it is what keeps Gemini inside the existing "openai" family
    // below; the native API speaks a different request body, a different usage
    // object and JSON-lines instead of SSE. Note the base already carries its
    // version segment, so client paths here are `chat/completions`, never
    // `v1/chat/completions` — the deepseek case, not the openai one.
    case "gemini":
      return "https://generativelanguage.googleapis.com/v1beta/openai";
    // xAI, through its Responses API only (plan P2-5). Its Chat Completions
    // endpoint is the legacy API and is not allowlisted.
    case "xai":
      return "https://api.x.ai";
    // OpenRouter, Chat Completions only (plans/openrouter.md). Its documented base is
    // `https://openrouter.ai/api/v1`; the `/v1` is a client path segment here, as for
    // OpenAI, so an SDK pointed at `/api/v1/openrouter/v1` reaches the same paths.
    case "openrouter":
      return "https://openrouter.ai/api";
    // Azure OpenAI: `https://<resource>.openai.azure.com/openai/v1`, per credential.
    case "azure":
      return null;
    // A server the developer runs (Ollama, LM Studio, vLLM), per credential. Its
    // address is admitted only where the operator gate is open
    // (lib/providers/endpoint.ts `isEndpointAllowedFor`), so on hosted Cloud a
    // local credential reaches nothing.
    case "local":
      return null;
  }
}

/** Provider model-listing endpoint used by the dashboard import probe. */
export function modelListingUrl(provider: ProviderId): string | null {
  const base = upstreamBaseUrl(provider);
  // No base, no probe: the import flow cannot know an Azure resource's address.
  if (base === null) return null;
  // Providers whose base URL already ends in a version segment take `/models`
  // directly; everyone else needs the `/v1` hop. This was a ternary on deepseek
  // alone — gemini is the second such provider: its compat base already carries
  // `/v1beta/openai`, and `/models` is the path Google documents there.
  // (Probed 2026-08-25 without a key: the compat layer answers any path under
  // that prefix with 400 "Please pass a valid API key" before it reveals whether
  // the route exists, so the doubled `/v1/models` spelling could not be shown to
  // fail — it is simply undocumented and not something to depend on. The failure
  // mode if it is wrong is invisible: the dashboard import probe finds no models
  // and quietly falls back to manual entry.)
  const VERSIONED_BASE: readonly ProviderId[] = ["deepseek", "gemini"];
  return VERSIONED_BASE.includes(provider) ? `${base}/models` : `${base}/v1/models`;
}

/**
 * Headers that name the app to the provider, sent with every forwarded call.
 *
 * OpenRouter credits traffic to the app named by `HTTP-Referer` and `X-Title` on its
 * public rankings. PassControl sends its own name (owner decision 2026-10-07) and never
 * the client's: those headers are client data, and the proxy builds upstream headers
 * from scratch for exactly that reason. The referer is the public repository, as in
 * the Discord User-Agent (lib/services/catalog.ts): the same on Cloud and on a
 * self-hosted gateway, which carries no Cloud address. Every other provider gets none.
 */
export function providerAttributionHeaders(provider: ProviderId): Record<string, string> {
  return provider === "openrouter"
    ? { "http-referer": "https://github.com/Vertias3u/PassControl", "x-title": "PassControl" }
    : {};
}

/** Headers carrying the real provider credential, injected in-flight. */
export function authHeaders(provider: ProviderId, key: string): Record<string, string> {
  switch (provider) {
    case "openai":
    case "groq":
    case "mistral":
    case "together":
    case "deepseek":
    case "gemini":
    case "xai":
    case "openrouter":
      return { authorization: `Bearer ${key}` };
    case "anthropic":
      return { "x-api-key": key, "anthropic-version": "2023-06-01" };
    // Azure's key header (learn.microsoft.com, api-version-lifecycle, read
    // 2026-09-27). Entra ID bearer tokens are out of scope.
    case "azure":
      return { "api-key": key };
    // OpenAI-compatible servers take Bearer when they take a key at all (vLLM's
    // --api-key, LiteLLM). A keyless one gets no header, not a made-up one.
    case "local":
      return key === LOCAL_NO_KEY ? {} : { authorization: `Bearer ${key}` };
  }
}

/**
 * Which request body/path shape a client must send to this provider.
 *
 * Deliberately its own function rather than a reuse of `usesOpenAiUsageShape`.
 * That predicate answers "where do I read usage out of the RESPONSE"; this one
 * answers "what shape must the client's REQUEST be". They happen to split the
 * six providers the same five-to-one way today, and that agreement is a
 * coincidence, not a contract — collapsing them would make a future divergence
 * silently wrong in whichever caller was borrowing the other's meaning.
 *
 * Anthropic is alone here, which is why cross-family failover cannot be done
 * without translating both the request and response—a boundary the gateway
 * deliberately does not cross.
 */
export function requestShapeFamily(provider: ProviderId): "openai" | "anthropic" {
  switch (provider) {
    case "openai":
    case "groq":
    case "mistral":
    case "together":
    case "deepseek":
    case "gemini":
    // OpenAI-style bodies and Bearer auth, on the Responses endpoint.
    case "xai":
    // OpenRouter's Chat Completions normalises every model it routes to this shape.
    case "openrouter":
    // Azure's v1 API is OpenAI's wire format; only the auth header differs.
    case "azure":
    // OpenAI-compatible is what makes a local server reachable through an
    // OpenAI SDK at all.
    case "local":
      return "openai";
    case "anthropic":
      return "anthropic";
  }
}

export function usesOpenAiUsageShape(provider: ProviderId): boolean {
  switch (provider) {
    case "openai":
    case "groq":
    case "mistral":
    case "together":
    case "deepseek":
    case "gemini":
    case "azure":
    // Chat usage plus OpenRouter's own `cost` (lib/providers/openrouter.ts).
    case "openrouter":
    // Chat-shaped usage, including on a stream with `include_usage` (Ollama,
    // verified 2026-10-05 against qwen2.5:0.5b).
    case "local":
      return true;
    // xAI is served on Responses only, whose usage is `input_tokens` /
    // `output_tokens` / `total_tokens` (lib/usage/parseStream.ts), never the
    // chat shape — and it must not get `stream_options.include_usage` injected.
    case "xai":
    case "anthropic":
      return false;
  }
}
