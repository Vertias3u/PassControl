// Upstream provider configuration: base URLs and auth-header injection.
export const PROVIDERS = ["openai", "anthropic", "groq", "mistral", "together", "deepseek"] as const;
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
  }
}

/** Provider model-listing endpoint used by the dashboard import probe. */
export function modelListingUrl(provider: ProviderId): string {
  const base = upstreamBaseUrl(provider);
  return provider === "deepseek" ? `${base}/models` : `${base}/v1/models`;
}

/** Headers carrying the real provider credential, injected in-flight. */
export function authHeaders(provider: ProviderId, key: string): Record<string, string> {
  switch (provider) {
    case "openai":
    case "groq":
    case "mistral":
    case "together":
    case "deepseek":
      return { authorization: `Bearer ${key}` };
    case "anthropic":
      return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  }
}

export function usesOpenAiUsageShape(provider: ProviderId): boolean {
  switch (provider) {
    case "openai":
    case "groq":
    case "mistral":
    case "together":
    case "deepseek":
      return true;
    case "anthropic":
      return false;
  }
}
