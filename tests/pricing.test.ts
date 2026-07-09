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
    // generic claude-* row is intentionally conservative: unknown Claude models
    // should not under-reserve before a precise row is added.
    expect(costMicrocents("claude-something-new", 10, 10)).toBe(10 * 1500 + 10 * 7500);
  });

  it("returns 0 for an unknown model when no provider is known", () => {
    expect(costMicrocents("mystery-model", 1000, 1000)).toBe(0);
  });

  it("falls back to the known provider's highest rate for an unlisted model", () => {
    // Groq max verified rate: Llama 3.3 70B at 59 µ¢ input / 79 µ¢ output.
    expect(costMicrocents("some-new-model", 1000, 500, "groq")).toBe(1000 * 59 + 500 * 79);
  });

  it("keeps listed model pricing exact instead of using the fallback", () => {
    expect(costMicrocents("llama-3.1-8b-instant", 1000, 500, "groq")).toBe(1000 * 5 + 500 * 8);
  });

  it("uses each provider's own fallback rate for unknown models", () => {
    expect(costMicrocents("same-unknown-model", 1000, 500, "groq")).toBe(1000 * 59 + 500 * 79);
    expect(costMicrocents("same-unknown-model", 1000, 500, "deepseek")).toBe(1000 * 44 + 500 * 87);
    expect(costMicrocents("same-unknown-model", 1000, 500, "together")).toBe(1000 * 104 + 500 * 120);
    expect(costMicrocents("same-unknown-model", 1000, 500, "openai")).toBe(1000 * 250 + 500 * 1000);
  });

  it("never presents an unverified model name as a precise price row", () => {
    // These names intentionally use each provider's conservative fallback. A
    // new model gets an explicit row only after its official price is verified.
    expect(costMicrocents("claude-mythos-5", 1, 1, "anthropic")).toBe(1500 + 7500);
    expect(costMicrocents("gpt-5.4-mini", 1, 1, "openai")).toBe(250 + 1000);
    expect(costMicrocents("qwen-3.6-27b", 1, 1, "groq")).toBe(59 + 79);
    expect(costMicrocents("moonshotai/Kimi-K2.6", 1, 1, "together")).toBe(104 + 120);
  });

  it("uses provider-specific prices for OpenAI-compatible providers", () => {
    expect(costMicrocents("llama-3.3-70b-versatile", 1000, 500, "groq")).toBe(1000 * 59 + 500 * 79);
    expect(costMicrocents("mistral-small-latest", 1000, 500, "mistral")).toBe(1000 * 15 + 500 * 60);
    expect(costMicrocents("openai/gpt-oss-20b", 1000, 500, "together")).toBe(1000 * 5 + 500 * 20);
    expect(costMicrocents("deepseek-v4-flash", 1000, 500, "deepseek")).toBe(1000 * 14 + 500 * 28);
    expect(costMicrocents("deepseek-reasoner", 1000, 500, "deepseek")).toBe(1000 * 44 + 500 * 87);
    expect(costMicrocents("claude-fable-5", 1000, 500, "anthropic")).toBe(1000 * 1000 + 500 * 5000);
    expect(costMicrocents("gpt-4o", 1000, 500, "openai")).toBe(1000 * 250 + 500 * 1000);
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
