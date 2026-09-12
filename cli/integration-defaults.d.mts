export type IntegrationProvider =
  | "anthropic"
  | "openai"
  | "groq"
  | "mistral"
  | "together"
  | "deepseek"
  | "gemini";

export const DEFAULT_ALLOWED_MODELS: Readonly<Record<IntegrationProvider, string>>;
export const DEFAULT_CLIENT_MODELS: Readonly<Record<IntegrationProvider, string>>;
export function defaultAllowedModelForProvider(provider: string): string;
export function defaultClientModelForProvider(provider: string): string;
