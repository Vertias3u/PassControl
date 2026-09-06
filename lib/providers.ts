// Upstream provider configuration: base URLs and auth-header injection.
export const PROVIDERS = ["openai", "anthropic", "groq", "mistral", "together", "deepseek", "gemini"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

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

export function upstreamBaseUrl(provider: ProviderId): string {
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
  }
}

/** Provider model-listing endpoint used by the dashboard import probe. */
export function modelListingUrl(provider: ProviderId): string {
  const base = upstreamBaseUrl(provider);
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

/** Headers carrying the real provider credential, injected in-flight. */
export function authHeaders(provider: ProviderId, key: string): Record<string, string> {
  switch (provider) {
    case "openai":
    case "groq":
    case "mistral":
    case "together":
    case "deepseek":
    case "gemini":
      return { authorization: `Bearer ${key}` };
    case "anthropic":
      return { "x-api-key": key, "anthropic-version": "2023-06-01" };
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
      return true;
    case "anthropic":
      return false;
  }
}
