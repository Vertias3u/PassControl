// Request options that multiply a call's price beyond its table row: a paid
// service tier (OpenAI Fast/"priority" ~2x, Gemini Priority ~1.8x, Mistral
// Priority), Anthropic fast mode (`speed`, 2x) and US-only inference
// (`inference_geo`, 1.1x). Under a dollar limit such a request is refused, for
// the reason an unpriced model is: the limit would be enforced with a number
// below the bill. Pages read 2026-09-27 (see tests/pricing-table.test.ts).
import { describe, expect, it } from "vitest";
import { unpricedRequestOption } from "../lib/pricing";

describe("unpricedRequestOption", () => {
  const withBreakpoint = (ttl: string) => ({
    input: [{ role: "user", content: [{ type: "input_text", text: "hi", prompt_cache_breakpoint: { ttl } }] }],
  });

  it.each([
    ["12-hour TTL", { ttl: "12h" }],
    ["unknown TTL", { ttl: "1h" }],
    ["numeric TTL", { ttl: 7 }],
    ["null TTL", { ttl: null }],
    ["string options", "12h"],
    ["array options", []],
    ["null options", null],
  ])("refuses OpenAI prompt cache options with %s", (_name, options) => {
    expect(unpricedRequestOption("openai", { prompt_cache_options: options })).toBe("prompt_cache_options");
  });

  // A breakpoint is held to the request-level rule: anything but "30m" is refused.
  it.each(["12h", "1h", "12H"])("refuses a %s breakpoint inside Responses message content", (ttl) => {
    expect(unpricedRequestOption("openai", withBreakpoint(ttl))).toBe("prompt_cache_breakpoint");
  });

  it("refuses a breakpoint whose ttl is not a string, or that is not an object", () => {
    const at = (prompt_cache_breakpoint: unknown) => ({
      input: [{ role: "user", content: [{ type: "input_text", text: "hi", prompt_cache_breakpoint }] }],
    });
    for (const b of [{ ttl: 7 }, { ttl: null }, "12h", []]) {
      expect(unpricedRequestOption("openai", at(b))).toBe("prompt_cache_breakpoint");
    }
    expect(unpricedRequestOption("openai", at({}))).toBeNull();
  });

  // Wherever it appears, not only under `input`: Chat Completions `messages`, `tools`,
  // or anywhere else OpenAI might read one.
  it.each([
    ["messages", { messages: [{ role: "user", content: [{ type: "text", text: "hi", prompt_cache_breakpoint: { ttl: "12h" } }] }] }],
    ["tools", { tools: [{ type: "function", name: "f", prompt_cache_breakpoint: { ttl: "12h" } }] }],
    ["the top level", { prompt_cache_breakpoint: { ttl: "12h" } }],
  ])("refuses a 12h breakpoint in %s", (_where, body) => {
    expect(unpricedRequestOption("openai", body)).toBe("prompt_cache_breakpoint");
  });

  it("refuses a Responses input nested too deep to finish checking", () => {
    let input: unknown = "hi";
    for (let depth = 0; depth < 100; depth++) input = [input];
    expect(unpricedRequestOption("openai", { input })).toBe("prompt_cache_breakpoint");
  });

  // The proxy caps a body at 4 MB before this runs, so the walk needs no count of its
  // own. A long, honest session is far past any small count: refusing it would blame a
  // cache option the agent never sent.
  it("allows a long session with no breakpoint", () => {
    const input = Array.from({ length: 5_000 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: [{ type: "input_text", text: `turn ${i}` }],
    }));
    expect(unpricedRequestOption("openai", { input })).toBeNull();
  });

  it.each([
    ["openai", { service_tier: "priority" }, "service_tier"],
    ["openai", { service_tier: "fast" }, "service_tier"],
    ["gemini", { service_tier: "priority" }, "service_tier"],
    ["mistral", { service_tier: "priority" }, "service_tier"],
    ["openai", { service_tier: "scale" }, "service_tier"],
    ["openai", { service_tier: 7 }, "service_tier"],
    ["anthropic", { speed: "fast" }, "speed"],
    ["anthropic", { inference_geo: "us" }, "inference_geo"],
  ] as const)("%s %j → %s", (provider, body, field) => {
    expect(unpricedRequestOption(provider, body)).toBe(field);
  });

  it.each([
    ["openai", {}],
    ["openai", { prompt_cache_options: { ttl: "30m" } }],
    ["openai", { prompt_cache_options: {} }],
    ["openai", { prompt_cache_breakpoint: { ttl: "30m" } }],
    ["openai", withBreakpoint("30m")],
    ["openai", { input: [{ role: "user", content: JSON.stringify(withBreakpoint("12h")) }] }],
    ["openai", { prompt_cache_retention: "24h" }],
    ["openai", { prompt_cache_retention: "in_memory" }],
    ["anthropic", { prompt_cache_options: { ttl: "12h" }, ...withBreakpoint("12h") }],
    ["gemini", { prompt_cache_options: { ttl: "12h" }, ...withBreakpoint("12h") }],
    ["openai", { service_tier: "auto" }],
    ["openai", { service_tier: "default" }],
    ["openai", { service_tier: "flex" }],
    ["gemini", { service_tier: "standard" }],
    ["anthropic", { service_tier: "auto" }],
    ["anthropic", { service_tier: "standard_only" }],
    ["anthropic", { inference_geo: "global" }],
    ["anthropic", { speed: null }],
    ["openai", { speed: "fast" }],
  ] as const)("%s %j is priced by the table", (provider, body) => {
    expect(unpricedRequestOption(provider, body)).toBeNull();
  });

  it("ignores a body that is not an object", () => {
    expect(unpricedRequestOption("openai", null)).toBeNull();
    expect(unpricedRequestOption("openai", "text")).toBeNull();
  });
});
