// A prompt-length-tiered Claude row (Haiku 5.5: $0.10/$0.50 up to 100K prompt
// tokens, five times that above) was HELD at the long tier on every call. Live on
// 2026-10-10 a Claude Code sub-agent call estimated at 35,026 tokens held 2,972,590 µ¢
// and settled 361,803 µ¢ (8x), so a 3¢ per-sub-agent cap refused a sub-agent on its
// second call, and every main call's hold stacked against the day's limit at 5x.
//
// Fix (owner, 2026-10-10: "do both fixes"): hold at the SHORT tier when the prompt's
// estimate, plus what hosted tools may add to it inside the call, is at most HALF the
// line. Why half: the estimate already runs high (2.4 bytes per token assumed, 2.82
// measured on a real Claude Code request, tests/estimate-tokenizer.test.ts), so a
// prompt estimated at 50K would need ~1.2 bytes per token to cross 100K. Between half
// and the line, the long tier as before. Settlement is unchanged: Anthropic's reported
// prompt picks the tier the call is charged at.
//
// The estimate covers the WHOLE prompt, cached parts included (they are in the body),
// and Anthropic's tier counts cached tokens too (tests/anthropic-haiku-tiers.test.ts),
// so how much the provider serves from cache does not change the tier.
import { describe, expect, it } from "vitest";
import { costMicrocents, holdMicrocents } from "@/lib/pricing";

const ID = "claude-haiku-5-5";
const mc = (usd: number) => Math.ceil(usd * 100 - 1e-9) + 0;
const SHORT = { input: mc(0.1), write: mc(0.125), output: mc(0.5) };
const LONG = { input: mc(0.5), write: mc(0.625), output: mc(2.5) };
const msg = (block: Record<string, unknown> = {}) => [{ role: "user", content: [{ type: "text", text: "hi", ...block }] }];
const cached = { messages: msg({ cache_control: { type: "ephemeral" } }) };
const plain = { messages: msg() };

describe("holding a prompt-tiered Claude row", () => {
  it("holds the live sub-agent call at the short tier: 35,026 estimated tokens, 4,096 out, 5-minute cache", () => {
    expect(holdMicrocents(ID, { inputTokens: 35_026, outputTokens: 4_096 }, "anthropic", cached)).toBe(
      35_026 * SHORT.write + 4_096 * SHORT.output
    );
  });

  it("holds an uncached short prompt at the short input rate", () => {
    expect(holdMicrocents(ID, { inputTokens: 1_000, outputTokens: 100 }, "anthropic", plain)).toBe(
      1_000 * SHORT.input + 100 * SHORT.output
    );
  });

  it("holds a 1-hour cache write at twice the short input rate", () => {
    const body = { messages: msg({ cache_control: { type: "ephemeral", ttl: "1h" } }) };
    expect(holdMicrocents(ID, { inputTokens: 1_000, outputTokens: 0 }, "anthropic", body)).toBe(1_000 * SHORT.input * 2);
  });

  it("uses the short tier up to exactly half the line", () => {
    expect(holdMicrocents(ID, { inputTokens: 50_000, outputTokens: 0 }, "anthropic", plain)).toBe(50_000 * SHORT.input);
  });

  it("keeps the long tier one token past half the line", () => {
    expect(holdMicrocents(ID, { inputTokens: 50_001, outputTokens: 0 }, "anthropic", plain)).toBe(50_001 * LONG.input);
    expect(holdMicrocents(ID, { inputTokens: 50_001, outputTokens: 10 }, "anthropic", cached)).toBe(
      50_001 * LONG.write + 10 * LONG.output
    );
  });

  it("counts what hosted tools may add to the prompt toward the line", () => {
    const usage = { inputTokens: 30_000, outputTokens: 0 };
    expect(holdMicrocents(ID, usage, "anthropic", plain, { addedPromptTokens: 20_000 })).toBe(30_000 * SHORT.input);
    expect(holdMicrocents(ID, usage, "anthropic", plain, { addedPromptTokens: 20_001 })).toBe(30_000 * LONG.input);
  });

  it("holds a dated snapshot the same way", () => {
    expect(holdMicrocents(`${ID}-20261007`, { inputTokens: 1_000, outputTokens: 100 }, "anthropic", plain)).toBe(
      holdMicrocents(ID, { inputTokens: 1_000, outputTokens: 100 }, "anthropic", plain)
    );
  });

  it("leaves rows without prompt tiers alone", () => {
    expect(holdMicrocents("claude-sonnet-5", { inputTokens: 1_000, outputTokens: 10 }, "anthropic", plain)).toBe(
      costMicrocents("claude-sonnet-5", 1_000, 10, "anthropic")
    );
  });

  it("leaves OpenAI's service-tier rows at the long tier: a Fast-tier project is billed 2x with nothing in the request to say so", () => {
    expect(holdMicrocents("gpt-5.6-terra", { inputTokens: 1_000, outputTokens: 10 }, "openai", plain)).toBe(
      costMicrocents("gpt-5.6-terra", 1_000, 10, "openai")
    );
  });
});
