// Upstream provider configuration: base URLs and auth-header injection.
export const PROVIDERS = ["openai", "anthropic", "groq", "mistral", "together", "deepseek"] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export function isProvider(p: string): p is ProviderId {
  return (PROVIDERS as readonly string[]).includes(p);
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
