// Upstream provider configuration: base URLs and auth-header injection.
export const PROVIDERS = ["openai", "anthropic", "groq", "mistral", "together", "deepseek", "gemini"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export function isProvider(p: string): p is ProviderId {
  return (PROVIDERS as readonly string[]).includes(p);
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
