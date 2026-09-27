// B1 — the pre-flight estimate must see every part of the request the provider
// bills as input. It read only `messages` (or `input`), so an Anthropic body
// whose weight is a 40 KB `system` prompt, or any body carrying large `tools`
// definitions, reserved as if it were a one-line chat — and an agent near its
// cap was admitted for a call its remaining budget could not cover.
//
// The estimate only decides admission and the size of the hold; settlement
// still charges the provider's reported usage. So a larger estimate refuses a
// near-cap agent sooner and never over-charges one.
import { describe, expect, it } from "vitest";
import { estimateTokenUsage } from "@/lib/pricing";

const big = (n: number) => "x".repeat(n);

describe("estimateTokenUsage counts every billed input field", () => {
  it("counts an Anthropic top-level system prompt, string or blocks", () => {
    const messages = [{ role: "user", content: "hi" }];
    const withoutSystem = estimateTokenUsage({ messages, max_tokens: 10 });
    const withSystem = estimateTokenUsage({ messages, system: big(4000), max_tokens: 10 });
    expect(withSystem.inputTokens - withoutSystem.inputTokens).toBeGreaterThanOrEqual(1000);
    const blocks = estimateTokenUsage({ messages, system: [{ type: "text", text: big(4000) }], max_tokens: 10 });
    expect(blocks.inputTokens - withoutSystem.inputTokens).toBeGreaterThanOrEqual(1000);
  });

  it("counts tool definitions (OpenAI and Anthropic shapes) and legacy functions", () => {
    const messages = [{ role: "user", content: "hi" }];
    const base = estimateTokenUsage({ messages, max_tokens: 10 }).inputTokens;
    const tools = [{ type: "function", function: { name: "lookup", description: big(2000), parameters: {} } }];
    expect(estimateTokenUsage({ messages, tools, max_tokens: 10 }).inputTokens - base).toBeGreaterThanOrEqual(500);
    const anthropicTools = [{ name: "lookup", description: big(2000), input_schema: {} }];
    expect(estimateTokenUsage({ messages, tools: anthropicTools, max_tokens: 10 }).inputTokens - base).toBeGreaterThanOrEqual(500);
    const functions = [{ name: "lookup", description: big(2000), parameters: {} }];
    expect(estimateTokenUsage({ messages, functions, max_tokens: 10 }).inputTokens - base).toBeGreaterThanOrEqual(500);
  });

  it("counts OpenAI Responses instructions beside input", () => {
    const base = estimateTokenUsage({ input: "hello", max_output_tokens: 10 }).inputTokens;
    const withInstructions = estimateTokenUsage({ input: "hello", instructions: big(4000), max_output_tokens: 10 }).inputTokens;
    expect(withInstructions - base).toBeGreaterThanOrEqual(1000);
  });

  it("counts Gemini-native contents and systemInstruction if such a body ever arrives", () => {
    // Not a routed shape today (Gemini goes through its OpenAI-compatible
    // endpoint), so this only guarantees the estimator is not blind to it.
    const usage = estimateTokenUsage({ contents: [{ parts: [{ text: big(4000) }] }], systemInstruction: { parts: [{ text: big(4000) }] } });
    expect(usage.inputTokens).toBeGreaterThanOrEqual(2000);
  });

  it("counts both messages and input when a body carries both", () => {
    const one = estimateTokenUsage({ messages: [big(400)], max_tokens: 1 }).inputTokens;
    const both = estimateTokenUsage({ messages: [big(400)], input: big(400), max_tokens: 1 }).inputTokens;
    expect(both).toBeGreaterThan(one);
  });
});

describe("estimateTokenUsage is unchanged where it already saw everything", () => {
  it("keeps a messages-only estimate byte-identical", () => {
    const messages = [{ role: "user", content: "hello there" }];
    const chars = JSON.stringify(messages).length;
    expect(estimateTokenUsage({ messages, max_tokens: 50 })).toEqual({
      inputTokens: Math.ceil(chars / 4),
      outputTokens: 50,
      totalTokens: Math.ceil(chars / 4) + 50,
    });
  });

  it("keeps the Responses input-only estimate, the default output and the empty body", () => {
    expect(estimateTokenUsage({ input: "12345678", max_output_tokens: 64 })).toEqual({ inputTokens: 3, outputTokens: 64, totalTokens: 67 });
    expect(estimateTokenUsage({})).toEqual({ inputTokens: 1, outputTokens: 1024, totalTokens: 1025 });
  });

  it("does not let a non-prompt field inflate the estimate", () => {
    const messages = [{ role: "user", content: "hi" }];
    const base = estimateTokenUsage({ messages, max_tokens: 10 });
    expect(estimateTokenUsage({ messages, max_tokens: 10, model: big(4000), metadata: { note: big(4000) }, stream: true })).toEqual(base);
  });
});

// K2 prerequisite (N10) — the estimate's output figure must be at least every
// output limit the request states, times the number of choices it asks for.
// It took the FIRST alias present (`max_tokens ?? max_completion_tokens ??
// max_output_tokens`), so a body stating a small deprecated `max_tokens` beside
// a large `max_completion_tokens` reserved the small one; and it ignored `n`, so
// `n: 4` reserved one completion's worth for four. Both under-reserve, which is
// the one direction a budget estimate may not err in.
describe("estimateTokenUsage reserves the largest stated output, times n", () => {
  const messages = [{ role: "user", content: "hi" }];

  it("takes the largest output alias, not the first one present", () => {
    expect(estimateTokenUsage({ messages, max_tokens: 10, max_completion_tokens: 900 }).outputTokens).toBe(900);
    expect(estimateTokenUsage({ messages, max_tokens: 900, max_completion_tokens: 10 }).outputTokens).toBe(900);
    expect(estimateTokenUsage({ messages, max_completion_tokens: 5, max_output_tokens: 700 }).outputTokens).toBe(700);
  });

  it("multiplies by the number of choices requested", () => {
    expect(estimateTokenUsage({ messages, max_tokens: 100, n: 4 }).outputTokens).toBe(400);
    // No stated limit: the assumed default is per choice too.
    expect(estimateTokenUsage({ messages, n: 3 }).outputTokens).toBe(3 * 1024);
  });

  it("reads a nonsensical n as one choice and bounds an enormous one", () => {
    for (const n of [0, -2, 1.5, "4", null, Number.NaN]) {
      expect(estimateTokenUsage({ messages, max_tokens: 100, n }).outputTokens).toBe(100);
    }
    // OpenAI's own ceiling on n is 128; a larger one is refused upstream, and
    // bounding it keeps the micro-cent arithmetic inside safe integers.
    expect(estimateTokenUsage({ messages, max_tokens: 100, n: 1e9 }).outputTokens).toBe(12_800);
  });

  it("ignores a non-numeric alias beside a numeric one", () => {
    expect(estimateTokenUsage({ messages, max_tokens: "5000", max_completion_tokens: 40 }).outputTokens).toBe(40);
  });
});
