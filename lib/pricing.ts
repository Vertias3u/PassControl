// Per-model pricing for cost logging (S6). Costs are tracked in MICRO-CENTS (µ¢):
//   1 cent = 1_000_000 µ¢   ·   1 USD = 100_000_000 µ¢
// Sub-cent per-call costs (a few µ¢) would round to 0 if stored as integer cents;
// micro-cents preserve them. Per-token price in µ¢ = (USD per 1M tokens) * 100,
// rounded up to an integer when a provider publishes fractional prices.
// Patterns reuse the same wildcard semantics as scope matching. Versioned in code.
import type { ProviderId } from "./providers";

interface Price {
  provider: ProviderId;
  pattern: string;
  inputMicrocentsPerToken: number;
  outputMicrocentsPerToken: number;
}

export const MICROCENTS_PER_CENT = 1_000_000;

export interface TokenUsageEstimate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// micro-cents per token = (USD per 1M tokens) * 100. (USD/1e6 tok = 1e8 µ¢/1e6 tok.)
// Round up fractional µ¢/token prices (e.g. $0.075/M = 7.5µ¢) so budget checks
// are conservative and never under-reserve against the provider's published rate.
const mc = (usdPerMillion: number) => Math.ceil(usdPerMillion * 100 - 1e-9);

const PRICES: Price[] = [
  // Anthropic
  { provider: "anthropic", pattern: "claude-3-5-sonnet*", inputMicrocentsPerToken: mc(3), outputMicrocentsPerToken: mc(15) },
  { provider: "anthropic", pattern: "claude-3-5-haiku*", inputMicrocentsPerToken: mc(0.8), outputMicrocentsPerToken: mc(4) },
  { provider: "anthropic", pattern: "claude-haiku-4*", inputMicrocentsPerToken: mc(1), outputMicrocentsPerToken: mc(5) },
  { provider: "anthropic", pattern: "claude-3-opus*", inputMicrocentsPerToken: mc(15), outputMicrocentsPerToken: mc(75) },
  { provider: "anthropic", pattern: "claude-opus-4*", inputMicrocentsPerToken: mc(15), outputMicrocentsPerToken: mc(75) },
  { provider: "anthropic", pattern: "claude-sonnet-4*", inputMicrocentsPerToken: mc(3), outputMicrocentsPerToken: mc(15) },
  { provider: "anthropic", pattern: "claude-*", inputMicrocentsPerToken: mc(3), outputMicrocentsPerToken: mc(15) },
  // OpenAI
  { provider: "openai", pattern: "gpt-4o-mini*", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: mc(0.6) },
  { provider: "openai", pattern: "gpt-4o*", inputMicrocentsPerToken: mc(2.5), outputMicrocentsPerToken: mc(10) },
  { provider: "openai", pattern: "gpt-4.1*", inputMicrocentsPerToken: mc(2), outputMicrocentsPerToken: mc(8) },
  { provider: "openai", pattern: "o3*", inputMicrocentsPerToken: mc(2), outputMicrocentsPerToken: mc(8) },
  // Groq
  { provider: "groq", pattern: "llama-3.1-8b-instant", inputMicrocentsPerToken: mc(0.05), outputMicrocentsPerToken: mc(0.08) },
  { provider: "groq", pattern: "llama-3.3-70b-versatile", inputMicrocentsPerToken: mc(0.59), outputMicrocentsPerToken: mc(0.79) },
  { provider: "groq", pattern: "meta-llama/llama-4-scout-17b-16e-instruct", inputMicrocentsPerToken: mc(0.11), outputMicrocentsPerToken: mc(0.34) },
  { provider: "groq", pattern: "openai/gpt-oss-20b", inputMicrocentsPerToken: mc(0.075), outputMicrocentsPerToken: mc(0.3) },
  { provider: "groq", pattern: "openai/gpt-oss-120b", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: mc(0.6) },
  // Mistral
  { provider: "mistral", pattern: "mistral-medium-latest", inputMicrocentsPerToken: mc(1.5), outputMicrocentsPerToken: mc(7.5) },
  { provider: "mistral", pattern: "mistral-small-latest", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: mc(0.6) },
  { provider: "mistral", pattern: "mistral-large-latest", inputMicrocentsPerToken: mc(0.5), outputMicrocentsPerToken: mc(1.5) },
  { provider: "mistral", pattern: "devstral-medium-latest", inputMicrocentsPerToken: mc(0.4), outputMicrocentsPerToken: mc(2) },
  { provider: "mistral", pattern: "devstral-small-latest", inputMicrocentsPerToken: mc(0.1), outputMicrocentsPerToken: mc(0.3) },
  { provider: "mistral", pattern: "codestral-latest", inputMicrocentsPerToken: mc(0.3), outputMicrocentsPerToken: mc(0.9) },
  { provider: "mistral", pattern: "magistral-medium-latest", inputMicrocentsPerToken: mc(2), outputMicrocentsPerToken: mc(5) },
  { provider: "mistral", pattern: "magistral-small-latest", inputMicrocentsPerToken: mc(0.5), outputMicrocentsPerToken: mc(1.5) },
  { provider: "mistral", pattern: "ministral-3b-latest", inputMicrocentsPerToken: mc(0.1), outputMicrocentsPerToken: mc(0.1) },
  { provider: "mistral", pattern: "ministral-8b-latest", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: mc(0.15) },
  { provider: "mistral", pattern: "ministral-14b-latest", inputMicrocentsPerToken: mc(0.2), outputMicrocentsPerToken: mc(0.2) },
  { provider: "mistral", pattern: "open-mistral-nemo", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: mc(0.15) },
  { provider: "mistral", pattern: "open-mixtral-8x7b", inputMicrocentsPerToken: mc(0.7), outputMicrocentsPerToken: mc(0.7) },
  { provider: "mistral", pattern: "open-mixtral-8x22b", inputMicrocentsPerToken: mc(2), outputMicrocentsPerToken: mc(6) },
  // Together AI
  { provider: "together", pattern: "openai/gpt-oss-20b", inputMicrocentsPerToken: mc(0.05), outputMicrocentsPerToken: mc(0.2) },
  { provider: "together", pattern: "OpenAI/gpt-oss-20B", inputMicrocentsPerToken: mc(0.05), outputMicrocentsPerToken: mc(0.2) },
  { provider: "together", pattern: "openai/gpt-oss-120b", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: mc(0.6) },
  { provider: "together", pattern: "OpenAI/gpt-oss-120B", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: mc(0.6) },
  { provider: "together", pattern: "meta-llama/Llama-3.3-70B*", inputMicrocentsPerToken: mc(1.04), outputMicrocentsPerToken: mc(1.04) },
  { provider: "together", pattern: "MiniMaxAI/MiniMax-M3", inputMicrocentsPerToken: mc(0.3), outputMicrocentsPerToken: mc(1.2) },
  // DeepSeek. Uses cache-miss input pricing so reservations are conservative.
  { provider: "deepseek", pattern: "deepseek-v4-flash", inputMicrocentsPerToken: mc(0.14), outputMicrocentsPerToken: mc(0.28) },
  { provider: "deepseek", pattern: "deepseek-v4-pro", inputMicrocentsPerToken: mc(0.435), outputMicrocentsPerToken: mc(0.87) },
  { provider: "deepseek", pattern: "deepseek-chat", inputMicrocentsPerToken: mc(0.14), outputMicrocentsPerToken: mc(0.28) },
  { provider: "deepseek", pattern: "deepseek-reasoner", inputMicrocentsPerToken: mc(0.14), outputMicrocentsPerToken: mc(0.28) },
];

function matches(pattern: string, model: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(model);
}

/** Cost in integer micro-cents for a token split. 0 if model unknown. */
export function costMicrocents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  provider?: ProviderId
): number {
  const p = PRICES.find((x) => (!provider || x.provider === provider) && matches(x.pattern, model));
  if (!p) return 0;
  return inputTokens * p.inputMicrocentsPerToken + outputTokens * p.outputMicrocentsPerToken;
}

/** Cheap pre-flight usage estimate from a request body. */
export function estimateTokenUsage(body: unknown, fallback = 1000): TokenUsageEstimate {
  try {
    const b = body as { max_tokens?: number; max_completion_tokens?: number; messages?: unknown };
    const rawMax = b.max_tokens ?? b.max_completion_tokens;
    const max = typeof rawMax === "number" && Number.isFinite(rawMax) ? rawMax : 0;
    const promptChars = JSON.stringify(b.messages ?? "").length;
    const promptTokens = Math.ceil(promptChars / 4);
    const outputTokens = Math.max(0, Math.floor(max || 1024));
    const totalTokens = promptTokens + outputTokens;
    if (totalTokens > 0) return { inputTokens: promptTokens, outputTokens, totalTokens };
  } catch {
    // fall through to fallback below
  }
  return { inputTokens: 0, outputTokens: fallback, totalTokens: fallback };
}

/** Cheap pre-flight token estimate from a request body. */
export function estimateTokens(body: unknown, fallback = 1000): number {
  return estimateTokenUsage(body, fallback).totalTokens;
}
