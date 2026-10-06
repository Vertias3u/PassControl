// Every provider's default client model — the one the CLI presets, Direct Connect
// and the quickstarts put in "Model to call" — must be priced by its own row,
// not by the provider's catch-all. The catch-all bills at the highest LISTED
// rate per dimension, so a cheap default that falls through to it over-charges
// every new agent that keeps it. Found 2026-09-27 on two defaults at once:
// `gemini-3.8-flash` (the switch away from `gemini-2.5-flash`, which Google
// closed to new accounts) and OpenAI's `gpt-5-mini`, which had no row at all.
import { describe, expect, it } from "vitest";
import { DEFAULT_CLIENT_MODELS } from "../cli/integration-defaults.mjs";
import { costMicrocents, hasListedPrice } from "../lib/pricing";
import type { ProviderId } from "../lib/providers";

describe("hasListedPrice", () => {
  it("is false for a model with no row of its own", () => {
    expect(hasListedPrice("gemini-9-does-not-exist", "gemini")).toBe(false);
    expect(hasListedPrice("claude-does-not-exist", "anthropic")).toBe(false);
    expect(hasListedPrice("gpt-does-not-exist", "openai")).toBe(false);
  });
  it("is true for a listed model, including one that is its provider's most expensive", () => {
    expect(hasListedPrice("gemini-2.5-flash", "gemini")).toBe(true);
    expect(hasListedPrice("qwen/qwen3.8-27b", "groq")).toBe(true);
  });
});

describe("default client models are priced by a specific row", () => {
  // Azure's default is a deployment-name guess on a provider that is never
  // priced (tests/azure-provider.test.ts), so it has no row to check. Neither
  // has `local`: a model on the developer's own server has no price at all.
  it.each(
    (Object.entries(DEFAULT_CLIENT_MODELS) as [ProviderId, string][]).filter(([p]) => p !== "azure" && p !== "local")
  )(
    "%s default %s",
    (provider, model) => {
      expect(hasListedPrice(model, provider)).toBe(true);
      expect(costMicrocents(model, 1_000_000, 1_000_000, provider)).toBeGreaterThan(0);
    }
  );
});

describe("gemini-3.8-flash", () => {
  // ai.google.dev/gemini-api/docs/pricing, read 2026-09-27, Paid tier Standard:
  // input $0.75, output (including thinking tokens) $3.75 per 1M tokens
  // "through December 31, 2026", then $1.50 / $7.50 — the same schedule as the
  // 3.6 and 3.7 Flash rows.
  it("is priced at $0.75 in / $3.75 out per 1M tokens", () => {
    expect(costMicrocents("gemini-3.8-flash", 1_000_000, 0, "gemini")).toBe(75 * 1_000_000);
    expect(costMicrocents("gemini-3.8-flash", 0, 1_000_000, "gemini")).toBe(375 * 1_000_000);
  });

  it("is the Gemini default client model", () => {
    expect(DEFAULT_CLIENT_MODELS.gemini).toBe("gemini-3.8-flash");
  });
});
