// Per-model pricing for cost logging (S6). Costs are tracked in MICRO-CENTS (µ¢):
//   1 cent = 1_000_000 µ¢   ·   1 USD = 100_000_000 µ¢
// Sub-cent per-call costs (a few µ¢) would round to 0 if stored as integer cents;
// micro-cents preserve them. Per-token price in µ¢ = (USD per 1M tokens) * 100,
// rounded up to an integer when a provider publishes fractional prices.
// Patterns reuse the same wildcard semantics as scope matching. Versioned in code.
import type { ProviderId } from "./providers";
import { choiceCountForEstimate, largestStatedOutputLimit } from "./output-limit";
import { openaiUnknownContainer } from "./providers/openai-containers";

interface Price {
  provider: ProviderId;
  pattern: string;
  inputMicrocentsPerToken: number;
  outputMicrocentsPerToken: number;
  /**
   * The rate for input the provider served from its prompt cache, where its page
   * publishes one and its input count includes those tokens (OpenAI). Absent: a
   * cached token costs the full input rate.
   */
  cachedInputMicrocentsPerToken?: number;
  /**
   * Anthropic's rate for a cache READ (`cache_read_input_tokens`, which is ADDITIONAL
   * to input, unlike the OpenAI field above), where the page publishes one other
   * than the standard 0.1x of input. Absent: 0.1x (`CACHE_READ_RATE`).
   */
  cacheReadMicrocentsPerToken?: number;
  /**
   * The rates a call SETTLES at, by context tier, where the model's page bills a
   * prompt above 272K input tokens at the long rates "for the full request" (GPT-6,
   * GPT-5.6). The fields above stay the long rates and remain what is HELD.
   */
  settle?: { short: TierRates; long: TierRates };
  /**
   * Anthropic's prompt-length pricing (Claude Haiku 5.5): the whole request settles at
   * the tier its PROMPT falls in, the prompt being input plus cache reads plus cache
   * writes, since Anthropic reports the cached parts outside `input_tokens`.
   * `cachedInput` here is the cache-READ rate. The fields above are the long tier and
   * remain what is HELD.
   */
  promptTiers?: { above: number; short: TierRates; long: TierRates };
}

/** µ¢ per token for one context tier. */
interface TierRates {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

export const MICROCENTS_PER_CENT = 1_000_000;
/**
 * The divisor for anything that prints a `$`. Named because the two constants
 * differ by exactly the factor that makes a wrong one look plausible: both
 * statement surfaces divided by MICROCENTS_PER_CENT and wrote a dollar sign in
 * front of the answer, overstating every total 100-fold, and no test failed
 * because the result is still a believable amount of money.
 */
export const MICROCENTS_PER_USD = 100 * MICROCENTS_PER_CENT;

export interface TokenUsageEstimate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// micro-cents per token = (USD per 1M tokens) * 100. (USD/1e6 tok = 1e8 µ¢/1e6 tok.)
// Round up fractional µ¢/token prices (e.g. $0.075/M = 7.5µ¢) so budget checks
// are conservative and never under-reserve against the provider's published rate.
const mc = (usdPerMillion: number) => Math.ceil(usdPerMillion * 100 - 1e-9);

/**
 * One model at one published rate: its exact id, and its dated snapshots
 * (`<id>-20…`, e.g. `claude-haiku-4-5-20251001`, `gpt-4.1-2025-04-14`).
 *
 * Deliberately NOT a prefix wildcard. `gemini-2.5-flash*` also matched
 * `gemini-2.5-flash-image` and `gemini-2.5-flash-preview-tts`, and `o3*` matched
 * `o3-pro` at a tenth of its price: a loose pattern prices a model it has never
 * seen, which is exactly what an agent under a dollar limit must not get
 * (lib/gate.ts refuses a model with no row of its own). A new model gets a row
 * when someone reads its price.
 */
function model(provider: ProviderId, id: string, inputUsd: number, outputUsd: number, cachedInputUsd?: number): Price[] {
  const rates = {
    inputMicrocentsPerToken: mc(inputUsd),
    outputMicrocentsPerToken: mc(outputUsd),
    ...(cachedInputUsd === undefined ? {} : { cachedInputMicrocentsPerToken: mc(cachedInputUsd) }),
  };
  return [
    { provider, pattern: id, ...rates },
    { provider, pattern: `${id}-20*`, ...rates },
  ];
}

/**
 * An Anthropic model whose cache reads are not the standard 0.1x of input. The page
 * gives these in a footnote, so the rate is listed here rather than derived:
 * 0.05x on Opus 5.5 and Sonnet 5.5, 0.025x on Fable 5.1 and Mythos 5.1.
 */
function claudeCacheRead(id: string, inputUsd: number, outputUsd: number, cacheReadUsd: number): Price[] {
  return model("anthropic", id, inputUsd, outputUsd).map((p) => ({ ...p, cacheReadMicrocentsPerToken: mc(cacheReadUsd) }));
}

type TierUsd = [input: number, cached: number, write: number, output: number];
const tierRates = ([input, cached, write, output]: TierUsd): TierRates => ({
  input: mc(input),
  cachedInput: mc(cached),
  cacheWrite: mc(write),
  output: mc(output),
});

/**
 * A model whose page prices prompts above 272K input tokens at long-context rates
 * for the full request, with cache writes above the input rate. It is HELD at the
 * long tier (input at the dearer of input and cache write), as every row is, and
 * settled at the tier the call was billed at (`costMicrocentsForUsage`).
 */
function tiered(provider: ProviderId, id: string, short: TierUsd, long: TierUsd): Price[] {
  const rates = {
    inputMicrocentsPerToken: mc(Math.max(long[0], long[2])),
    outputMicrocentsPerToken: mc(long[3]),
    cachedInputMicrocentsPerToken: mc(long[1]),
    settle: { short: tierRates(short), long: tierRates(long) },
  };
  return [
    { provider, pattern: id, ...rates },
    { provider, pattern: `${id}-20*`, ...rates },
  ];
}

/**
 * An Anthropic model priced by prompt length, with no service-tier condition
 * (`claudePromptTiers`): held at the long tier, settled at the tier the prompt fell in.
 */
function claudePromptTiered(id: string, above: number, short: TierUsd, long: TierUsd): Price[] {
  const rates = {
    inputMicrocentsPerToken: mc(long[0]),
    outputMicrocentsPerToken: mc(long[3]),
    cacheReadMicrocentsPerToken: mc(long[1]),
    promptTiers: { above, short: tierRates(short), long: tierRates(long) },
  };
  return [
    { provider: "anthropic", pattern: id, ...rates },
    { provider: "anthropic", pattern: `${id}-20*`, ...rates },
  ];
}

// Every rate below was read from the provider's own pricing page on 2026-09-27
// (tests/pricing-table.test.ts pins each one with its source). Two rules apply
// wherever a page offers more than one number, in the spirit of `mc()`'s rounding:
// charge the HIGHER, because a budget that under-reserves does not hold.
//   * Long-context rates (OpenAI above 272K, Gemini 3.1 Pro above 200K) are what
//     every row HOLDS: a hold cannot know the prompt's length. GPT-6 and GPT-5.6
//     SETTLE at the tier the call was billed at (`tiered`); everything else settles
//     at the row too.
//   * Input is the higher of the input and cache-WRITE rates where a cache write
//     costs more than input (OpenAI GPT-6 and GPT-5.6), since `prompt_tokens`
//     does not say which of its tokens were written to cache.
//   * Where input varies by modality (Gemini audio), the highest is used.
// Request-level multipliers (a paid service tier, Anthropic fast mode, US-only
// inference) are not in this table at all; under a dollar limit such a request
// is refused instead (lib/gate.ts).
const PRICES: Price[] = [
  // Anthropic — platform.claude.com/docs/en/about-claude/pricing. Re-read 2026-10-08
  // for the cache-read column and the Sonnet 5.5 and Mythos rows. The page does not
  // list the Mythos ids (limited availability); they follow its documented
  // claude-{name}-{major}[-{minor}] scheme.
  ...claudeCacheRead("claude-fable-5-1", 10, 50, 0.25),
  ...claudeCacheRead("claude-mythos-5-1", 10, 50, 0.25),
  ...model("anthropic", "claude-fable-5", 10, 50),
  ...model("anthropic", "claude-mythos-5", 10, 50),
  ...claudeCacheRead("claude-opus-5-5", 4, 20, 0.2),
  ...model("anthropic", "claude-opus-5", 5, 25),
  ...model("anthropic", "claude-opus-4-8", 5, 25),
  ...model("anthropic", "claude-opus-4-7", 5, 25),
  ...model("anthropic", "claude-opus-4-6", 5, 25),
  ...model("anthropic", "claude-opus-4-5", 5, 25),
  ...model("anthropic", "claude-opus-4-1", 15, 75),
  ...model("anthropic", "claude-opus-4-0", 15, 75),
  ...model("anthropic", "claude-opus-4", 15, 75),
  ...claudeCacheRead("claude-sonnet-5-5", 2, 10, 0.1),
  ...model("anthropic", "claude-sonnet-5", 2, 10),
  ...model("anthropic", "claude-sonnet-4-6", 3, 15),
  ...model("anthropic", "claude-sonnet-4-5", 3, 15),
  ...model("anthropic", "claude-sonnet-4-0", 3, 15),
  ...model("anthropic", "claude-sonnet-4", 3, 15),
  // Prompts up to 100,000 tokens, then over: [input, cache hit, 5m cache write, output].
  ...claudePromptTiered("claude-haiku-5-5", 100_000, [0.1, 0.01, 0.125, 0.5], [0.5, 0.05, 0.625, 2.5]),
  ...model("anthropic", "claude-haiku-4-5", 1, 5),
  ...model("anthropic", "claude-3-5-haiku", 0.8, 4),
  ...model("anthropic", "claude-3-5-haiku-latest", 0.8, 4),
  // OpenAI — developers.openai.com/api/docs/pricing, Standard tier. The fifth figure
  // is the cached-input rate (read 2026-10-07, long context where the page gives
  // one, like the input rate); a row without one lists "-" there.
  // GPT-6 and GPT-5.6: [input, cached input, cache write, output], short then long
  // context, read 2026-10-07; their model pages bill >272K "for the full request".
  ...tiered("openai", "gpt-6-astra", [10, 1, 12.5, 50], [20, 2, 25, 75]),
  ...tiered("openai", "gpt-6-sol", [2, 0.2, 2.5, 10], [4, 0.4, 5, 15]),
  // GPT-6.1 Sol: cached reads at 5% of input (its model page), not 10%.
  ...tiered("openai", "gpt-6.1-sol", [2, 0.1, 2.5, 10], [4, 0.2, 5, 15]),
  ...tiered("openai", "gpt-6-luna", [0.1, 0.01, 0.125, 0.5], [0.2, 0.02, 0.25, 0.75]),
  // GPT-5.6 Sol is promotional "at least through November 21, 2026".
  ...tiered("openai", "gpt-5.6-sol", [4, 0.4, 5, 20], [8, 0.8, 10, 30]),
  ...tiered("openai", "gpt-5.6-terra", [2, 0.2, 2.5, 12], [4, 0.4, 5, 18]),
  ...tiered("openai", "gpt-5.6-luna", [0.2, 0.02, 0.25, 1.2], [0.4, 0.04, 0.5, 1.8]),
  // The pricing page gives Cyber no long-context column; its model page prices >272K
  // at 2x input and 1.5x output for the full request, with writes at 1.25x input.
  ...tiered("openai", "gpt-5.6-cyber", [12.5, 1.25, 15.625, 75], [25, 2.5, 31.25, 112.5]),
  ...model("openai", "gpt-5.5-cyber", 12.5, 75, 1.25),
  ...model("openai", "gpt-5.5-pro", 60, 270),
  ...model("openai", "gpt-5.5", 10, 45, 1),
  ...model("openai", "gpt-5.4-pro", 60, 270),
  ...model("openai", "gpt-5.4-mini", 0.75, 4.5, 0.075),
  ...model("openai", "gpt-5.4-nano", 0.2, 1.25, 0.02),
  ...model("openai", "gpt-5.4", 5, 22.5, 0.5),
  ...model("openai", "gpt-5.2-pro", 21, 168),
  ...model("openai", "gpt-5.2", 1.75, 14, 0.175),
  ...model("openai", "gpt-5.1", 1.25, 10, 0.125),
  ...model("openai", "gpt-5-pro", 15, 120),
  ...model("openai", "gpt-5-mini", 0.25, 2, 0.025),
  ...model("openai", "gpt-5-nano", 0.05, 0.4, 0.005),
  ...model("openai", "gpt-5", 1.25, 10, 0.125),
  ...model("openai", "gpt-4.1-mini", 0.4, 1.6, 0.1),
  ...model("openai", "gpt-4.1-nano", 0.1, 0.4, 0.025),
  ...model("openai", "gpt-4.1", 2, 8, 0.5),
  // A dated gpt-4o snapshot priced above the alias: listed before `gpt-4o-20*`.
  { provider: "openai", pattern: "gpt-4o-2024-05-13", inputMicrocentsPerToken: mc(5), outputMicrocentsPerToken: mc(15) },
  ...model("openai", "gpt-4o-mini", 0.15, 0.6, 0.075),
  ...model("openai", "gpt-4o", 2.5, 10, 1.25),
  ...model("openai", "o1-pro", 150, 600),
  ...model("openai", "o1", 15, 60, 7.5),
  ...model("openai", "o3-pro", 20, 80),
  ...model("openai", "o3-mini", 1.1, 4.4, 0.55),
  ...model("openai", "o3", 2, 8, 0.5),
  ...model("openai", "o4-mini", 1.1, 4.4, 0.275),
  { provider: "openai", pattern: "gpt-4-turbo-2024-04-09", inputMicrocentsPerToken: mc(10), outputMicrocentsPerToken: mc(30) },
  { provider: "openai", pattern: "gpt-4-0613", inputMicrocentsPerToken: mc(30), outputMicrocentsPerToken: mc(60) },
  { provider: "openai", pattern: "gpt-3.5-turbo-1106", inputMicrocentsPerToken: mc(1), outputMicrocentsPerToken: mc(2) },
  { provider: "openai", pattern: "gpt-3.5-turbo-0125", inputMicrocentsPerToken: mc(0.5), outputMicrocentsPerToken: mc(1.5) },
  { provider: "openai", pattern: "gpt-3.5-turbo", inputMicrocentsPerToken: mc(0.5), outputMicrocentsPerToken: mc(1.5) },
  // Embeddings: input only, nothing is generated. developers.openai.com/api/docs/pricing,
  // read 2026-09-27. Exact ids, like every row above: these rows sit below the
  // provider's other rates, so they do not change FALLBACK_PRICES (each provider's maximum).
  { provider: "openai", pattern: "text-embedding-3-small", inputMicrocentsPerToken: mc(0.02), outputMicrocentsPerToken: 0 },
  { provider: "openai", pattern: "text-embedding-3-large", inputMicrocentsPerToken: mc(0.13), outputMicrocentsPerToken: 0 },
  { provider: "openai", pattern: "text-embedding-ada-002", inputMicrocentsPerToken: mc(0.1), outputMicrocentsPerToken: 0 },
  // Groq — console.groq.com/docs/models. Its Llama models are now Enterprise,
  // "Contact Sales", with no published price, so they have no row.
  { provider: "groq", pattern: "openai/gpt-oss-120b", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: mc(0.6) },
  { provider: "groq", pattern: "openai/gpt-oss-20b", inputMicrocentsPerToken: mc(0.075), outputMicrocentsPerToken: mc(0.3) },
  { provider: "groq", pattern: "openai/gpt-oss-safeguard-20b", inputMicrocentsPerToken: mc(0.075), outputMicrocentsPerToken: mc(0.3) },
  { provider: "groq", pattern: "qwen/qwen3.8-27b", inputMicrocentsPerToken: mc(0.8), outputMicrocentsPerToken: mc(4) },
  // Mistral — docs.mistral.ai/models/pricing and the model cards' API names.
  { provider: "mistral", pattern: "mistral-large-latest", inputMicrocentsPerToken: mc(0.5), outputMicrocentsPerToken: mc(1.5) },
  { provider: "mistral", pattern: "mistral-large-2512", inputMicrocentsPerToken: mc(0.5), outputMicrocentsPerToken: mc(1.5) },
  { provider: "mistral", pattern: "mistral-medium-latest", inputMicrocentsPerToken: mc(1.5), outputMicrocentsPerToken: mc(7.5) },
  { provider: "mistral", pattern: "mistral-small-latest", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: mc(0.6) },
  { provider: "mistral", pattern: "mistral-small-2603", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: mc(0.6) },
  { provider: "mistral", pattern: "ministral-14b-latest", inputMicrocentsPerToken: mc(0.2), outputMicrocentsPerToken: mc(0.2) },
  { provider: "mistral", pattern: "ministral-14b-2512", inputMicrocentsPerToken: mc(0.2), outputMicrocentsPerToken: mc(0.2) },
  { provider: "mistral", pattern: "ministral-8b-latest", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: mc(0.15) },
  { provider: "mistral", pattern: "ministral-8b-2512", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: mc(0.15) },
  { provider: "mistral", pattern: "ministral-3b-latest", inputMicrocentsPerToken: mc(0.1), outputMicrocentsPerToken: mc(0.1) },
  { provider: "mistral", pattern: "ministral-3b-2512", inputMicrocentsPerToken: mc(0.1), outputMicrocentsPerToken: mc(0.1) },
  { provider: "mistral", pattern: "codestral-latest", inputMicrocentsPerToken: mc(0.3), outputMicrocentsPerToken: mc(0.9) },
  { provider: "mistral", pattern: "codestral-2508", inputMicrocentsPerToken: mc(0.3), outputMicrocentsPerToken: mc(0.9) },
  // Embeddings: input only. mistral.ai/pricing/api, read 2026-09-27. Exact ids per the
  // docs' models overview (`mistral-embed-23-12`, `codestral-embed-25-05`), the Codestral
  // Embed launch post (`codestral-embed-2505`) and the two aliases.
  { provider: "mistral", pattern: "mistral-embed", inputMicrocentsPerToken: mc(0.1), outputMicrocentsPerToken: 0 },
  { provider: "mistral", pattern: "mistral-embed-23-12", inputMicrocentsPerToken: mc(0.1), outputMicrocentsPerToken: 0 },
  { provider: "mistral", pattern: "mistral-embed-2312", inputMicrocentsPerToken: mc(0.1), outputMicrocentsPerToken: 0 },
  { provider: "mistral", pattern: "codestral-embed", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: 0 },
  { provider: "mistral", pattern: "codestral-embed-25-05", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: 0 },
  { provider: "mistral", pattern: "codestral-embed-2505", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: 0 },
  // Together AI — together.ai/pricing, Serverless. The page names models by
  // display name; only those whose API id is unambiguous have a row.
  { provider: "together", pattern: "openai/gpt-oss-120b", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: mc(0.6) },
  { provider: "together", pattern: "OpenAI/gpt-oss-120B", inputMicrocentsPerToken: mc(0.15), outputMicrocentsPerToken: mc(0.6) },
  { provider: "together", pattern: "meta-llama/Llama-3.3-70B-Instruct-Turbo", inputMicrocentsPerToken: mc(1.04), outputMicrocentsPerToken: mc(1.04) },
  { provider: "together", pattern: "MiniMaxAI/MiniMax-M3", inputMicrocentsPerToken: mc(0.3), outputMicrocentsPerToken: mc(1.2) },
  // DeepSeek — api-docs.deepseek.com/quick_start/pricing. PEAK rates (off-peak
  // is half; the table has no clock). `deepseek-v4-flash` is a legacy name
  // "billed at the Flash price"; `deepseek-chat` / `deepseek-reasoner` were
  // discontinued on 2026-07-24 and have no row.
  { provider: "deepseek", pattern: "deepseek-flash", inputMicrocentsPerToken: mc(0.3), outputMicrocentsPerToken: mc(1.2) },
  { provider: "deepseek", pattern: "deepseek-v4-flash", inputMicrocentsPerToken: mc(0.3), outputMicrocentsPerToken: mc(1.2) },
  { provider: "deepseek", pattern: "deepseek-v4-flash-vision-exp", inputMicrocentsPerToken: mc(0.3), outputMicrocentsPerToken: mc(1.2) },
  { provider: "deepseek", pattern: "deepseek-v4-pro", inputMicrocentsPerToken: mc(1.32), outputMicrocentsPerToken: mc(3.96) },
  // Gemini — ai.google.dev/gemini-api/docs/pricing, Standard, paid tier.
  // 3.6 / 3.7 / 3.8 Flash are promotional "through December 31, 2026", then
  // $1.50 in / $7.50 out; tests/pricing-table.test.ts goes red before that date.
  { provider: "gemini", pattern: "gemini-3.8-flash", inputMicrocentsPerToken: mc(0.75), outputMicrocentsPerToken: mc(3.75) },
  { provider: "gemini", pattern: "gemini-3.7-flash", inputMicrocentsPerToken: mc(0.75), outputMicrocentsPerToken: mc(3.75) },
  { provider: "gemini", pattern: "gemini-3.6-flash", inputMicrocentsPerToken: mc(0.75), outputMicrocentsPerToken: mc(3.75) },
  { provider: "gemini", pattern: "gemini-3.5-flash", inputMicrocentsPerToken: mc(1.5), outputMicrocentsPerToken: mc(9) },
  { provider: "gemini", pattern: "gemini-3.5-flash-lite", inputMicrocentsPerToken: mc(0.3), outputMicrocentsPerToken: mc(2.5) },
  { provider: "gemini", pattern: "gemini-3.1-flash-lite", inputMicrocentsPerToken: mc(0.5), outputMicrocentsPerToken: mc(1.5) },
  { provider: "gemini", pattern: "gemini-3.1-pro-preview", inputMicrocentsPerToken: mc(4), outputMicrocentsPerToken: mc(18) },
  { provider: "gemini", pattern: "gemini-3.1-pro-preview-customtools", inputMicrocentsPerToken: mc(4), outputMicrocentsPerToken: mc(18) },
  { provider: "gemini", pattern: "gemini-3-flash-preview", inputMicrocentsPerToken: mc(1), outputMicrocentsPerToken: mc(3) },
  // Omni's output is $9 for text and $17.50 for video; the higher is used.
  { provider: "gemini", pattern: "gemini-omni-1.1-flash", inputMicrocentsPerToken: mc(1.5), outputMicrocentsPerToken: mc(17.5) },
  { provider: "gemini", pattern: "gemini-omni-flash-preview", inputMicrocentsPerToken: mc(1.5), outputMicrocentsPerToken: mc(17.5) },
  { provider: "gemini", pattern: "gemini-2.5-pro", inputMicrocentsPerToken: mc(2.5), outputMicrocentsPerToken: mc(15) },
  { provider: "gemini", pattern: "gemini-2.5-flash", inputMicrocentsPerToken: mc(1), outputMicrocentsPerToken: mc(2.5) },
  { provider: "gemini", pattern: "gemini-2.5-flash-lite", inputMicrocentsPerToken: mc(0.3), outputMicrocentsPerToken: mc(0.4) },
  // xAI (docs.x.ai/developers/models.md, read 2026-09-27). Every row is the
  // ≥200k-prompt rate: xAI bills ALL tokens of a request at the higher rate once its
  // prompt reaches 200k, so the lower rate would under-reserve every long prompt.
  // Cached-input discounts are not applied — over-counts, never under. Do NOT
  // "correct" these down to the headline <200k figures. Output is billed as
  // total − input (lib/usage/parseStream.ts), so reasoning is charged at the output
  // rate, as xAI bills it. Exact ids, no `grok-*` catch-all: an unlisted Grok model
  // under a dollar limit is refused (lib/gate.ts), like every other provider's.
  { provider: "xai", pattern: "grok-4.7", inputMicrocentsPerToken: mc(4), outputMicrocentsPerToken: mc(12) },
  { provider: "xai", pattern: "grok-4.6", inputMicrocentsPerToken: mc(4), outputMicrocentsPerToken: mc(12) },
  { provider: "xai", pattern: "grok-4.5", inputMicrocentsPerToken: mc(4), outputMicrocentsPerToken: mc(12) },
  { provider: "xai", pattern: "grok-4.3", inputMicrocentsPerToken: mc(2.5), outputMicrocentsPerToken: mc(5) },
  { provider: "xai", pattern: "grok-4.20-0309-reasoning", inputMicrocentsPerToken: mc(2.5), outputMicrocentsPerToken: mc(5) },
  { provider: "xai", pattern: "grok-4.20-0309-non-reasoning", inputMicrocentsPerToken: mc(2.5), outputMicrocentsPerToken: mc(5) },
  { provider: "xai", pattern: "grok-4.20-multi-agent-0309", inputMicrocentsPerToken: mc(2.5), outputMicrocentsPerToken: mc(5) },
  { provider: "xai", pattern: "grok-build-0.1", inputMicrocentsPerToken: mc(2), outputMicrocentsPerToken: mc(4) },
];

const FALLBACK_PRICES = PRICES.reduce<Partial<Record<ProviderId, Price>>>((acc, price) => {
  const current = acc[price.provider];
  acc[price.provider] = current
    ? {
        provider: price.provider,
        pattern: "*",
        inputMicrocentsPerToken: Math.max(current.inputMicrocentsPerToken, price.inputMicrocentsPerToken),
        outputMicrocentsPerToken: Math.max(current.outputMicrocentsPerToken, price.outputMicrocentsPerToken),
      }
    : // No cached rate: an unlisted model gets no cache discount.
      {
        provider: price.provider,
        pattern: "*",
        inputMicrocentsPerToken: price.inputMicrocentsPerToken,
        outputMicrocentsPerToken: price.outputMicrocentsPerToken,
      };
  return acc;
}, {});

function matches(pattern: string, model: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(model);
}

/**
 * The row that prices this model, if one does. Gemini's model listing spells ids
 * `models/gemini-…` and a client may send either spelling, so the prefix is
 * dropped before matching — in this one place, so the estimate, the settle and
 * the dollar-limit refusal can never disagree about a model.
 */
function listedPrice(model: string, provider?: ProviderId): Price | undefined {
  const id = model.startsWith("models/") ? model.slice("models/".length) : model;
  return PRICES.find((x) => (!provider || x.provider === provider) && matches(x.pattern, id));
}

function priceFor(model: string, provider?: ProviderId): Price | undefined {
  return listedPrice(model, provider) ?? (provider ? FALLBACK_PRICES[provider] : undefined);
}

/**
 * Is a call to this endpoint something we can put a price on?
 *
 * Only calls to the provider's own host are priced. A custom endpoint is
 * unpriced EVEN WHEN THE MODEL NAME MATCHES ONE WE KNOW, and that is the part
 * worth stating: `gpt-4o-mini` arriving from somebody's own proxy may be marked
 * up, re-routed to a different provider, aliased onto a local model, or free.
 * Charging OpenAI's retail rate because a string matched would be a number the
 * operator could act on and we could not stand behind — the same class of false
 * assurance as an unenforced proof upgrading a receipt.
 *
 * Separate from the cost functions so a surface can say "not priced" rather than
 * "$0.00". A silent zero on a spend graph is worse than a visible gap.
 */
export function isPricedEndpoint(endpointBaseUrl: string | null | undefined): boolean {
  return !endpointBaseUrl;
}

/** Cost in integer micro-cents for a token split. Falls back per provider when possible. */
/**
 * The keyless demo's flat rate, and the only place it is written down.
 *
 * The demo synthesizes its response, so there is no invoice to price against —
 * but it debits the SAME counters as a billed call, deliberately, so the budget
 * and kill demos show real behaviour. That makes the rate a number two readers
 * must agree on: the proxy, which charges it, and the decision trace, which
 * projects it. They did not: the trace priced demo through `costMicrocents`,
 * which has no row for it and answers 0, so the panel called every demo call
 * affordable no matter how little of the cap was left.
 *
 * `costMicrocents` deliberately still refuses to price it. A pricing row would
 * imply a tariff for a provider that has no bill, and would silently give a
 * `demo` string a cost anywhere a real provider is expected.
 */
export const DEMO_MICROCENTS_PER_TOKEN = 1;

/** What a demo call of this size costs, for whoever needs to charge or project it. */
export function demoCostMicrocents(totalTokens: number): number {
  return Math.max(0, Math.trunc(totalTokens)) * DEMO_MICROCENTS_PER_TOKEN;
}

/**
 * A provider priced per call rather than from this table: OpenRouter, whose model
 * runs on whichever of several endpoints routing picks, at prices up to ~7x apart.
 * Its hold is priced from its own endpoint listing and its settlement is the cost
 * it reports (lib/providers/openrouter.ts; DECISIONS 2026-10-07). It has no rows
 * and no fallback here, so nothing in this file can put a number on one of its calls.
 */
export function isLivePricedProvider(provider: ProviderId): boolean {
  return provider === "openrouter";
}

/**
 * Whether a model has a row of its own, rather than billing at its provider's
 * fallback (the highest listed rate, which exists only so that an unlisted model
 * never bills 0). Under a dollar limit, a model without one is refused.
 */
export function hasListedPrice(model: string, provider: ProviderId): boolean {
  return listedPrice(model, provider) !== undefined;
}

/**
 * Service tiers the table's rates describe. `flex` bills below Standard (the
 * table over-charges it, the safe direction); `auto` is each provider's default
 * routing. Anything else — OpenAI Fast/"priority" (~2x), Gemini and Mistral
 * Priority, OpenAI `scale`, a value nobody documented — is priced above its row.
 */
const TABLE_SERVICE_TIERS: ReadonlySet<string> = new Set(["auto", "default", "standard", "standard_only", "flex"]);

/**
 * The request field that would make this call cost more than its table row, or
 * null. Under a dollar limit the proxy refuses such a request (409
 * `unpriced_option`), for the reason an unpriced model is refused.
 *
 * Known gap, stated rather than guessed at: an OpenAI project whose default
 * service tier is set to Fast in OpenAI's settings bills requests that send no
 * `service_tier` at the Fast rate, and nothing in the request shows it. The
 * response's own `service_tier` does; pricing from it is a follow-up.
 */
export function unpricedRequestOption(provider: ProviderId, body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const set = (v: unknown) => v !== undefined && v !== null;
  if (set(b.service_tier) && !(typeof b.service_tier === "string" && TABLE_SERVICE_TIERS.has(b.service_tier))) {
    return "service_tier";
  }
  if (provider === "openai" && Array.isArray(b.tools)) {
    // A reused code interpreter or shell container: its memory tier, which sets
    // its price, is not in the request (lib/providers/openai-containers.ts).
    if (openaiUnknownContainer(b)) return "container";
  }
  if (provider === "anthropic") {
    // platform.claude.com pricing: fast mode on Opus 5.5 / 5 / 4.8 at 2x;
    // `inference_geo: "us"` at 1.1x on Claude 4.6 and later.
    if (set(b.speed) && b.speed !== "standard") return "speed";
    if (set(b.inference_geo) && b.inference_geo !== "global") return "inference_geo";
  }
  return null;
}

export function costMicrocents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  provider?: ProviderId,
  endpointBaseUrl?: string | null
): number {
  if (!isPricedEndpoint(endpointBaseUrl)) return 0;
  const p = priceFor(model, provider);
  // A known provider should always have a fallback row. Returning 0 here means a
  // provider was added without pricing rows, which should be treated as a bug —
  // except a provider with no host of its own (Azure), which is never priced by
  // design and never reaches this line: it always has an endpoint, so it returns
  // 0 above as unpriced, and a dollar limit refuses it at the gate.
  if (!p) return 0;
  return inputTokens * p.inputMicrocentsPerToken + outputTokens * p.outputMicrocentsPerToken;
}

// ── Prompt-cache rates ────────────────────────────────────────────────────────
//
// Anthropic prices cache traffic as a multiplier on the model's OWN input rate,
// so these are derived rather than listed per model:
//
//   read  — 0.1x. A cached prompt is the cheap case, and the reason agents cache.
//           Except where a row lists its own (`claudeCacheRead`): the page prices
//           reads on four models below 0.1x, and deriving them charged a cache-heavy
//           session on Opus 5.5 twice the real rate and on Fable 5.1 four times.
//           A NEW model row must be checked against the page's cache column: the
//           derivation is a default, not a guarantee.
//   write — 1.25x at the default 5-minute TTL.
//
// Rounded UP to a whole µ¢/token for the same reason `mc()` is: a fractional rate
// would truncate to 0 for the cheap models and stop counting entirely.
const CACHE_READ_RATE = (inputRate: number) => Math.ceil(inputRate * 0.1);
const CACHE_WRITE_RATE = (inputRate: number) => Math.ceil(inputRate * 1.25);

/** The rate for one Anthropic cache-read token on this row. */
const cacheReadRate = (p: Price) => p.cacheReadMicrocentsPerToken ?? CACHE_READ_RATE(p.inputMicrocentsPerToken);

/**
 * How much more than the input rate an Anthropic request's prompt may cost to
 * WRITE to the prompt cache: 1 when it asks for no caching, 1.25 for the default
 * 5-minute TTL, 2 when any breakpoint asks for 1 hour (pricing page, read
 * 2026-10-08). Any `cache_control`, on a block, a tool, the system prompt or the
 * request itself (automatic caching), counts.
 */
export function cacheWriteHoldMultiplier(body: unknown): 1 | 1.25 | 2 {
  let found: 1 | 1.25 | 2 = 1;
  const walk = (value: unknown, depth: number): void => {
    if (found === 2 || depth > 64 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    const o = value as Record<string, unknown>;
    const cc = o.cache_control;
    if (cc !== null && typeof cc === "object") {
      found = (cc as { ttl?: unknown }).ttl === "1h" ? 2 : found === 1 ? 1.25 : found;
    }
    for (const [key, v] of Object.entries(o)) if (key !== "cache_control") walk(v, depth + 1);
  };
  walk(body, 0);
  return found;
}

/**
 * The hold for a call (P5.1, owner 2026-10-08): `costMicrocents`, except that an
 * Anthropic request asking for caching holds its input at the cache-WRITE rate.
 * Claude Code marks its prompt for the 5-minute cache, and a session's first call
 * writes all of it at 1.25x; held at 1x it was held at ~94% of its cost even with
 * the P1.6 estimate. Later calls read the cache at 0.1x or less, so this over-holds
 * them, as every hold may; settlement charges what Anthropic reports.
 */
export function holdMicrocents(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
  provider: ProviderId,
  body: unknown
): number {
  const base = costMicrocents(model, usage.inputTokens, usage.outputTokens, provider);
  if (provider !== "anthropic") return base;
  const multiplier = cacheWriteHoldMultiplier(body);
  const p = multiplier === 1 ? undefined : priceFor(model, provider);
  if (!p) return base;
  const writeRate =
    multiplier === 2
      ? Math.ceil(p.inputMicrocentsPerToken * 2)
      : (p.promptTiers?.long.cacheWrite ?? CACHE_WRITE_RATE(p.inputMicrocentsPerToken));
  return usage.inputTokens * writeRate + usage.outputTokens * p.outputMicrocentsPerToken;
}

/** OpenAI's line between short- and long-context pricing: "more than 272K input tokens". */
const LONG_CONTEXT_ABOVE = 272_000;

/**
 * Service tiers, as a RESPONSE reports them, that bill a tiered model at its
 * Standard rates or below. Anything else, or none, settles at the row's long
 * rates: a project whose default tier is Fast is billed 2x with nothing in the
 * request to say so, and the long rates are the closest the table comes to it.
 */
const STANDARD_RESPONSE_TIERS: ReadonlySet<string> = new Set(["default", "flex"]);

/**
 * A tiered model's settlement (`tiered`), or null to settle at the row. The tier is
 * chosen by the reported input, cached tokens included. The cache-write count is
 * used only when it fits inside the uncached input; otherwise every uncached token
 * is charged at the write rate, the dearer of the two.
 */
function tieredCost(
  p: Price,
  usage: { inputTokens: number; outputTokens: number; cacheWriteInputTokens?: number; serviceTier?: string },
  cached: number
): number | null {
  if (!p.settle || typeof usage.serviceTier !== "string" || !STANDARD_RESPONSE_TIERS.has(usage.serviceTier)) return null;
  const r = usage.inputTokens > LONG_CONTEXT_ABOVE ? p.settle.long : p.settle.short;
  const uncached = usage.inputTokens - cached;
  const w = usage.cacheWriteInputTokens;
  const written = typeof w === "number" && Number.isSafeInteger(w) && w >= 0 && w <= uncached ? w : null;
  const input = written === null ? uncached * r.cacheWrite : (uncached - written) * r.input + written * r.cacheWrite;
  return input + cached * r.cachedInput + usage.outputTokens * r.output;
}

/**
 * A prompt-length-tiered Anthropic settlement (`claudePromptTiered`). "Up to 100,000
 * tokens" is the short tier, so the line itself is short.
 */
function claudePromptTierCost(
  t: NonNullable<Price["promptTiers"]>,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
): number {
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const r = prompt > t.above ? t.long : t.short;
  return (
    usage.inputTokens * r.input +
    usage.cacheReadTokens * r.cachedInput +
    usage.cacheWriteTokens * r.cacheWrite +
    usage.outputTokens * r.output
  );
}

/**
 * The rate for one cached input token. Never above the input rate, and the input
 * rate itself where the row publishes no cached rate (or for the fallback row).
 */
function cachedInputRate(p: Price): number {
  return Math.min(p.cachedInputMicrocentsPerToken ?? p.inputMicrocentsPerToken, p.inputMicrocentsPerToken);
}

/**
 * Cost in integer micro-cents for a call INCLUDING its prompt-cache traffic.
 *
 * Use this for a settled call. `costMicrocents` above stays the estimate path: a
 * pre-flight estimate is derived from the request body and cannot know what the
 * provider will serve from cache.
 *
 * Known gap, deliberately not guessed at: a cache write made with the opt-in
 * 1-hour TTL costs 2x rather than 1.25x, and Anthropic reports only the combined
 * `cache_creation_input_tokens` unless the newer `usage.cache_creation` breakdown
 * is present. Charging every write at 1.25x is therefore exact for the default
 * TTL and under-charges a 1-hour writer by 0.75x on the write portion alone.
 * Pricing every write at 2x instead would overcharge the common case by 60%,
 * which is the larger error. Closing it properly means parsing
 * `usage.cache_creation` into two buckets.
 */
export function costMicrocentsForUsage(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /**
     * Of `inputTokens`, how many OpenAI served from its prompt cache (a SUBSET,
     * unlike the two Anthropic fields above, which are additional). Charged at the
     * row's cached rate; a count above `inputTokens` is inconsistent and ignored.
     */
    cachedInputTokens?: number;
    /** Of `inputTokens`, how many were written to OpenAI's cache, where reported (Responses). */
    cacheWriteInputTokens?: number;
    /** The service tier the RESPONSE says the call ran on. */
    serviceTier?: string;
  },
  model: string,
  provider?: ProviderId,
  endpointBaseUrl?: string | null
): number {
  // Unpriced rather than mispriced — see isPricedEndpoint. The tokens are still
  // counted and logged; only the money is unknown.
  if (!isPricedEndpoint(endpointBaseUrl)) return 0;
  const p = priceFor(model, provider);
  if (!p) return 0;
  if (p.promptTiers) return claudePromptTierCost(p.promptTiers, usage);
  const reported = usage.cachedInputTokens ?? 0;
  const cached = reported > 0 && reported <= usage.inputTokens ? reported : 0;
  const tier = tieredCost(p, usage, cached);
  // The Anthropic cache fields are 0 for every tiered (OpenAI) row; kept in the sum
  // so the two paths cannot disagree if that ever changes.
  if (tier !== null) {
    return (
      tier +
      usage.cacheReadTokens * cacheReadRate(p) +
      usage.cacheWriteTokens * CACHE_WRITE_RATE(p.inputMicrocentsPerToken)
    );
  }
  return (
    (usage.inputTokens - cached) * p.inputMicrocentsPerToken +
    cached * cachedInputRate(p) +
    usage.outputTokens * p.outputMicrocentsPerToken +
    usage.cacheReadTokens * cacheReadRate(p) +
    usage.cacheWriteTokens * CACHE_WRITE_RATE(p.inputMicrocentsPerToken)
  );
}

/**
 * Every top-level request field a provider bills as INPUT, across the body
 * shapes the gateway routes: chat `messages`, Responses `input` and
 * `instructions`, Anthropic `system`, tool definitions (`tools`, and OpenAI's
 * legacy `functions`), plus Gemini-native `contents`/`systemInstruction`.
 *
 * The native Gemini API is not a routed shape today — Gemini goes through its
 * OpenAI-compatible endpoint — so those two only keep the estimate from being
 * blind to such a body if one ever arrives.
 *
 * This used to read `messages ?? input` alone, so a request whose weight was a
 * large `system` prompt or tool list reserved as if it were a one-line chat,
 * and an agent near its cap was admitted for a call its budget could not cover.
 * The estimate decides admission and the hold's size; settlement charges the
 * provider's reported usage where there is one, so there a larger estimate only
 * refuses a near-cap agent sooner. On an outcome with no usage report the
 * estimate itself is charged (see `estimateTokenUsage`).
 */
const PROMPT_FIELDS = [
  "messages",
  "input",
  "instructions",
  "system",
  "tools",
  "functions",
  "contents",
  "systemInstruction",
] as const;

// ── How many tokens a prompt is, before the provider says ────────────────────
//
// UTF-8 bytes of the prompt fields' JSON per token, by the model's tokenizer.
// Measured 2026-10-08 through the gateway (tests/estimate-tokenizer.test.ts has the
// table): a real Claude Code request ran at 2.82 on Anthropic's newer tokenizer
// (Claude 4.7 and later, Fable, Mythos) and 3.81 on the older one; source code at 2.65
// and 3.29; Bulgarian at 4.46 on both. Characters ÷ 4, the old rule for every model,
// held 70% of a Claude Code request and 61% of a Bulgarian one.
const NEW_TOKENIZER_BYTES = 2.4;
const OLD_TOKENIZER_BYTES = 3.2;
const DEFAULT_BYTES = 4;
// Base64 is not text: PDFs and other providers' images at ÷ 4, Claude images at a
// per-image ceiling (see `promptMedia`, `claudeImageTokenCeiling`).
const BASE64_BYTES = 4;

/**
 * The divisor for a model id, as a hold must assume it. Anthropic: "Claude 4.7 and
 * later models and Claude Mythos Preview use a newer tokenizer" (pricing page, read
 * 2026-10-08). Read from the id alone, so OpenRouter's `anthropic/claude-opus-4.7`
 * gets it too. A Claude id this cannot read, and a routing id that names no model
 * (`openrouter/auto`, a preset) and may land on Claude, get the newer, smaller
 * divisor: an estimate errs high.
 */
export function promptBytesPerToken(model: unknown): number {
  if (typeof model !== "string" || !model) return DEFAULT_BYTES;
  const m = model.toLowerCase();
  if (m === "openrouter/auto" || m.startsWith("openrouter/") || m.includes("@preset")) return NEW_TOKENIZER_BYTES;
  if (!m.includes("claude")) return DEFAULT_BYTES;
  if (/claude-\d/.test(m)) return OLD_TOKENIZER_BYTES; // claude-3-5-haiku, claude-3-opus
  const v = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2})(?!\d))?/.exec(m);
  if (!v) return NEW_TOKENIZER_BYTES;
  if (v[1] === "fable" || v[1] === "mythos") return NEW_TOKENIZER_BYTES;
  const major = Number(v[2]);
  const minor = v[3] === undefined ? 0 : Number(v[3]);
  return major > 4 || (major === 4 && minor >= 7) ? NEW_TOKENIZER_BYTES : OLD_TOKENIZER_BYTES;
}

const utf8 = new TextEncoder();

/**
 * Most visual tokens one image can cost on a Claude model: Anthropic resizes an
 * image to at most 2576 px on the long edge / 4,784 tokens on Claude 4.7 and later,
 * and 1568 px / 1,568 tokens on the rest (vision docs, read 2026-10-08). Null for a
 * model that is not Claude: its images keep bytes ÷ 4.
 */
export function claudeImageTokenCeiling(model: unknown): number | null {
  if (typeof model !== "string" || !model.toLowerCase().includes("claude")) return null;
  return promptBytesPerToken(model) === NEW_TOKENIZER_BYTES ? 4_784 : 1_568;
}

const IMAGE_BLOCK_TYPES: ReadonlySet<string> = new Set(["image", "image_url", "input_image"]);

/**
 * The media inside a prompt value. `base64`: characters of base64 payload (an
 * Anthropic image or document `source` of type base64, any `data:` URL, `file_data`);
 * base64 is ASCII and JSON leaves it unescaped, so these are exactly the bytes it
 * takes. `imageBase64`: the part of that inside image blocks. `images`: image blocks
 * of any source (base64, URL, file id), Anthropic's and OpenAI's shapes.
 */
function promptMedia(value: unknown): { base64: number; imageBase64: number; images: number } {
  const out = { base64: 0, imageBase64: 0, images: 0 };
  const walk = (v: unknown, depth: number, inImage: boolean): void => {
    if (depth > 64 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1, inImage);
      return;
    }
    const o = v as Record<string, unknown>;
    const isImage = !inImage && typeof o.type === "string" && IMAGE_BLOCK_TYPES.has(o.type);
    if (isImage) out.images += 1;
    const image = inImage || isImage;
    for (const [key, item] of Object.entries(o)) {
      if (typeof item === "string") {
        if ((key === "data" && o.type === "base64") || key === "file_data" || item.startsWith("data:")) {
          out.base64 += item.length;
          if (image) out.imageBase64 += item.length;
        }
      } else {
        walk(item, depth + 1, image);
      }
    }
  };
  walk(value, 0, false);
  return out;
}

/**
 * Cheap pre-flight usage estimate from a request body.
 *
 * `model` is the model this estimate is for: a fallback attempt passes its own,
 * since the prompt is the same but the tokenizer may not be. Defaults to the body's.
 *
 * What it decides: admission against every limit and the hold's size, and, on the
 * outcomes where a call may have been billed but reported nothing (`settleUnknown`,
 * max(observed, estimate)), the amount charged. Where usage is reported, settlement
 * charges the reported usage.
 */
export function estimateTokenUsage(body: unknown, fallback = 1000, model?: string): TokenUsageEstimate {
  try {
    const b = body as Partial<Record<(typeof PROMPT_FIELDS)[number], unknown>> & { model?: unknown };
    // The LARGEST stated alias, times the choices asked for. This used to take
    // the first alias present and ignore `n`, and both under-reserve: a small
    // deprecated `max_tokens` beside a large `max_completion_tokens`, or `n: 4`
    // reserving one completion's worth. See lib/output-limit.ts.
    const max = largestStatedOutputLimit(body) ?? 0;
    const present = PROMPT_FIELDS.filter((field) => b[field] !== undefined && b[field] !== null);
    // No prompt field at all keeps the old `JSON.stringify("")` floor (2 bytes,
    // 1 token), so an empty body and the decision-trace projection are unchanged.
    let textBytes = present.length ? 0 : JSON.stringify("").length;
    let base64 = 0;
    let imageBase64 = 0;
    let images = 0;
    for (const field of present) {
      const media = promptMedia(b[field]);
      textBytes += utf8.encode(JSON.stringify(b[field])).length - media.base64;
      base64 += media.base64;
      imageBase64 += media.imageBase64;
      images += media.images;
    }
    const forModel = model ?? b?.model;
    const divisor = promptBytesPerToken(forModel);
    // A Claude image is billed by its pixels, capped per image (P5.2): hold each at
    // the model's ceiling, whatever its bytes or source. Anything else keeps ÷ 4.
    const ceiling = claudeImageTokenCeiling(forModel);
    const mediaTokens =
      ceiling === null
        ? Math.ceil(base64 / BASE64_BYTES)
        : Math.ceil((base64 - imageBase64) / BASE64_BYTES) + images * ceiling;
    const promptTokens = Math.ceil(textBytes / divisor) + mediaTokens;
    const outputTokens = Math.max(0, Math.floor(max || 1024)) * choiceCountForEstimate(body);
    const totalTokens = promptTokens + outputTokens;
    if (totalTokens > 0) return { inputTokens: promptTokens, outputTokens, totalTokens };
  } catch {
    // fall through to fallback below
  }
  return { inputTokens: 0, outputTokens: fallback, totalTokens: fallback };
}

/** A pre-tokenised embeddings input: a non-empty array of whole numbers. */
function isTokenArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((t) => typeof t === "number" && Number.isInteger(t));
}

/**
 * Pre-flight estimate for an embeddings request.
 *
 * An embedding generates nothing, so no output is reserved: `estimateTokenUsage`
 * would reserve a stated limit or 1024 for every call, refusing an agent near
 * its cap for a call its budget covers. Input is sized like chat (characters ÷
 * 4 of the JSON text) except pre-tokenised input — `number[]` or `number[][]` —
 * which is counted exactly, one token per number. Anything else (missing,
 * malformed, mixed) is read as text; a body the provider will refuse keeps the
 * same one-token floor an empty chat body gets.
 */
export function estimateEmbeddingUsage(body: unknown): TokenUsageEstimate {
  const input = typeof body === "object" && body !== null ? (body as { input?: unknown }).input : undefined;
  let inputTokens: number;
  if (isTokenArray(input)) {
    inputTokens = input.length;
  } else if (Array.isArray(input) && input.length > 0 && input.every(isTokenArray)) {
    inputTokens = input.reduce((sum, row) => sum + row.length, 0);
  } else if (Array.isArray(input) && input.every((s) => typeof s === "string")) {
    inputTokens = input.reduce((sum, s) => sum + Math.ceil(JSON.stringify(s).length / 4), 0);
  } else {
    const text = input === undefined || input === null ? "" : input;
    inputTokens = Math.ceil((JSON.stringify(text) ?? "").length / 4);
  }
  inputTokens = Math.max(1, inputTokens);
  return { inputTokens, outputTokens: 0, totalTokens: inputTokens };
}

/** Cheap pre-flight token estimate from a request body. */
export function estimateTokens(body: unknown, fallback = 1000): number {
  return estimateTokenUsage(body, fallback).totalTokens;
}
