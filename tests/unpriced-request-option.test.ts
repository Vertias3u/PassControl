// Request options that multiply a call's price beyond its table row: a paid
// service tier (OpenAI Fast/"priority" ~2x, Gemini Priority ~1.8x, Mistral
// Priority), Anthropic fast mode (`speed`, 2x) and US-only inference
// (`inference_geo`, 1.1x). Under a dollar limit such a request is refused, for
// the reason an unpriced model is: the limit would be enforced with a number
// below the bill. Pages read 2026-09-27 (see tests/pricing-table.test.ts).
import { describe, expect, it } from "vitest";
import { unpricedRequestOption } from "../lib/pricing";

describe("unpricedRequestOption", () => {
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
