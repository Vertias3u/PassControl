import type { ProviderId } from "@/lib/providers";

/** One source for the capability pattern and the concrete model shown by both
 * Direct Agent Key and Passport onboarding. The two values are deliberately
 * separate: the first authorizes; the second is sent to the provider. */
export const DEFAULT_ALLOWED_MODELS: Record<ProviderId, string> = {
  anthropic: "claude-*",
  openai: "gpt-*",
  groq: "llama-*",
  mistral: "mistral-*",
  together: "openai/gpt-oss-*",
  deepseek: "deepseek-*",
};

export const DEFAULT_CLIENT_MODELS: Record<ProviderId, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5-mini",
  groq: "llama-3.3-70b-versatile",
  mistral: "mistral-small-latest",
  together: "openai/gpt-oss-20b",
  deepseek: "deepseek-chat",
};

/** Runtime model ids are copied into environment/configuration blocks and sent
 * verbatim to a provider. Wildcards belong only in the capability pattern. */
export function clientModelIsUsable(value: string): boolean {
  const model = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(model);
}
