// Claude Haiku 5.5 is priced by prompt length (sprint P1.3, owner 2026-10-08). Until now
// it had no row, so any agent with a dollar limit was refused it.
//
// Source: platform.claude.com/docs/en/about-claude/pricing, read 2026-10-08:
//   prompts up to 100,000 tokens: $0.10 in, $0.125 5m write, $0.01 cache hit, $0.50 out
//   prompts over 100,000 tokens:  $0.50 in, $0.625 5m write, $0.05 cache hit, $2.50 out
// "Claude Haiku 5.5 is priced by prompt length: a prompt of over 100,000 tokens pays
// higher prices."
//
// Three things the OpenAI tiers (`tiered`, 272K) get wrong for it, each pinned below:
//   * the prompt is input + cache reads + cache writes: Anthropic reports the cached
//     parts OUTSIDE `input_tokens`, so a mostly-cached 300K prompt would read as tiny;
//   * cache reads and writes are priced at the tier too, not at a fixed multiple of
//     the held rate;
//   * Anthropic reports no service tier the way OpenAI does, so settlement must not
//     wait for one.
// The hold stays at the long tier, as every tiered row's does: a hold cannot know
// how much of the prompt the provider will serve from cache.
import { describe, expect, it } from "vitest";
import { costMicrocents, costMicrocentsForUsage, hasListedPrice } from "../lib/pricing";

const ID = "claude-haiku-5-5";
const mc = (usd: number) => Math.ceil(usd * 100 - 1e-9) + 0;
const SHORT = { input: mc(0.1), write: mc(0.125), read: mc(0.01), output: mc(0.5) };
const LONG = { input: mc(0.5), write: mc(0.625), read: mc(0.05), output: mc(2.5) };
const settle = (u: Partial<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>, id = ID) =>
  costMicrocentsForUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...u }, id, "anthropic");
const bill = (r: typeof SHORT, u: { i?: number; o?: number; cr?: number; cw?: number }) =>
  (u.i ?? 0) * r.input + (u.o ?? 0) * r.output + (u.cr ?? 0) * r.read + (u.cw ?? 0) * r.write;

describe("Claude Haiku 5.5", () => {
  it("has a row, so a dollar-limited agent is no longer refused it", () => {
    expect(hasListedPrice(ID, "anthropic")).toBe(true);
    expect(hasListedPrice(`${ID}-20261007`, "anthropic")).toBe(true);
  });

  it("is HELD at the long tier", () => {
    expect(costMicrocents(ID, 1, 0, "anthropic")).toBe(LONG.input);
    expect(costMicrocents(ID, 0, 1, "anthropic")).toBe(LONG.output);
  });

  it("settles a prompt of exactly 100,000 tokens at the short tier", () => {
    expect(settle({ inputTokens: 100_000, outputTokens: 500 })).toBe(bill(SHORT, { i: 100_000, o: 500 }));
  });

  it("settles a prompt of 100,001 tokens at the long tier, the whole request", () => {
    expect(settle({ inputTokens: 100_001, outputTokens: 500 })).toBe(bill(LONG, { i: 100_001, o: 500 }));
  });

  it("counts cache reads and writes toward the 100K line", () => {
    // 10 uncached tokens, but a 100,010-token prompt.
    const u = { inputTokens: 10, outputTokens: 50, cacheReadTokens: 90_000, cacheWriteTokens: 10_000 };
    expect(settle(u)).toBe(bill(LONG, { i: 10, o: 50, cr: 90_000, cw: 10_000 }));
  });

  it("prices cache traffic at the tier's own rates", () => {
    const small = { inputTokens: 5, outputTokens: 0, cacheReadTokens: 40_000, cacheWriteTokens: 2_000 };
    expect(settle(small)).toBe(bill(SHORT, { i: 5, cr: 40_000, cw: 2_000 }));
    const big = { inputTokens: 5, outputTokens: 0, cacheReadTokens: 200_000, cacheWriteTokens: 2_000 };
    expect(settle(big)).toBe(bill(LONG, { i: 5, cr: 200_000, cw: 2_000 }));
  });

  it("settles a dated snapshot the same way", () => {
    const u = { inputTokens: 2_000, outputTokens: 300 };
    expect(settle(u, `${ID}-20261007`)).toBe(settle(u));
  });

  it("a long prompt costs five times a short one, per token", () => {
    expect(LONG.input).toBe(5 * SHORT.input);
    expect(LONG.read).toBe(5 * SHORT.read);
  });
});
