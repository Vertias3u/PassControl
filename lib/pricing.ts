// Per-model pricing for cost logging (S6). Costs are tracked in MICRO-CENTS (µ¢):
//   1 cent = 1_000_000 µ¢   ·   1 USD = 100_000_000 µ¢
// Sub-cent per-call costs (a few µ¢) would round to 0 if stored as integer cents;
// micro-cents preserve them. Per-token price in µ¢ = (USD per 1M tokens) * 100,
// which is an exact integer, so costs accumulate with no float drift.
// Patterns reuse the same wildcard semantics as scope matching. Versioned in code.

interface Price {
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
const mc = (usdPerMillion: number) => Math.round(usdPerMillion * 100);

const PRICES: Price[] = [
  // Anthropic
  { pattern: "claude-3-5-sonnet*", inputMicrocentsPerToken: mc(3), outputMicrocentsPerToken: mc(15) },
  { pattern: "claude-3-5-haiku*", inputMicrocentsPerToken: mc(0.8), outputMicrocentsPerToken: mc(4) },
  { pattern: "claude-haiku-4*", inputMicrocentsPerToken: mc(1), outputMicrocentsPerToken: mc(5) },
  { pattern: "claude-3-opus*", inputMicrocentsPerToken: mc(15), outputMicrocentsPerToken: mc(75) },
  { pattern: "claude-opus-4*", inputMicrocentsPerToken: mc(15), outputMicrocentsPerToken: mc(75) },
  { pattern: "claude-sonnet-4*", inputMicrocentsPerToken: mc(3), outputMicrocentsPerToken: mc(15) },
  { pattern: "claude-*", inputMicrocentsPerToken: mc(3), outputMicrocentsPerToken: mc(15) },
  // OpenAI
  { pattern: "gpt-4o-mini*", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: mc(0.6) },
  { pattern: "gpt-4o*", inputMicrocentsPerToken: mc(2.5), outputMicrocentsPerToken: mc(10) },
  { pattern: "gpt-4.1*", inputMicrocentsPerToken: mc(2), outputMicrocentsPerToken: mc(8) },
  { pattern: "o3*", inputMicrocentsPerToken: mc(2), outputMicrocentsPerToken: mc(8) },
];

function matches(pattern: string, model: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(model);
}

/** Cost in integer micro-cents for a token split. 0 if model unknown. */
export function costMicrocents(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES.find((x) => matches(x.pattern, model));
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
