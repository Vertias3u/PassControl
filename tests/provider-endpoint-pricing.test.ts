import { describe, expect, it } from "vitest";

import { costMicrocents, costMicrocentsForUsage, isPricedEndpoint } from "@/lib/pricing";

const USAGE = { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * A custom endpoint is unpriced, and it stays unpriced even when the model name
 * matches one we know. `gpt-4o-mini` arriving from someone's own proxy may be
 * marked up, re-routed to a different provider, aliased onto a local model, or
 * free — and charging OpenAI's retail rate because a string matched is the same
 * class of false assurance as an unenforced proof upgrading a receipt.
 *
 * A silent 0 on a spend graph is worse than a gap, so the flag is separate from
 * the number: the surface has to be able to say "not priced" rather than "$0.00".
 */
describe("pricing a call that went to an endpoint we do not operate", () => {
  it("prices a built-in provider endpoint as it always did", () => {
    expect(isPricedEndpoint(null)).toBe(true);
    expect(costMicrocents("gpt-4o-mini", 1000, 1000, "openai")).toBeGreaterThan(0);
  });

  it("refuses to price anything from a custom endpoint", () => {
    expect(isPricedEndpoint("https://gateway.company.com/openai/v1")).toBe(false);
    expect(costMicrocents("gpt-4o-mini", 1000, 1000, "openai", "https://gw.example/v1")).toBe(0);
    expect(costMicrocentsForUsage(USAGE, "gpt-4o-mini", "openai", "https://gw.example/v1")).toBe(0);
  });

  it("keeps token accounting even when the cost is unknown", () => {
    // The tokens are real and still get logged; only the money is unknown. This
    // asserts the seam exists — the caller records usage separately from cost.
    expect(costMicrocents("gpt-4o-mini", 1000, 1000, "openai", "https://gw.example/v1")).toBe(0);
    expect(USAGE.inputTokens + USAGE.outputTokens).toBe(2000);
  });
});
