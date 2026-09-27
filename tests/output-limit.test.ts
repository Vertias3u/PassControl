// K2 — how many output tokens a request asks for, read strictly per shape. A
// ceiling is only a ceiling if it is judged against the field the provider
// actually honours: a limit written in a field the provider ignores bounds
// nothing, and a value the provider would reinterpret is not a limit.
import { describe, expect, it } from "vitest";
import { outputLimitShape, requestedOutputTokens } from "@/lib/output-limit";

describe("outputLimitShape", () => {
  it("names the shape from the canonical upstream path", () => {
    expect(outputLimitShape("anthropic", ["v1", "messages"])).toBe("anthropic_messages");
    expect(outputLimitShape("openai", ["v1", "responses"])).toBe("openai_responses");
    expect(outputLimitShape("openai", ["v1", "chat", "completions"])).toBe("chat_completions");
    for (const provider of ["groq", "mistral", "together", "deepseek", "gemini", "demo"] as const) {
      expect(outputLimitShape(provider, ["chat", "completions"])).toBe("chat_completions");
    }
  });
});

describe("requestedOutputTokens", () => {
  it("reads Anthropic's max_tokens and nothing else", () => {
    expect(requestedOutputTokens("anthropic_messages", { max_tokens: 512 })).toEqual({ kind: "stated", tokens: 512 });
    // A chat-style alias on an Anthropic body bounds nothing Anthropic reads.
    expect(requestedOutputTokens("anthropic_messages", { max_completion_tokens: 512 })).toEqual({ kind: "absent" });
    // Anthropic has no `n`; a stray one is not a multiplier.
    expect(requestedOutputTokens("anthropic_messages", { max_tokens: 100, n: 5 })).toEqual({ kind: "stated", tokens: 100 });
  });

  it("reads Responses' max_output_tokens only", () => {
    expect(requestedOutputTokens("openai_responses", { max_output_tokens: 2048 })).toEqual({ kind: "stated", tokens: 2048 });
    expect(requestedOutputTokens("openai_responses", { max_tokens: 2048 })).toEqual({ kind: "absent" });
  });

  it("judges chat completions by the larger of both spellings, times n", () => {
    expect(requestedOutputTokens("chat_completions", { max_completion_tokens: 300 })).toEqual({ kind: "stated", tokens: 300 });
    expect(requestedOutputTokens("chat_completions", { max_tokens: 300 })).toEqual({ kind: "stated", tokens: 300 });
    expect(requestedOutputTokens("chat_completions", { max_tokens: 50, max_completion_tokens: 300 })).toEqual({ kind: "stated", tokens: 300 });
    expect(requestedOutputTokens("chat_completions", { max_tokens: 300, n: 3 })).toEqual({ kind: "stated", tokens: 900 });
    // Responses' field on a chat body is not honoured by chat providers.
    expect(requestedOutputTokens("chat_completions", { max_output_tokens: 300 })).toEqual({ kind: "absent" });
  });

  it("treats no limit, and an explicit null, as absent", () => {
    expect(requestedOutputTokens("chat_completions", {})).toEqual({ kind: "absent" });
    expect(requestedOutputTokens("chat_completions", { max_tokens: null })).toEqual({ kind: "absent" });
    expect(requestedOutputTokens("chat_completions", null)).toEqual({ kind: "absent" });
  });

  it("refuses to read a value the provider would reinterpret", () => {
    for (const value of ["300", 0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, true, {}]) {
      expect(requestedOutputTokens("chat_completions", { max_tokens: value })).toEqual({ kind: "invalid", field: "max_tokens" });
    }
    for (const n of [0, -1, 1.5, "2", Number.NaN]) {
      expect(requestedOutputTokens("chat_completions", { max_tokens: 10, n })).toEqual({ kind: "invalid", field: "n" });
    }
    // One bad spelling poisons the request even beside a good one.
    expect(requestedOutputTokens("chat_completions", { max_completion_tokens: 10, max_tokens: "10" })).toEqual({
      kind: "invalid",
      field: "max_tokens",
    });
  });
});
