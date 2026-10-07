// GPT-6 and GPT-5.6 settle at the context tier the call was billed at (owner, 2026-10-07).
//
// Their model pages price a prompt above 272K input tokens at the long-context rates
// "for the full request", and every other call at the short-context rates. The table
// holds (reserves) at the long rates, since a hold cannot know the prompt's length;
// settlement reads the reported input and charges the tier OpenAI bills. Two guards
// keep a doubtful call on the long rates: the response must report a standard
// service tier (a project defaulting to Fast mode is billed 2x with nothing in the
// request to say so), and the cache-write split is trusted only where the Responses
// API reports it. The rates themselves are pinned in tests/pricing-table.test.ts.
import { describe, expect, it } from "vitest";
import { costMicrocentsForUsage } from "../lib/pricing";
import { createUsageTransform, NO_USAGE, usageFromJson } from "../lib/usage/parseStream";

type Extra = { cachedInputTokens?: number; cacheWriteInputTokens?: number; serviceTier?: string };
const usage = (inputTokens: number, outputTokens: number, extra: Extra = {}) => ({ ...NO_USAGE, inputTokens, outputTokens, ...extra });

// The live Codex turn's shape (16,235 in, 15,872 cached, 1,059 out) on gpt-6-sol.
// Short: input 200, cached 20, write 250, output 1,000 µ¢/token.
// Long (the hold row): input/write 500, cached 40, output 1,500.
const TURN = { input: 16_235, cached: 15_872, output: 1_059 };
const SHORT_COST = 363 * 200 + 15_872 * 20 + 1_059 * 1_000; // 1,449,040
const LONG_COST = 363 * 500 + 15_872 * 40 + 1_059 * 1_500; // 2,404,880, the charge before

describe("settling a gpt-6-sol call", () => {
  it("charges the short-context rates for a standard-tier call under 272K input", () => {
    const u = usage(TURN.input, TURN.output, { cachedInputTokens: TURN.cached, cacheWriteInputTokens: 0, serviceTier: "default" });
    expect(costMicrocentsForUsage(u, "gpt-6-sol", "openai")).toBe(SHORT_COST);
  });

  it("keeps the long-context rates when the response states no tier, or a dearer one", () => {
    for (const serviceTier of [undefined, "priority", "scale", "auto", "fast", ""]) {
      const u = usage(TURN.input, TURN.output, { cachedInputTokens: TURN.cached, cacheWriteInputTokens: 0, serviceTier });
      expect(costMicrocentsForUsage(u, "gpt-6-sol", "openai")).toBe(LONG_COST);
    }
  });

  it("accepts flex, which OpenAI bills below Standard", () => {
    const u = usage(TURN.input, TURN.output, { cachedInputTokens: TURN.cached, cacheWriteInputTokens: 0, serviceTier: "flex" });
    expect(costMicrocentsForUsage(u, "gpt-6-sol", "openai")).toBe(SHORT_COST);
  });

  it("switches tier above 272,000 input tokens, counting cached ones", () => {
    const at = (input: number) => costMicrocentsForUsage(usage(input, 0, { cachedInputTokens: input - 1000, cacheWriteInputTokens: 0, serviceTier: "default" }), "gpt-6-sol", "openai");
    expect(at(272_000)).toBe(1000 * 200 + 271_000 * 20);
    expect(at(272_001)).toBe(1000 * 400 + 271_001 * 40);
  });

  it("charges reported cache writes at the write rate and the rest at the input rate", () => {
    const u = usage(10_000, 0, { cachedInputTokens: 6_000, cacheWriteInputTokens: 3_000, serviceTier: "default" });
    expect(costMicrocentsForUsage(u, "gpt-6-sol", "openai")).toBe(1_000 * 200 + 6_000 * 20 + 3_000 * 250);
  });

  it("charges all uncached input at the write rate when the write split is unknown or doesn't add up", () => {
    for (const cacheWriteInputTokens of [undefined, 5_000]) {
      const u = usage(10_000, 0, { cachedInputTokens: 6_000, cacheWriteInputTokens, serviceTier: "default" });
      expect(costMicrocentsForUsage(u, "gpt-6-sol", "openai")).toBe(4_000 * 250 + 6_000 * 20);
    }
  });

  it("does not let a model without tiers, or the fallback row, settle short", () => {
    const u = usage(10_000, 100, { cachedInputTokens: 0, cacheWriteInputTokens: 0, serviceTier: "default" });
    for (const model of ["gpt-5.5", "gpt-5-mini", "gpt-9-unlisted"]) {
      const plain = costMicrocentsForUsage(usage(10_000, 100), model, "openai");
      expect(costMicrocentsForUsage(u, model, "openai")).toBe(plain);
    }
  });

  it("prices nothing on an unpriced endpoint", () => {
    const u = usage(10_000, 100, { cacheWriteInputTokens: 0, serviceTier: "default" });
    expect(costMicrocentsForUsage(u, "gpt-6-sol", "openai", "https://eu.api.openai.com/v1")).toBe(0);
  });
});

const enc = (value: string) => new TextEncoder().encode(value);
async function streamed(protocol: "provider" | "responses", events: unknown[], done = false) {
  const { stream, settled } = createUsageTransform("openai", protocol);
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

describe("reading the tier and the write count", () => {
  const responseUsage = { input_tokens: 1000, input_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 }, output_tokens: 10, total_tokens: 1010 };

  it("reads both off a Responses report, buffered and streamed, from the final response", async () => {
    const response = { status: "completed", service_tier: "default", usage: responseUsage };
    expect(usageFromJson("openai", response, "responses")).toMatchObject({ serviceTier: "default", cacheWriteInputTokens: 300 });
    // In-progress events echo the REQUESTED tier ("auto"); only the final one says
    // which tier ran, and it is read from the same report as the usage.
    const s = await streamed("responses", [
      { type: "response.created", response: { status: "in_progress", service_tier: "auto" } },
      { type: "response.completed", response },
    ]);
    expect(s).toMatchObject({ serviceTier: "default", cacheWriteInputTokens: 300 });
  });

  it("does not carry an earlier report's tier or write count onto a later one", async () => {
    const s = await streamed("responses", [
      { type: "response.in_progress", response: { status: "in_progress", service_tier: "default", usage: responseUsage } },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 2000, output_tokens: 10, total_tokens: 2010 } } },
    ]);
    expect(s.serviceTier).toBeUndefined();
    expect(s.cacheWriteInputTokens).toBeUndefined();
  });

  it("reports a write count of 0 as known, and drops one that doesn't fit the input", () => {
    const known = { status: "completed", usage: { ...responseUsage, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } };
    expect(usageFromJson("openai", known, "responses").cacheWriteInputTokens).toBe(0);
    const tooMany = { status: "completed", usage: { ...responseUsage, input_tokens_details: { cached_tokens: 600, cache_write_tokens: 500 } } };
    expect(usageFromJson("openai", tooMany, "responses").cacheWriteInputTokens).toBeUndefined();
  });

  it("reads Chat Completions' tier but not its write count, which OpenAI calls unadjusted", async () => {
    const u = { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 } };
    const buffered = usageFromJson("openai", { service_tier: "default", usage: u });
    expect(buffered.serviceTier).toBe("default");
    expect(buffered.cacheWriteInputTokens).toBeUndefined();
    const s = await streamed("provider", [{ service_tier: "default", choices: [], usage: u }], true);
    expect(s.serviceTier).toBe("default");
    expect(s.cacheWriteInputTokens).toBeUndefined();
  });

  it("adds nothing to a report that states neither", () => {
    const u = { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 };
    expect(usageFromJson("openai", { usage: u })).toEqual({ ...NO_USAGE, inputTokens: 1000, outputTokens: 10, sawUsage: true, complete: true });
  });
});
