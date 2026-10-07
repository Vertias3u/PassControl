// A call to OpenAI's own host is sent with `service_tier: "auto"` when the client
// set none (owner, 2026-10-07). OpenAI documents that "When the `service_tier`
// parameter is set, the response body will include the `service_tier` value based
// on the processing mode actually used" (openai 6.49.0), and that "When not set,
// the default behavior is 'auto'". So the call runs exactly as before, and the
// tier GPT-6/5.6 settlement relies on (lib/pricing.ts) is always reported.
import { describe, expect, it } from "vitest";
import { withReportedServiceTier } from "../lib/providers/service-tier";

const body = { model: "gpt-6-sol", input: "hi" };

describe("withReportedServiceTier", () => {
  it("adds auto to an OpenAI chat or Responses call that sets no tier", () => {
    expect(withReportedServiceTier("openai", body, "responses", null)).toEqual({ ...body, service_tier: "auto" });
    expect(withReportedServiceTier("openai", body, "provider", null)).toEqual({ ...body, service_tier: "auto" });
  });

  it("returns a copy, and keeps whatever the client set, null included", () => {
    const input = { ...body };
    withReportedServiceTier("openai", input, "responses", null);
    expect(input).toEqual(body);
    for (const service_tier of ["flex", "priority", "default", null]) {
      const b = { ...body, service_tier };
      expect(withReportedServiceTier("openai", b, "responses", null)).toBe(b);
    }
  });

  it("leaves every other provider, a custom endpoint, and other endpoints alone", () => {
    for (const provider of ["azure", "xai", "groq", "openrouter", "anthropic"]) {
      expect(withReportedServiceTier(provider, body, "provider", null)).toBe(body);
    }
    expect(withReportedServiceTier("openai", body, "responses", "https://my-proxy.example/v1")).toBe(body);
    expect(withReportedServiceTier("openai", body, "embeddings", null)).toBe(body);
  });
});
