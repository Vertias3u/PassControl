// Runtime-neutral defaults shared by the shipped CLI and the dashboard.
//
// Capability patterns and concrete provider model ids are different kinds of
// values. Keeping them beside each other, in the one module both runtimes can
// import, prevents onboarding from authorising one model and then calling
// another.
export const DEFAULT_ALLOWED_MODELS = Object.freeze({
  anthropic: "claude-*",
  openai: "gpt-*",
  groq: "openai/gpt-oss-*",
  mistral: "mistral-*",
  together: "openai/gpt-oss-*",
  deepseek: "deepseek-*",
  gemini: "gemini-*",
  xai: "grok-*",
  // OpenRouter's free router: it only ever picks a $0 model, so the default grant
  // spends nothing. A paid model is a scope the operator widens on purpose.
  openrouter: "openrouter/free",
  // An Azure `model` is a DEPLOYMENT name the customer chose, not a model id.
  // `gpt-*` covers deployments named after their model and nothing wider: a bare
  // `*` would widen an allowlist to whatever a resource ever deploys. An operator
  // whose deployments are named otherwise edits the scope.
  azure: "gpt-*",
  // A model on the developer's own server: free to them, and whatever they pulled.
  // The admin API (pull, delete) is outside the endpoint allowlist, so `*` widens
  // which local model an agent may run, never what it may do to the server.
  local: "*",
});

export const DEFAULT_CLIENT_MODELS = Object.freeze({
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5-mini",
  groq: "openai/gpt-oss-20b",
  mistral: "mistral-small-latest",
  together: "openai/gpt-oss-120b",
  deepseek: "deepseek-flash",
  gemini: "gemini-3.8-flash",
  // The cheapest listed model that does not reason (docs.x.ai/developers/models.md,
  // 2026-09-27): xAI's reasoning models cannot turn reasoning off.
  xai: "grok-4.20-0309-non-reasoning",
  // Stable, where individual `:free` model ids come and go.
  openrouter: "openrouter/free",
  // A deployment name, so only a guess until the operator names theirs.
  azure: "gpt-4.1-mini",
  // Ollama's most-pulled small model. Only a guess: the dashboard offers the
  // models the server actually has.
  local: "llama3.2",
});

export function defaultAllowedModelForProvider(provider) {
  return DEFAULT_ALLOWED_MODELS[provider] ?? DEFAULT_ALLOWED_MODELS.anthropic;
}

export function defaultClientModelForProvider(provider) {
  return DEFAULT_CLIENT_MODELS[provider] ?? DEFAULT_CLIENT_MODELS.anthropic;
}
