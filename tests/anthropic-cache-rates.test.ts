// Anthropic prompt-cache rates, per model, pinned to the pricing page (sprint P1.1, owner
// 2026-10-08). The table used to derive every cache read as 0.1x of input. The page says
// otherwise for four models: 0.05x on Opus 5.5 and Sonnet 5.5, 0.025x on Fable 5.1 and
// Mythos 5.1. A cache-heavy Claude Code session on Opus 5.5 was charged 2x on reads, on
// Fable 5.1 4x, in every receipt and against every limit.
//
// Source: platform.claude.com/docs/en/about-claude/pricing, "Model pricing" table, columns
// "5m cache writes" and "Cache hits and refreshes", read 2026-10-08. A change here must
// come with a new read of that page.
//
// Cache tokens are ADDITIONAL to `input_tokens` on Anthropic (lib/usage/parseStream.ts),
// so each is charged once, at its own rate.
import { describe, expect, it } from "vitest";
import { costMicrocentsForUsage, hasListedPrice } from "../lib/pricing";

const mc = (usd: number) => Math.ceil(usd * 100 - 1e-9) + 0;
const NONE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const read = (id: string) => costMicrocentsForUsage({ ...NONE, cacheReadTokens: 1 }, id, "anthropic");
const write = (id: string) => costMicrocentsForUsage({ ...NONE, cacheWriteTokens: 1 }, id, "anthropic");

// [id, 5m cache write $/MTok, cache hit $/MTok]. Haiku 5.5 is tiered and has its own test.
const PAGE: [string, number, number][] = [
  ["claude-fable-5-1", 12.5, 0.25],
  ["claude-mythos-5-1", 12.5, 0.25],
  ["claude-fable-5", 12.5, 1],
  ["claude-mythos-5", 12.5, 1],
  ["claude-opus-5-5", 5, 0.2],
  ["claude-opus-5", 6.25, 0.5],
  ["claude-opus-4-8", 6.25, 0.5],
  ["claude-opus-4-7", 6.25, 0.5],
  ["claude-opus-4-6", 6.25, 0.5],
  ["claude-opus-4-5", 6.25, 0.5],
  ["claude-opus-4-1", 18.75, 1.5],
  ["claude-opus-4", 18.75, 1.5],
  ["claude-sonnet-5-5", 2.5, 0.1],
  ["claude-sonnet-5", 2.5, 0.2],
  ["claude-sonnet-4-6", 3.75, 0.3],
  ["claude-sonnet-4-5", 3.75, 0.3],
  ["claude-sonnet-4", 3.75, 0.3],
  ["claude-haiku-4-5", 1.25, 0.1],
  ["claude-3-5-haiku", 1, 0.08],
];

describe("every Anthropic row charges the page's cache rates", () => {
  it.each(PAGE)("%s", (id, writeUsd, readUsd) => {
    expect(hasListedPrice(id, "anthropic")).toBe(true);
    expect(read(id)).toBe(mc(readUsd));
    expect(write(id)).toBe(mc(writeUsd));
  });

  it("applies the same rate to a dated snapshot of the model", () => {
    expect(read("claude-opus-5-5-20261001")).toBe(read("claude-opus-5-5"));
  });
});

describe("the four models below 0.1x", () => {
  it("Opus 5.5: a 900K-token cached read costs $0.18, not $0.36", () => {
    const cost = costMicrocentsForUsage({ ...NONE, cacheReadTokens: 900_000 }, "claude-opus-5-5", "anthropic");
    expect(cost).toBe(900_000 * 20);
    expect(cost / 100_000_000).toBeCloseTo(0.18, 6);
  });

  it("Fable 5.1: a cache read is a fortieth of input", () => {
    expect(read("claude-fable-5-1") * 40).toBe(costMicrocentsForUsage({ ...NONE, inputTokens: 1 }, "claude-fable-5-1", "anthropic"));
  });

  it("a full Claude Code turn: input, writes, reads and output each at their own rate", () => {
    const usage = { inputTokens: 3, outputTokens: 400, cacheReadTokens: 60_000, cacheWriteTokens: 2_000 };
    expect(costMicrocentsForUsage(usage, "claude-sonnet-5-5", "anthropic")).toBe(
      3 * mc(2) + 400 * mc(10) + 60_000 * mc(0.1) + 2_000 * mc(2.5)
    );
  });
});
