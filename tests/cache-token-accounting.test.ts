// Prompt-cache tokens, and why the gateway has to count them itself.
//
// Anthropic reports a cached call's input in THREE fields, and `input_tokens` is
// only the uncached remainder:
//
//   total prompt = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
//
// So an agent with an 18k-token cached prefix reports `input_tokens: 12` for a
// call that really consumed ~18k. Before this suite the gateway read only
// `input_tokens`, which meant a token budget under-counted by orders of
// magnitude and a cost budget under-counted several-fold — on the one feature
// whose whole job is to stop an agent spending money.
//
// The OpenAI-shaped providers are the opposite case and must NOT be "fixed" the
// same way: `prompt_tokens` already INCLUDES cached tokens
// (`prompt_tokens_details.cached_tokens` is a subset of it, not an addition), so
// adding anything there would double-count. That asymmetry is the point of the
// per-provider cases below.
import { describe, expect, it } from "vitest";
import { costMicrocents, costMicrocentsForUsage } from "../lib/pricing";
import { createUsageTransform, usageFromJson, NO_USAGE } from "../lib/usage/parseStream";
import { buildReceiptClaims } from "../lib/receipt";
import { describeTokenUse } from "../lib/verify/receipt-view";

const enc = (s: string) => new TextEncoder().encode(s);

async function drain(readable: ReadableStream<Uint8Array>): Promise<void> {
  const reader = readable.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

/** Feed complete SSE chunks through the transform and read the settled tally. */
async function tally(provider: "anthropic" | "openai", chunks: string[]) {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc(c));
      controller.close();
    },
  });
  const { stream, settled } = createUsageTransform(provider);
  await drain(source.pipeThrough(stream));
  return (await settled).usage;
}

describe("reading prompt-cache tokens off a provider response", () => {
  it("takes all three Anthropic input fields from a buffered response", () => {
    const usage = usageFromJson("anthropic", {
      usage: {
        input_tokens: 12,
        cache_read_input_tokens: 18_000,
        cache_creation_input_tokens: 1_200,
        output_tokens: 200,
      },
    });
    expect(usage).toEqual({
      inputTokens: 12,
      outputTokens: 200,
      cacheReadTokens: 18_000,
      cacheWriteTokens: 1_200,
    });
  });

  // Streaming is the common shape for an agent, so a fix that only landed on the
  // buffered path above would leave the majority of real traffic under-counted.
  it("takes them off a STREAMED response too, from message_start", async () => {
    const usage = await tally("anthropic", [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":18000,"cache_creation_input_tokens":1200,"output_tokens":1}}}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":200}}\n\n',
    ]);
    expect(usage).toEqual({
      inputTokens: 12,
      outputTokens: 200,
      cacheReadTokens: 18_000,
      cacheWriteTokens: 1_200,
    });
  });

  it("reports zero cache tokens for an uncached Anthropic call", async () => {
    expect(
      usageFromJson("anthropic", { usage: { input_tokens: 900, output_tokens: 100 } })
    ).toEqual({ inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });

    expect(
      await tally("anthropic", [
        'data: {"type":"message_start","message":{"usage":{"input_tokens":900,"output_tokens":1}}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":100}}\n\n',
      ])
    ).toEqual({ inputTokens: 900, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  // The asymmetry. `prompt_tokens` already contains the cached tokens, so the
  // gateway must add NOTHING here — reporting a cache figure would double-count
  // the same tokens against the agent's budget.
  it("adds nothing on an OpenAI-shaped response, where prompt_tokens already includes the cache", () => {
    const usage = usageFromJson("openai", {
      usage: {
        prompt_tokens: 18_012,
        prompt_tokens_details: { cached_tokens: 18_000 },
        completion_tokens: 200,
      },
    });
    expect(usage).toEqual({
      inputTokens: 18_012,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("adds nothing on an OpenAI-shaped stream either", async () => {
    const usage = await tally("openai", [
      'data: {"choices":[],"usage":{"prompt_tokens":18012,"prompt_tokens_details":{"cached_tokens":18000},"completion_tokens":200}}\n\n',
    ]);
    expect(usage).toEqual({
      inputTokens: 18_012,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("ignores non-numeric cache fields rather than coercing them", () => {
    const usage = usageFromJson("anthropic", {
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_input_tokens: null,
        cache_creation_input_tokens: "1200",
      },
    });
    expect(usage.cacheReadTokens).toBe(0);
    expect(usage.cacheWriteTokens).toBe(0);
  });
});

describe("pricing cache tokens", () => {
  // Anthropic's published rates, as multipliers on the model's own input rate:
  // a cache READ is 0.1x, a cache WRITE at the default 5-minute TTL is 1.25x.
  const OPUS_IN = 500; // claude-opus-4-5: $5/MTok -> 500 µ¢/token
  const OPUS_OUT = 2_500;

  it("charges a cache read at a tenth of the input rate", () => {
    expect(
      costMicrocentsForUsage(
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000, cacheWriteTokens: 0 },
        "claude-opus-4-5",
        "anthropic"
      )
    ).toBe(1_000 * 50);
  });

  it("charges a cache write at 1.25x the input rate", () => {
    expect(
      costMicrocentsForUsage(
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000 },
        "claude-opus-4-5",
        "anthropic"
      )
    ).toBe(1_000 * 625);
  });

  it("adds the cache portions to the ordinary input and output charge", () => {
    expect(
      costMicrocentsForUsage(
        { inputTokens: 12, outputTokens: 200, cacheReadTokens: 18_000, cacheWriteTokens: 0 },
        "claude-opus-4-5",
        "anthropic"
      )
    ).toBe(12 * OPUS_IN + 200 * OPUS_OUT + 18_000 * 50);
  });

  // The regression this whole change exists to prevent. Reading `input_tokens`
  // alone priced a steady-state cached call at a fraction of its real cost.
  it("is dramatically higher than pricing input_tokens alone, for a cached call", () => {
    const usage = {
      inputTokens: 12,
      outputTokens: 200,
      cacheReadTokens: 18_000,
      cacheWriteTokens: 0,
    };
    const withCache = costMicrocentsForUsage(usage, "claude-opus-4-5", "anthropic");
    const oldBehaviour = costMicrocents(
      "claude-opus-4-5",
      usage.inputTokens,
      usage.outputTokens,
      "anthropic"
    );
    expect(withCache).toBeGreaterThan(oldBehaviour);
    // 900,000 µ¢ of cache reads on top of a 506,000 µ¢ base.
    expect(withCache - oldBehaviour).toBe(900_000);
  });

  it("agrees with costMicrocents exactly when nothing was cached", () => {
    for (const model of ["claude-opus-4-5", "gpt-4o-mini", "llama-3.3-70b-versatile"]) {
      expect(costMicrocentsForUsage({ ...NO_USAGE, inputTokens: 1_000, outputTokens: 500 }, model))
        .toBe(costMicrocents(model, 1_000, 500));
    }
  });

  it("returns 0 for an unpriced model rather than inventing a cache rate", () => {
    expect(
      costMicrocentsForUsage(
        { inputTokens: 10, outputTokens: 10, cacheReadTokens: 10, cacheWriteTokens: 10 },
        "mystery-model"
      )
    ).toBe(0);
  });

  it("keeps every cache rate a whole number of micro-cents", () => {
    // A fractional µ¢/token rate would silently truncate to 0 for cheap models.
    for (const model of ["claude-3-5-haiku-20241022", "claude-haiku-4-5", "claude-opus-4-5"]) {
      const read = costMicrocentsForUsage({ ...NO_USAGE, cacheReadTokens: 1 }, model, "anthropic");
      const write = costMicrocentsForUsage({ ...NO_USAGE, cacheWriteTokens: 1 }, model, "anthropic");
      expect(Number.isInteger(read)).toBe(true);
      expect(Number.isInteger(write)).toBe(true);
      expect(read).toBeGreaterThan(0);
      expect(write).toBeGreaterThan(0);
    }
  });

});

// The receipt is the public artifact, so what it says about a cached call — and
// what it must NOT change about an uncached one — is a contract with strangers.
describe("what a receipt records about prompt-cache traffic", () => {
  const INPUT = {
    receiptId: "receipt-1",
    passportId: "cGFzc3BvcnQ",
    agentId: "agent-1",
    visaJti: "visa-1",
    provider: "anthropic",
    model: "claude-opus-4-5",
    method: "POST",
    path: "v1/messages",
    rawBody: JSON.stringify({ model: "claude-opus-4-5" }),
    inputTokens: 12,
    outputTokens: 200,
    costMicrocents: 1_406_000,
    status: "ok" as const,
    httpStatus: 200,
    startedAt: 1_700_000_000_000,
    latencyMs: 420,
  };

  it("names the cache traffic beside the uncached input, not folded into it", () => {
    const claims = buildReceiptClaims({
      ...INPUT,
      cacheReadTokens: 18_000,
      cacheWriteTokens: 1_200,
    });
    // `in` stays the provider's own input_tokens, so this receipt and the
    // provider's invoice agree on that number.
    expect(claims.use).toEqual({ in: 12, out: 200, cr: 18_000, cw: 1_200 });
  });

  // Additive-only versioning is what lets verifiers already deployed keep
  // working. Bumping `ver` for a new claim would make every one of them refuse
  // every new receipt as `unsupported_version` — the opposite of the intent.
  it("does not move the receipt version to carry the new claims", () => {
    const withCache = buildReceiptClaims({
      ...INPUT,
      cacheReadTokens: 18_000,
      cacheWriteTokens: 1_200,
    });
    const without = buildReceiptClaims(INPUT);
    expect(withCache.ver).toBe(without.ver);
  });

  it("leaves an uncached receipt exactly as it was before these claims existed", () => {
    expect(buildReceiptClaims(INPUT).use).toEqual({ in: 12, out: 200 });
    // Zero is "no cache traffic", not "a cache figure of zero" — the keys are
    // absent rather than present-and-0, so nothing changes for the vast majority
    // of receipts and old fixtures keep comparing equal.
    expect(
      buildReceiptClaims({ ...INPUT, cacheReadTokens: 0, cacheWriteTokens: 0 }).use
    ).toEqual({ in: 12, out: 200 });
  });

  it("explains where the money went on the public page", () => {
    // Without the cache figures this line read "12 tokens in · 200 out" against a
    // cost several times larger than 12 input tokens could account for.
    expect(describeTokenUse({ in: 12, out: 200, cr: 18_000, cw: 1_200 })).toBe(
      "12 tokens in · 200 out · 18,000 cached read · 1,200 written to cache"
    );
    expect(describeTokenUse({ in: 900, out: 100 })).toBe("900 tokens in · 100 out");
    expect(describeTokenUse({ in: 900, out: 100, cr: 0, cw: 0 })).toBe(
      "900 tokens in · 100 out"
    );
  });
});
