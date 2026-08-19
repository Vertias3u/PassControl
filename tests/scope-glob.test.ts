import { describe, expect, it } from "vitest";
import { scopeAllows, endpointAllows, isModelListing, canonicalEndpointPath } from "@/lib/scope";

/**
 * The glob matcher is shared by the SHADOW simulator and the LIVE gate, so
 * rewriting it to remove the backtracking regex is a change to what the gateway
 * enforces unless it is exactly equivalent.
 *
 * This file is the equivalence proof. `legacyMatch` below is the implementation
 * that shipped — glob translated to an anchored regular expression — kept here
 * as an ORACLE, never imported into the app. Every assertion in this file passed
 * before the rewrite and must keep passing after it.
 *
 * The oracle is only ever run on patterns with at most three wildcards. It is
 * the thing being replaced precisely because it is exponential on more.
 */
function legacyMatch(pattern: string, model: string): boolean {
  if (model.length > 200) return false;
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === model;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(model);
}

/** The matcher is only reachable through a scope entry, so ask it that way. */
function matches(pattern: string, model: string): boolean {
  return scopeAllows([{ provider: "openai", models: [pattern] }], "openai", model);
}

describe("glob matching, pinned against the regex implementation it replaced", () => {
  it.each([
    // Shapes an operator writes.
    ["gpt-4o", "gpt-4o", true],
    ["gpt-4o", "gpt-4o-mini", false],
    ["gpt-4*", "gpt-4o-mini", true],
    ["gpt-4*", "gpt-3.5-turbo", false],
    ["*", "anything-at-all", true],
    ["*-preview", "o1-preview", true],
    ["*-preview", "o1-preview-2024", false],
    ["claude-3-*-sonnet*", "claude-3-5-sonnet-20241022", true],
    ["claude-3-*-sonnet*", "claude-3-5-haiku-20241022", false],
    ["gpt*4*o", "gpt-4o", true],
    // A wildcard matches the empty string.
    ["gpt-4*", "gpt-4", true],
    ["*gpt-4*", "gpt-4", true],
    // Regex metacharacters in a pattern are LITERAL. This is the classic
    // regression a glob rewrite introduces: `.` must not become "any character".
    ["gpt-4.1*", "gpt-4X1-turbo", false],
    ["gpt-4.1*", "gpt-4.1-mini", true],
    ["a+b", "a+b", true],
    ["a+b", "aab", false],
    ["(o1)*", "(o1)-preview", true],
    ["a|b", "a", false],
    ["[abc]*", "[abc]x", true],
    ["[abc]*", "b", false],
    // A backslash is literal; the `*` after it is still a wildcard.
    ["a\\*b", "a\\zb", true],
    ["a\\*b", "azb", false],
    ["a$*", "a$x", true],
    // Case-sensitive, both sides of a wildcard.
    ["GPT-4*", "gpt-4o", false],
    ["gpt-4*", "GPT-4o", false],
    ["gpt-4o", "GPT-4O", false],
  ])("%s vs %s", (pattern, model, expected) => {
    expect(legacyMatch(pattern as string, model as string)).toBe(expected as boolean);
    expect(matches(pattern as string, model as string)).toBe(expected as boolean);
  });

  it("keeps the bare-* / wildcard asymmetry over line terminators", () => {
    // `*` short-circuits to true before any matching happens, so it matches a
    // model containing a newline. A wildcard INSIDE a pattern was compiled to
    // `.*`, which does not cross a line terminator. That asymmetry is odd, but
    // widening the wildcard would widen an ALLOW-list, so it is preserved rather
    // than tidied. Pinned here so the choice is visible if it is ever revisited.
    for (const model of ["a\nb", "a\rb", "a\u2028b", "a\u2029b"]) {
      expect(legacyMatch("*", model)).toBe(true);
      expect(matches("*", model)).toBe(true);
      expect(legacyMatch("a*b", model)).toBe(false);
      expect(matches("a*b", model)).toBe(false);
    }
    // Nothing else about a control character changes.
    expect(matches("a*b", "a\tb")).toBe(true);
  });

  it("refuses a model longer than the bound, wildcard or not", () => {
    const long = "a".repeat(201);
    expect(matches("*", long)).toBe(false);
    expect(matches("a*", long)).toBe(false);
    expect(matches(long, long)).toBe(false);
  });

  it("agrees with the regex implementation on random patterns", () => {
    // Deterministic PRNG: a fuzz that cannot be reproduced is a rumour.
    let seed = 0x9e3779b9;
    const rnd = (n: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    const alphabet = [..."ab-.*+?^${}()|[]\\/0123456789", "\n", "\t"];
    for (let i = 0; i < 20_000; i++) {
      let pattern = "";
      const patternLen = rnd(7);
      let stars = 0;
      for (let c = 0; c < patternLen; c++) {
        const ch = alphabet[rnd(alphabet.length)] as string;
        if (ch === "*" && ++stars > 3) continue; // keep the oracle out of its own trap
        pattern += ch;
      }
      let model = "";
      const modelLen = rnd(8);
      for (let c = 0; c < modelLen; c++) {
        model += alphabet[rnd(alphabet.length)] as string;
      }
      const expected = legacyMatch(pattern, model);
      expect(
        matches(pattern, model),
        `pattern ${JSON.stringify(pattern)} model ${JSON.stringify(model)}`
      ).toBe(expected);
    }
  });
});

// ── Retrieving ONE model's metadata ──────────────────────────────────────────
//
// `pathEquals` is exact-length, so `GET /v1/models/{id}` — the standard
// single-model retrieve — could never match the length-2 listing rule and was
// refused as `blocked_endpoint`. That is what an agent's "detect context length"
// probe uses, so a supported integration pinged an unrouted path before, during
// and after every prompt and filled the board with refusals.
//
// Admitting it is the narrow fix: it is a read-only GET that returns strictly
// LESS than `GET /v1/models`, which is already allowed and already exempt from
// the per-model scope check. Gating the narrower call more tightly than the
// broader one would be incoherent — "I may list every model but not read one".
describe("single-model retrieve", () => {
  it("is admitted as a GET, for every provider that admits the listing", () => {
    expect(endpointAllows("anthropic", "GET", ["v1", "models", "claude-haiku-4-5-20251001"])).toBe(true);
    expect(endpointAllows("openai", "GET", ["v1", "models", "gpt-4.1"])).toBe(true);
    expect(endpointAllows("openai", "GET", ["models", "gpt-4.1"])).toBe(true);
    expect(endpointAllows("groq", "GET", ["v1", "models", "llama-3.3-70b"])).toBe(true);
  });

  it("stays GET-only — it must not become a write path", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(endpointAllows("openai", "GET".replace("GET", method), ["v1", "models", "gpt-4.1"]))
        .toBe(false);
    }
  });

  it("admits exactly one extra segment, never a deeper path", () => {
    // Deep paths are how a "models" prefix would become a way into anything the
    // provider happens to nest under it.
    expect(endpointAllows("openai", "GET", ["v1", "models", "a", "b"])).toBe(false);
    expect(endpointAllows("openai", "GET", ["v1", "models", ""])).toBe(false);
  });

  it("refuses a segment that could restructure the upstream URL", () => {
    // The route guard already rejects these, but the matcher must not depend on
    // a caller having run it — this list is joined straight into the upstream URL.
    for (const bad of ["..", "../fine_tuning", "a/b", "%2e%2e", "a%2fb"]) {
      expect(endpointAllows("openai", "GET", ["v1", "models", bad])).toBe(false);
    }
  });

  it("is treated as model listing, so no per-model scope match is required", () => {
    // Consistency with GET /v1/models, which is exempt for the same reason: the
    // call carries no model to run inference on. It is gated by this allowlist.
    expect(isModelListing(["v1", "models", "gpt-4.1"])).toBe(true);
    expect(isModelListing(["models", "gpt-4.1"])).toBe(true);
  });

  it("carries the requested model through to the upstream path, encoded", () => {
    // Encoded so the segment can only ever BE one segment: it cannot introduce
    // a slash, a query or a fragment into a URL built by joining these parts.
    expect(canonicalEndpointPath("openai", "GET", ["models", "gpt-4.1"]))
      .toEqual(["v1", "models", "gpt-4.1"]);
    expect(canonicalEndpointPath("openai", "GET", ["v1", "models", "a b"]))
      .toEqual(["v1", "models", "a%20b"]);
    expect(canonicalEndpointPath("openai", "GET", ["v1", "models", "a?b#c"]))
      .toEqual(["v1", "models", "a%3Fb%23c"]);
  });

  it("leaves the plain listing exactly as it was", () => {
    expect(endpointAllows("openai", "GET", ["v1", "models"])).toBe(true);
    expect(endpointAllows("openai", "POST", ["v1", "models"])).toBe(false);
    expect(canonicalEndpointPath("openai", "GET", ["v1", "models"])).toEqual(["v1", "models"]);
  });

  it("does not admit a retrieve where deepseek never admitted a listing", () => {
    // deepseek has no models rule today; this change must not invent one.
    expect(endpointAllows("deepseek", "GET", ["models", "deepseek-chat"])).toBe(false);
  });
});
