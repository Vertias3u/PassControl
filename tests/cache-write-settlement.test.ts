import { describe, expect, it } from "vitest";
import { costMicrocentsForUsage } from "@/lib/pricing";
import { hostedToolUseCost } from "@/lib/providers/hosted-tools";
import { createUsageTransform, usageFromJson } from "@/lib/usage/parseStream";

async function streamed(provider: "openai" | "anthropic", events: unknown[]) {
  const { stream, settled } = createUsageTransform(provider, provider === "openai" ? "responses" : "provider");
  const encoder = new TextEncoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
  await new Response(source.pipeThrough(stream)).text();
  return (await settled).usage;
}

const openAIBuckets = (short: unknown, long: unknown) => ({ ttl_30m_tokens: short, ttl_12h_tokens: long });
const claudeBuckets = (short: unknown, long: unknown) => ({ ephemeral_5m_input_tokens: short, ephemeral_1h_input_tokens: long });

describe.each(["buffered", "streamed"])("%s cache write settlement", (mode) => {
  async function openAI(breakdown?: unknown, input = 1000, serviceTier = "default", writes = 100) {
    const response = {
      status: "completed",
      service_tier: serviceTier,
      usage: {
        input_tokens: input,
        output_tokens: 0,
        input_tokens_details: { cached_tokens: 50, cache_write_tokens: writes, cache_write_tokens_details: breakdown },
      },
    };
    return mode === "buffered" ? usageFromJson("openai", response, "responses")
      : streamed("openai", [{ type: "response.completed", response }]);
  }

  async function claude(breakdown?: unknown, input = 1000) {
    const message = { usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 50, cache_creation_input_tokens: 100, cache_creation: breakdown } };
    return mode === "buffered" ? usageFromJson("anthropic", message)
      : streamed("anthropic", [
        { type: "message_start", message },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
        { type: "message_stop" },
      ]);
  }

  it("settles OpenAI 12h writes at 2.5x short-context input", async () => {
    const usage = await openAI(openAIBuckets(0, 100));
    expect(costMicrocentsForUsage(usage, "gpt-6.2-sol", "openai")).toBe(850 * 200 + 50 * 10 + 100 * 500);
    expect(usage).toMatchObject({ longCacheWriteTokens: 100 });
  });

  it("settles OpenAI 12h writes at 2.5x long-context input", async () => {
    const usage = await openAI(openAIBuckets(0, 100), 272_001);
    expect(costMicrocentsForUsage(usage, "gpt-6.2-sol", "openai")).toBe(271_851 * 400 + 50 * 20 + 100 * 1000);
  });

  it("settles mixed OpenAI 30m and 12h writes, including the short remainder", async () => {
    const usage = await openAI(openAIBuckets(20, 60));
    expect(costMicrocentsForUsage(usage, "gpt-6.2-sol", "openai")).toBe(850 * 200 + 50 * 10 + 40 * 250 + 60 * 500);
  });

  it("settles all OpenAI writes at 2.5x when a 12h request has no breakdown", async () => {
    const usage = await openAI();
    expect(costMicrocentsForUsage(usage, "gpt-6.2-sol", "openai", undefined, true)).toBe(850 * 200 + 50 * 10 + 100 * 500);
    expect(usage).not.toHaveProperty("longCacheWriteTokens");
  });

  it("keeps the OpenAI short rate when neither breakdown nor 12h request exists", async () => {
    expect(costMicrocentsForUsage(await openAI(), "gpt-6.2-sol", "openai")).toBe(850 * 200 + 50 * 10 + 100 * 250);
  });

  it("trusts explicit zero long OpenAI writes over the request", async () => {
    const usage = await openAI(openAIBuckets(100, 0));
    expect(usage).toMatchObject({ longCacheWriteTokens: 0 });
    expect(costMicrocentsForUsage(usage, "gpt-6.2-sol", "openai", undefined, true)).toBe(850 * 200 + 50 * 10 + 100 * 250);
  });

  it("keeps the non-standard OpenAI tier baseline and prices long writes at its long-context rate", async () => {
    const usage = await openAI(openAIBuckets(40, 60), 1000, "priority");
    expect(costMicrocentsForUsage(usage, "gpt-6.2-sol", "openai")).toBe(890 * 500 + 50 * 20 + 60 * 1000);
  });

  it("settles Anthropic 1h writes at 2x input", async () => {
    const usage = await claude(claudeBuckets(0, 100));
    expect(costMicrocentsForUsage(usage, "claude-haiku-4-5", "anthropic")).toBe(1000 * 100 + 50 * 10 + 100 * 200);
    expect(usage).toMatchObject({ longCacheWriteTokens: 100 });
  });

  it("settles mixed Anthropic 5m and 1h writes at the long prompt tier", async () => {
    const usage = await claude(claudeBuckets(40, 60), 100_000);
    expect(costMicrocentsForUsage(usage, "claude-haiku-5-5", "anthropic")).toBe(100_000 * 50 + 50 * 5 + 40 * 63 + 60 * 100);
  });

  it("settles all Anthropic writes at 2x when a 1h request has no breakdown", async () => {
    const usage = await claude();
    expect(costMicrocentsForUsage(usage, "claude-haiku-5-5", "anthropic", undefined, true)).toBe(1000 * 10 + 50 + 100 * 20);
  });

  it("settles Anthropic advisor writes from their breakdown or the request", async () => {
    const iteration = { type: "advisor_message", model: "claude-haiku-4-5", input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 100 };
    for (const [breakdown, requested, expected] of [[claudeBuckets(0, 100), false, 20_000], [undefined, true, 20_000]] as const) {
      const usage = { input_tokens: 0, output_tokens: 0, iterations: [{ ...iteration, cache_creation: breakdown }] };
      const parsed = mode === "buffered" ? usageFromJson("anthropic", { usage }) : await streamed("anthropic", [
        { type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 0 } } },
        { type: "message_delta", usage },
        { type: "message_stop" },
      ]);
      expect(hostedToolUseCost("anthropic", parsed.hostedTools, null, 0, requested)).toBe(expected);
    }
  });

  it.each([
    ["negative", -1, 60],
    ["fractional", 40, 59.5],
    ["sum above total", 41, 60],
    ["string", 40, "60"],
    ["unsafe", 0, Number.MAX_SAFE_INTEGER + 1],
    ["missing part", undefined, 60],
  ])("falls back to the request for %s breakdowns", async (_label, short, long) => {
    const openAIUsage = await openAI(openAIBuckets(short, long));
    const claudeUsage = await claude(claudeBuckets(short, long));
    expect(costMicrocentsForUsage(openAIUsage, "gpt-6.2-sol", "openai", undefined, true)).toBe(850 * 200 + 50 * 10 + 100 * 500);
    expect(costMicrocentsForUsage(claudeUsage, "claude-haiku-5-5", "anthropic", undefined, true)).toBe(1000 * 10 + 50 + 100 * 20);
    expect(openAIUsage).not.toHaveProperty("longCacheWriteTokens");
    expect(claudeUsage).not.toHaveProperty("longCacheWriteTokens");
  });
});

it("reads an Anthropic delta breakdown with its cumulative write total", async () => {
  const usage = await streamed("anthropic", [
    { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 0 } } },
    { type: "message_delta", usage: { output_tokens: 1, cache_creation_input_tokens: 100, cache_creation: claudeBuckets(20, 80) } },
    { type: "message_stop" },
  ]);
  expect(usage).toMatchObject({ cacheWriteTokens: 100, longCacheWriteTokens: 80 });
});

it("drops a stale Anthropic breakdown when the cumulative total grows without a split", async () => {
  const usage = await streamed("anthropic", [
    { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 80, cache_creation: claudeBuckets(0, 80) } } },
    { type: "message_delta", usage: { output_tokens: 0, cache_creation_input_tokens: 100 } },
    { type: "message_stop" },
  ]);
  expect(usage).not.toHaveProperty("longCacheWriteTokens");
  expect(costMicrocentsForUsage(usage, "claude-haiku-4-5", "anthropic", undefined, true)).toBe(30_000);
});
