// Gemini is registered against Google's OpenAI-COMPATIBILITY endpoint, not the
// native `:generateContent` API. That is the whole reason this provider is a
// small change: the compat surface speaks OpenAI request bodies, OpenAI SSE
// frames and an OpenAI `usage` object, so `requestShapeFamily` and
// `usesOpenAiUsageShape` both put it in the existing "openai" family and the
// stream parser, usage accounting and connect-config renderers are untouched.
//
// These tests pin the parts of that decision that nothing else would catch.
// The four switches in lib/providers.ts are compile-enforced, but the two facts
// most likely to be wrong — the pricing rows and the doubled version segment in
// the model-listing URL — fail silently, and one of them fails with money.
import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  authHeaders,
  detectProviderFromKey,
  isProvider,
  modelListingUrl,
  requestShapeFamily,
  upstreamBaseUrl,
  usesOpenAiUsageShape,
} from "../lib/providers";
import { costMicrocents } from "../lib/pricing";
import { canonicalEndpointPath } from "../lib/scope";

describe("gemini is a registered provider", () => {
  it("is in PROVIDERS and passes the runtime guard", () => {
    expect(PROVIDERS).toContain("gemini");
    expect(isProvider("gemini")).toBe(true);
  });

  it("targets the OpenAI-compatibility base, which already carries its version segment", () => {
    expect(upstreamBaseUrl("gemini")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai"
    );
  });

  it("injects the key as a bearer token, not as x-goog-api-key", () => {
    // The compat endpoint takes `Authorization: Bearer`. x-goog-api-key is the
    // NATIVE API's header and would authenticate nothing here.
    expect(authHeaders("gemini", "AIza-test-not-a-real-key")).toEqual({
      authorization: "Bearer AIza-test-not-a-real-key",
    });
  });

  it("belongs to the openai request/usage family", () => {
    expect(requestShapeFamily("gemini")).toBe("openai");
    expect(usesOpenAiUsageShape("gemini")).toBe(true);
  });
});

describe("gemini model-listing URL", () => {
  // The trap: the generic branch appends `/v1/models` to the base. Gemini's
  // base already ends in `/v1beta/openai`, so the generic branch would emit
  // `.../v1beta/openai/v1/models` instead of the `/models` Google documents.
  // If that spelling is wrong the failure is invisible — the dashboard's
  // key-import probe finds no models and silently degrades to manual entry.
  it("does not double the version segment", () => {
    const url = modelListingUrl("gemini");
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/openai/models");
    expect(url).not.toContain("/openai/v1/");
  });
});

describe("gemini endpoint allowlist", () => {
  // Same shape as deepseek: the version lives in the base URL, so the client
  // path is `chat/completions`, never `v1/chat/completions`.
  it("allows the compat chat path", () => {
    expect(canonicalEndpointPath("gemini", "POST", ["chat", "completions"])).toEqual([
      "chat",
      "completions",
    ]);
  });

  it("allows the model listing", () => {
    expect(canonicalEndpointPath("gemini", "GET", ["models"])).toEqual(["models"]);
  });

  it("still denies by default", () => {
    expect(canonicalEndpointPath("gemini", "POST", ["v1", "messages"])).toBeNull();
  });
});

describe("gemini key detection", () => {
  // Fixture note: this value must NOT match /AIza[A-Za-z0-9]{20,}/, because
  // scripts/curate-public.sh:154 fails the public-mirror build on that pattern
  // and tests/ ships to the mirror. The hyphens break the character class while
  // still exercising the AIza prefix branch.
  it("suggests gemini for an AIza-prefixed key", () => {
    const guess = detectProviderFromKey("AIza-test-not-a-real-key");
    expect(guess.suggested).toBe("gemini");
    expect(guess.ambiguous).toBe(false);
  });

  it("does not claim keys that merely contain AIza", () => {
    expect(detectProviderFromKey("sk-ant-AIza-somewhere-inside").suggested).toBe("anthropic");
  });
});

describe("gemini pricing — the bug this provider must not ship with", () => {
  // lib/pricing.ts returns 0 when no row matches, and says so itself: "a
  // provider was added without pricing rows ... should be treated as a bug".
  // FALLBACK_PRICES is derived FROM PRICES, so a provider with no rows has no
  // fallback either. Cost 0 means dollar budget caps never bind for Gemini and
  // every receipt reads $0. Nothing in the build or the rest of the suite
  // catches it, which is why it is asserted here first.
  it("prices a known model above zero", () => {
    expect(costMicrocents("gemini-2.5-flash", 1000, 500, "gemini")).toBeGreaterThan(0);
  });

  it("prices an UNKNOWN gemini model above zero via the fallback row", () => {
    expect(costMicrocents("gemini-9-does-not-exist", 1000, 500, "gemini")).toBeGreaterThan(0);
  });

  it("charges more for output than for input", () => {
    const inputOnly = costMicrocents("gemini-2.5-flash", 1000, 0, "gemini");
    const outputOnly = costMicrocents("gemini-2.5-flash", 0, 1000, "gemini");
    expect(outputOnly).toBeGreaterThan(inputOnly);
  });

  it("prices 2.5 Pro at the HIGHER context tier, so a long prompt never under-reserves", () => {
    // Google tiers 2.5 Pro by prompt length (<=200k vs >200k). The price table
    // has no context dimension, and lib/pricing.ts's stated invariant is to
    // round up and never under-reserve — so the >200k rate is the correct one:
    // $2.50/M in, $15.00/M out => 250 and 1500 µ¢/token.
    expect(costMicrocents("gemini-2.5-pro", 1000, 500, "gemini")).toBe(1000 * 250 + 500 * 1500);
  });

  it("does not reuse another provider's pricing", () => {
    // A Gemini model must not be priced by an OpenAI or Anthropic row.
    expect(costMicrocents("gemini-2.5-flash", 1000, 500, "gemini")).not.toBe(
      costMicrocents("gemini-2.5-flash", 1000, 500, "openai")
    );
  });
});
