import { describe, it, expect } from "vitest";
import { costMicrocents, estimateTokenUsage, estimateTokens } from "../lib/pricing";

// 1 cent = 1_000_000 micro-cents; 1 USD = 100_000_000 micro-cents.
// Per-token price in µ¢ = (USD per 1M tokens) * 100, so costs are EXACT integers.
describe("costMicrocents — sub-cent precision (no rounding to zero)", () => {
  it("does NOT collapse a tiny sub-cent call to zero (the bug)", () => {
    // gpt-4o-mini input: $0.15/1M => 15 µ¢/token. 1000 tokens => 15000 µ¢ = $0.00015.
    // The old integer-cents path rounded 0.015¢ -> 0¢. Now it's preserved.
    expect(costMicrocents("gpt-4o-mini", 1000, 0)).toBe(15000);
    // A single token still has non-zero cost.
    expect(costMicrocents("gpt-4o-mini", 1, 0)).toBe(15);
  });

  it("prices input and output separately", () => {
    // gpt-4o-mini: in 15 µ¢/tok, out 60 µ¢/tok.
    expect(costMicrocents("gpt-4o-mini", 1000, 500)).toBe(1000 * 15 + 500 * 60);
  });

  it("matches model wildcards", () => {
    // claude-haiku-4*: in $1/1M => 100 µ¢/tok, out $5/1M => 500 µ¢/tok.
    expect(costMicrocents("claude-haiku-4-5", 1000, 500)).toBe(1000 * 100 + 500 * 500);
    // generic claude-* fallback: in $3/1M => 300, out $15/1M => 1500.
    expect(costMicrocents("claude-something-new", 10, 10)).toBe(10 * 300 + 10 * 1500);
  });

  it("returns 0 for an unknown model (never guesses a price)", () => {
    expect(costMicrocents("mystery-model", 1000, 1000)).toBe(0);
  });

  it("uses provider-specific prices for OpenAI-compatible providers", () => {
    expect(costMicrocents("llama-3.3-70b-versatile", 1000, 500, "groq")).toBe(1000 * 59 + 500 * 79);
    expect(costMicrocents("mistral-small-latest", 1000, 500, "mistral")).toBe(1000 * 15 + 500 * 60);
    expect(costMicrocents("openai/gpt-oss-20b", 1000, 500, "together")).toBe(1000 * 5 + 500 * 20);
    expect(costMicrocents("deepseek-v4-flash", 1000, 500, "deepseek")).toBe(1000 * 14 + 500 * 28);
  });

  it("does not reuse a same-name provider-specific price across providers", () => {
    expect(costMicrocents("openai/gpt-oss-20b", 1000, 500, "groq")).toBe(1000 * 8 + 500 * 30);
    expect(costMicrocents("openai/gpt-oss-20b", 1000, 500, "together")).toBe(1000 * 5 + 500 * 20);
  });

  it("returns integer µ¢ (safe to store as bigint, no float drift)", () => {
    const v = costMicrocents("gpt-4o", 1234, 567);
    expect(Number.isInteger(v)).toBe(true);
  });

  it("estimateTokens still bounds a request body", () => {
    expect(estimateTokens({ max_tokens: 100, messages: [{ role: "user", content: "hi" }] })).toBeGreaterThan(0);
  });

  it("estimates OpenAI max_completion_tokens as output tokens", () => {
    const estimate = estimateTokenUsage({
      max_completion_tokens: 25,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(estimate.outputTokens).toBe(25);
    expect(estimate.totalTokens).toBe(estimate.inputTokens + 25);
  });
});

describe("estimateTokens — always a positive integer (Redis INCRBY rejects fractions)", () => {
  // The estimate is fed verbatim into the reserve Lua's INCRBY. A fractional
  // max_tokens in the request body (e.g. 0.5 — attacker-controlled JSON) must not
  // produce a non-integer estimate, or the reserve script errors and the proxy 500s.
  it("floors a fractional max_tokens instead of passing it through", () => {
    const est = estimateTokens({ max_tokens: 0.5, messages: [{ role: "user", content: "hi" }] });
    expect(Number.isInteger(est)).toBe(true);
    expect(est).toBeGreaterThan(0);
  });

  it("stays integer for any fractional max_tokens", () => {
    for (const max of [100.7, 1.1, 0.0001, 999.999]) {
      const est = estimateTokens({ max_tokens: max, messages: [] });
      expect(Number.isInteger(est)).toBe(true);
      expect(est).toBeGreaterThan(0);
    }
  });

  it("falls back to a positive integer for hostile shapes", () => {
    for (const body of [{ max_tokens: -3.5 }, { max_tokens: Number.NaN }, null, "junk", 42]) {
      const est = estimateTokens(body);
      expect(Number.isInteger(est)).toBe(true);
      expect(est).toBeGreaterThan(0);
    }
  });
});
