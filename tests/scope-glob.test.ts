import { describe, expect, it } from "vitest";
import { scopeAllows } from "@/lib/scope";

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
