// Runtime-neutral defaults shared by the shipped CLI and the dashboard.
//
// Capability patterns and concrete provider model ids are different kinds of
// values. Keeping them beside each other, in the one module both runtimes can
// import, prevents onboarding from authorising one model and then calling
// another.
export const DEFAULT_ALLOWED_MODELS = Object.freeze({
  anthropic: "claude-*",
  openai: "gpt-*",
  groq: "llama-*",
  mistral: "mistral-*",
  together: "openai/gpt-oss-*",
  deepseek: "deepseek-*",
  gemini: "gemini-*",
});

export const DEFAULT_CLIENT_MODELS = Object.freeze({
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5-mini",
  groq: "llama-3.3-70b-versatile",
  mistral: "mistral-small-latest",
  together: "openai/gpt-oss-20b",
  deepseek: "deepseek-chat",
  gemini: "gemini-2.5-flash",
});

export function defaultAllowedModelForProvider(provider) {
  return DEFAULT_ALLOWED_MODELS[provider] ?? DEFAULT_ALLOWED_MODELS.anthropic;
}

export function defaultClientModelForProvider(provider) {
  return DEFAULT_CLIENT_MODELS[provider] ?? DEFAULT_CLIENT_MODELS.anthropic;
}
