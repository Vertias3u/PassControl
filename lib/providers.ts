// Upstream provider configuration: base URLs and auth-header injection.
export type ProviderId = "openai" | "anthropic";

export function isProvider(p: string): p is ProviderId {
  return p === "openai" || p === "anthropic";
}

export function upstreamBaseUrl(provider: ProviderId): string {
  switch (provider) {
    case "openai":
      return "https://api.openai.com";
    case "anthropic":
      return "https://api.anthropic.com";
  }
}

/** Headers carrying the real provider credential, injected in-flight. */
export function authHeaders(provider: ProviderId, key: string): Record<string, string> {
  switch (provider) {
    case "openai":
      return { authorization: `Bearer ${key}` };
    case "anthropic":
      return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  }
}
