// Package 2, step 1: what an embeddings call reserves and what it is charged.
//
// An embeddings call generates nothing, so the two money numbers differ from
// chat in one way each:
//   - the estimate reserves NO output tokens (chat reserves the stated limit, or
//     1024 when none is stated — a phantom 1024 on every embedding would refuse
//     an agent near its cap for a call its budget could cover);
//   - the provider reports only `prompt_tokens` (and `total_tokens`), so a
//     response is complete WITHOUT `completion_tokens`. Under the chat rule it
//     would settle as usage_unknown and be charged the whole estimate.
// Nothing routes embeddings yet; these are the pure halves the proxy will use.
import { describe, expect, it } from "vitest";
import { estimateEmbeddingUsage } from "@/lib/pricing";
import { usageFromJson } from "@/lib/usage/parseStream";

describe("estimateEmbeddingUsage", () => {
  it("reserves no output, whatever the body says", () => {
    const e = estimateEmbeddingUsage({ model: "text-embedding-3-small", input: "hello", max_tokens: 4000, n: 8 });
    expect(e.outputTokens).toBe(0);
    expect(e.totalTokens).toBe(e.inputTokens);
  });

  it("sizes a string input by characters, the way the chat estimate does", () => {
    // JSON.stringify("hello world") is 13 characters → ceil(13 / 4) = 4.
    expect(estimateEmbeddingUsage({ input: "hello world" }).inputTokens).toBe(4);
  });

  it("sums a batch of strings", () => {
    const one = estimateEmbeddingUsage({ input: "a".repeat(398) }).inputTokens; // 400 chars → 100
    expect(one).toBe(100);
    expect(estimateEmbeddingUsage({ input: ["a".repeat(398), "a".repeat(398), "a".repeat(398)] }).inputTokens).toBe(300);
  });

  it("counts pre-tokenised input exactly: one token per number", () => {
    expect(estimateEmbeddingUsage({ input: [101, 2023, 2003, 102] }).inputTokens).toBe(4);
    expect(estimateEmbeddingUsage({ input: [[1, 2, 3], [4, 5], [6]] }).inputTokens).toBe(6);
  });

  it("does not let a huge batch round down to nothing", () => {
    const batch = Array.from({ length: 2048 }, () => "x".repeat(2000));
    expect(estimateEmbeddingUsage({ input: batch }).inputTokens).toBeGreaterThanOrEqual(2048 * 500);
  });

  it("gives a missing or malformed input the same one-token floor as an empty chat body", () => {
    // The provider refuses such a request; it is not one to size, and the floor
    // matches estimateTokenUsage so the decision trace projects identically.
    for (const body of [{}, { input: null }, { input: 42 }, { input: { nested: true } }, null, "text"]) {
      const e = estimateEmbeddingUsage(body);
      expect(e.outputTokens).toBe(0);
      expect(e.inputTokens).toBeGreaterThanOrEqual(1);
      expect(e.totalTokens).toBe(e.inputTokens);
    }
  });

  it("sizes a mixed array as characters, never as the smaller token count", () => {
    // Not a valid token array (it holds a string), so it is read as text.
    const mixed = estimateEmbeddingUsage({ input: [1, "a".repeat(400)] }).inputTokens;
    expect(mixed).toBeGreaterThanOrEqual(100);
  });
});

describe("usageFromJson with the embeddings protocol", () => {
  const body = (usage: unknown) => ({ object: "list", data: [{ object: "embedding", index: 0, embedding: "AAAA" }], model: "m", usage });

  it("is complete on prompt_tokens alone and charges no output", () => {
    const u = usageFromJson("openai", body({ prompt_tokens: 12, total_tokens: 12 }), "embeddings");
    expect(u).toMatchObject({ inputTokens: 12, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, sawUsage: true, complete: true });
  });

  it("is the same for every OpenAI-shaped provider that serves embeddings", () => {
    for (const provider of ["mistral", "together", "gemini"] as const) {
      expect(usageFromJson(provider, body({ prompt_tokens: 7, total_tokens: 7 }), "embeddings").complete).toBe(true);
    }
  });

  it("counts a reported completion_tokens rather than discarding it", () => {
    // Embeddings generate nothing, but if a provider ever reports output the
    // gateway charges what was reported — never less.
    const u = usageFromJson("openai", body({ prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }), "embeddings");
    expect(u.outputTokens).toBe(3);
    expect(u.complete).toBe(true);
  });

  it("is not complete without usage, so the call settles as usage_unknown", () => {
    const u = usageFromJson("openai", { object: "list", data: [] }, "embeddings");
    expect(u.sawUsage).toBe(false);
    expect(u.complete).toBe(false);
  });

  it("is not complete when prompt_tokens is not a whole non-negative number", () => {
    for (const bad of ["12", -1, 1.5, null]) {
      expect(usageFromJson("openai", body({ prompt_tokens: bad, total_tokens: 12 }), "embeddings").complete).toBe(false);
    }
  });

  it("is not complete when a reported completion_tokens is malformed", () => {
    expect(usageFromJson("openai", body({ prompt_tokens: 5, completion_tokens: "3" }), "embeddings").complete).toBe(false);
    // null is not zero: a provider that states the field but not a number has not
    // reported it, so the call settles as usage_unknown (charged ≥ its estimate).
    expect(usageFromJson("mistral", body({ prompt_tokens: 5, completion_tokens: null }), "embeddings").complete).toBe(false);
  });

  it("is complete on Mistral's documented usage block", () => {
    // docs.mistral.ai/api/endpoint/embeddings, example response, read 2026-09-27:
    // every field required; completion_tokens is an integer (0); the audio field is null.
    const u = usageFromJson(
      "mistral",
      body({ prompt_tokens: 15, completion_tokens: 0, total_tokens: 15, prompt_audio_seconds: null }),
      "embeddings"
    );
    expect(u).toMatchObject({ inputTokens: 15, outputTokens: 0, sawUsage: true, complete: true });
  });

  it("leaves the chat rule unchanged: prompt_tokens alone is still incomplete there", () => {
    expect(usageFromJson("openai", body({ prompt_tokens: 12, total_tokens: 12 })).complete).toBe(false);
  });
});
