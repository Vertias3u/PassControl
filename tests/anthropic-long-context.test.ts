// Claude 4.6 and later bill a long prompt at the SAME per-token rate as a short one.
//
// platform.claude.com/docs/en/about-claude/pricing, "Long context pricing" (read
// 2026-10-08): "Claude 4.6 and later models (except Claude Haiku 5.5) ... include the
// full 1M token context window at standard pricing. (A 900k-token request is billed at
// the same per-token rate as a 9k-token request.)" The context-windows page adds that
// for every 1M-context model "1M is the default: you don't need a beta header".
//
// So the sprint item that assumed an Anthropic premium above 200K (to be added with
// `tiered()`, the OpenAI mechanism) had nothing to encode. These pins keep it that
// way: a later change that reuses `tiered()` or its 272K line for Anthropic would
// overcharge every long Claude Code session in a signed receipt and against the
// owner's limit, and nothing else would notice.
import { describe, expect, it } from "vitest";
import { costMicrocents, costMicrocentsForUsage } from "../lib/pricing";
import { forwardableAnthropicBeta } from "../lib/providers/anthropic-beta";

const mc = (usd: number) => Math.ceil(usd * 100 - 1e-9);

// Every 1M-context Anthropic model the table prices, with its page rate (input, output).
const ONE_MILLION: [id: string, input: number, output: number][] = [
  ["claude-fable-5-1", 10, 50],
  ["claude-fable-5", 10, 50],
  ["claude-opus-5-5", 4, 20],
  ["claude-opus-5", 5, 25],
  ["claude-opus-4-8", 5, 25],
  ["claude-opus-4-7", 5, 25],
  ["claude-opus-4-6", 5, 25],
  ["claude-sonnet-5", 2, 10],
  ["claude-sonnet-4-6", 3, 15],
];

// Below Anthropic's old 200K line, just above it, above OpenAI's 272K line, and near 1M.
const LENGTHS = [9_000, 200_001, 272_001, 900_000];

const settle = (id: string, input: number, extra: Partial<Parameters<typeof costMicrocentsForUsage>[0]> = {}) =>
  costMicrocentsForUsage(
    { inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...extra },
    id,
    "anthropic"
  );

describe("Anthropic 1M-context models settle at one flat rate (pricing page, read 2026-10-08)", () => {
  it.each(ONE_MILLION)("%s: input costs the same per token at every length", (id, input) => {
    for (const n of LENGTHS) {
      expect(settle(id, n), `${n} tokens`).toBe(n * mc(input));
      // Anthropic reports `service_tier: "standard"`; it must not switch on a tier.
      expect(settle(id, n, { serviceTier: "standard" }), `${n} tokens, standard`).toBe(n * mc(input));
    }
  });

  it.each(ONE_MILLION)("%s: output costs the same after a long prompt", (id, input, output) => {
    expect(
      costMicrocentsForUsage(
        { inputTokens: 900_000, outputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        id,
        "anthropic"
      )
    ).toBe(900_000 * mc(input) + 1_000 * mc(output));
  });

  it.each(ONE_MILLION)("%s: the hold rate is the settle rate, not a long-context premium", (id, input, output) => {
    expect(costMicrocents(id, 1, 0, "anthropic")).toBe(mc(input));
    expect(costMicrocents(id, 0, 1, "anthropic")).toBe(mc(output));
  });

  it("a long cached Claude Code turn settles at the same multipliers as a short one", () => {
    // Claude Code's shape: a little fresh input, most of the prompt read from or
    // written to cache. Doubling every count must exactly double the cost.
    const short = settle("claude-sonnet-5", 2_000, { cacheReadTokens: 90_000, cacheWriteTokens: 8_000 });
    const long = settle("claude-sonnet-5", 4_000, { cacheReadTokens: 180_000, cacheWriteTokens: 16_000 });
    expect(long).toBe(2 * short);
  });
});

describe("context-1m stays dropped", () => {
  // Not needed: every 1M model has 1M by default. And on the models that have only
  // 200K (Sonnet 4.5 and earlier), the page states no 1M rate to price it at.
  it.each(["context-1m-2025-08-07", "context-1m-2027-01-01"])("drops %s", (beta) => {
    expect(forwardableAnthropicBeta(`claude-code-20250219,${beta}`)).toEqual({
      header: "claude-code-20250219",
      dropped: [beta],
    });
  });
});
