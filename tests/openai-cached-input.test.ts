// OpenAI's cached input, priced at OpenAI's cached rate (owner, 2026-10-07).
//
// OpenAI's input count INCLUDES the tokens it served from its prompt cache, so the
// cached count is a subset of `inputTokens`, read for the price alone. The route
// test (tests/proxy-openai-cached-input.test.ts) proves it reaches settlement; this
// file pins the parse and the arithmetic, and the cases that must NOT discount.
import { describe, expect, it } from "vitest";
import { costMicrocentsForUsage } from "../lib/pricing";
import { createUsageTransform, NO_USAGE, usageFromJson } from "../lib/usage/parseStream";

const enc = (value: string) => new TextEncoder().encode(value);

async function streamed(provider: "openai" | "xai", protocol: "provider" | "responses", events: unknown[], done = false) {
  const { stream, settled } = createUsageTransform(provider, protocol);
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) controller.enqueue(enc(`data: ${JSON.stringify(e)}\n\n`));
      if (done) controller.enqueue(enc("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const reader = source.pipeThrough(stream).getReader();
  for (;;) if ((await reader.read()).done) break;
  return (await settled).usage;
}

const usage = (inputTokens: number, cachedInputTokens: number, outputTokens = 0) => ({
  ...NO_USAGE,
  inputTokens,
  outputTokens,
  cachedInputTokens,
});

describe("reading the cached count", () => {
  it("reads Chat Completions' prompt_tokens_details.cached_tokens, buffered and streamed", async () => {
    const u = { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 900 } };
    expect(usageFromJson("openai", { usage: u })).toMatchObject({ inputTokens: 1000, cachedInputTokens: 900 });
    const s = await streamed("openai", "provider", [{ choices: [], usage: u }], true);
    expect(s).toMatchObject({ inputTokens: 1000, cachedInputTokens: 900 });
  });

  it("reads Responses' input_tokens_details.cached_tokens, buffered and streamed", async () => {
    const response = {
      status: "completed",
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 900 }, output_tokens: 10, total_tokens: 1010 },
    };
    expect(usageFromJson("openai", response, "responses")).toMatchObject({ inputTokens: 1000, cachedInputTokens: 900 });
    const s = await streamed("openai", "responses", [{ type: "response.completed", response }]);
    expect(s).toMatchObject({ inputTokens: 1000, cachedInputTokens: 900 });
  });

  it("adds nothing to a report without one, so every uncached call is unchanged", () => {
    const u = { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 };
    expect(usageFromJson("openai", { usage: u })).toEqual({ ...NO_USAGE, inputTokens: 1000, outputTokens: 10, sawUsage: true, complete: true });
  });

  it("takes the count from the same report as the input, never from an earlier one", async () => {
    const early = { type: "response.in_progress", response: { status: "in_progress", usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 480 }, output_tokens: 0, total_tokens: 500 } } };
    const final = { type: "response.completed", response: { status: "completed", usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 } } };
    const s = await streamed("openai", "responses", [early, final]);
    expect(s.inputTokens).toBe(1000);
    expect(s.cachedInputTokens ?? 0).toBe(0);
  });

  it("ignores a count that is malformed or larger than the input", () => {
    for (const cached of [1001, -1, 1.5, "900", null]) {
      const u = { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: cached } };
      expect(usageFromJson("openai", { usage: u }).cachedInputTokens ?? 0).toBe(0);
    }
  });
});

describe("pricing it", () => {
  it("charges the cached part at the model's cached rate, the rest at the input rate", () => {
    // gpt-5-mini: input 25 µ¢, cached $0.025/M rounds up to 3 µ¢, output 200 µ¢.
    expect(costMicrocentsForUsage(usage(15_525, 14_592, 107), "gpt-5-mini", "openai")).toBe(933 * 25 + 14_592 * 3 + 107 * 200);
    // A dated snapshot shares its model's row.
    expect(costMicrocentsForUsage(usage(1000, 1000), "gpt-4.1-2025-04-14", "openai")).toBe(1000 * 50);
  });

  it("does not discount a model whose page lists no cached rate", () => {
    for (const model of ["gpt-5-pro", "gpt-5.5-pro", "gpt-4o-2024-05-13", "o1-pro", "gpt-3.5-turbo"]) {
      expect(costMicrocentsForUsage(usage(1000, 900), model, "openai")).toBe(costMicrocentsForUsage(usage(1000, 0), model, "openai"));
    }
  });

  it("does not discount an unlisted model billed at the provider's fallback rate", () => {
    expect(costMicrocentsForUsage(usage(1000, 900), "gpt-9-unlisted", "openai")).toBe(
      costMicrocentsForUsage(usage(1000, 0), "gpt-9-unlisted", "openai")
    );
  });

  it("does not discount another provider's cached count", () => {
    for (const [provider, model] of [["xai", "grok-4.7"], ["groq", "openai/gpt-oss-120b"], ["gemini", "gemini-2.5-pro"]] as const) {
      expect(costMicrocentsForUsage(usage(1000, 900), model, provider)).toBe(costMicrocentsForUsage(usage(1000, 0), model, provider));
    }
  });

  it("does not discount a count larger than the input", () => {
    expect(costMicrocentsForUsage(usage(1000, 1001), "gpt-5-mini", "openai")).toBe(1000 * 25);
  });

  it("prices nothing on an unpriced endpoint, cached or not", () => {
    expect(costMicrocentsForUsage(usage(1000, 900), "gpt-5-mini", "openai", "https://proxy.example")).toBe(0);
  });
});
