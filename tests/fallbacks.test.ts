import { describe, expect, it } from "vitest";
import {
  MAX_FALLBACKS,
  failoverReasonFor,
  mayHaveBeenBilled,
  parseFallbacks,
} from "@/lib/providers/fallbacks";

const OPENAI_QUOTA = JSON.stringify({
  error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" },
});
const OPENAI_RATE_LIMIT = JSON.stringify({
  error: { message: "Rate limit reached.", type: "requests", code: "rate_limit_exceeded" },
});

describe("failoverReasonFor", () => {
  it("names credit exhaustion ahead of the bare status", () => {
    expect(failoverReasonFor("openai", 429, OPENAI_QUOTA)).toBe("credit_exhausted");
  });

  it("still retries a plain rate limit, under its own reason", () => {
    expect(failoverReasonFor("openai", 429, OPENAI_RATE_LIMIT)).toBe("rate_limited");
  });

  it("retries the 5xx range", () => {
    for (const status of [500, 502, 503, 529, 599]) {
      expect(failoverReasonFor("openai", status, "{}")).toBe("upstream_5xx");
    }
  });

  // The allowlist's whole point. These say something about the request or the
  // key — a second provider gets the same broken call and a second key is spent
  // on the same failure.
  it("never retries a status that blames the request", () => {
    for (const status of [400, 401, 403, 404, 409, 413, 422]) {
      expect(failoverReasonFor("openai", status, "{}")).toBeNull();
    }
  });

  it("is not fooled into retrying a 2xx or a 3xx", () => {
    for (const status of [200, 201, 204, 301, 302]) {
      expect(failoverReasonFor("openai", status, "{}")).toBeNull();
    }
  });
});

describe("mayHaveBeenBilled", () => {
  // The distinction a finance reader needs from a receipt: after a 5xx or a
  // dropped connection the provider may have run and charged the call, so one
  // client request can appear on two bills.
  it("separates the reasons that could have been charged from the ones that could not", () => {
    expect(mayHaveBeenBilled("upstream_5xx")).toBe(true);
    expect(mayHaveBeenBilled("unreachable")).toBe(true);
    expect(mayHaveBeenBilled("credit_exhausted")).toBe(false);
    expect(mayHaveBeenBilled("rate_limited")).toBe(false);
  });
});

describe("parseFallbacks", () => {
  it("reads an ordered list of concrete provider/model pairs", () => {
    expect(
      parseFallbacks([
        { provider: "groq", model: "llama-3.3-70b" },
        { provider: "mistral", model: "mistral-large-latest" },
      ])
    ).toEqual([
      { provider: "groq", model: "llama-3.3-70b" },
      { provider: "mistral", model: "mistral-large-latest" },
    ]);
  });

  // Both spellings of "off". A column that has never been written and one an
  // operator has emptied must behave identically — as the gateway did before
  // failover existed.
  it("treats null, undefined and [] as no failover", () => {
    for (const value of [null, undefined, []]) {
      expect(parseFallbacks(value)).toEqual([]);
    }
  });

  // The column is granted to `authenticated`, so a tenant can PATCH arbitrary
  // jsonb into it through PostgREST, bypassing validateFallbacks entirely. This
  // parser is the gateway's boundary against that, exactly as parsePolicy is for
  // policy. It must never throw and never return something half-understood.
  it("never throws on hostile or malformed input", () => {
    for (const value of [
      42,
      "a string",
      { provider: "groq" },
      [[]],
      [null],
      [{ provider: "groq" }],
      [{ model: "llama-3.3-70b" }],
      [{ provider: "groq", model: "llama", extra: "field" }],
      [{ provider: "not-a-provider", model: "x" }],
      [{ provider: "groq", model: "" }],
      [{ provider: "groq", model: 7 }],
    ]) {
      expect(() => parseFallbacks(value)).not.toThrow();
      expect(parseFallbacks(value)).toEqual([]);
    }
  });

  // One bad entry rejects the whole list rather than being skipped. A partially
  // honoured list means the gateway is failing over somewhere the operator's
  // screen does not show, which is worse than not failing over at all.
  it("rejects the entire list when any entry is malformed", () => {
    expect(
      parseFallbacks([
        { provider: "groq", model: "llama-3.3-70b" },
        { provider: "groq", model: null },
      ])
    ).toEqual([]);
  });

  // A fallback names a model to CALL, not a scope pattern to match. "*" is a
  // legitimate scope entry and a meaningless thing to send upstream.
  it("rejects wildcard models — a fallback is called, not matched", () => {
    expect(parseFallbacks([{ provider: "groq", model: "*" }])).toEqual([]);
    expect(parseFallbacks([{ provider: "groq", model: "llama-*" }])).toEqual([]);
  });

  it("refuses a list longer than the cap rather than truncating it", () => {
    const tooMany = Array.from({ length: MAX_FALLBACKS + 1 }, () => ({
      provider: "groq",
      model: "llama-3.3-70b",
    }));
    // Truncating would silently honour a different list than the operator saved.
    expect(parseFallbacks(tooMany)).toEqual([]);
    expect(MAX_FALLBACKS).toBeLessThanOrEqual(3);
  });

  it("bounds the model string", () => {
    expect(parseFallbacks([{ provider: "groq", model: "x".repeat(500) }])).toEqual([]);
  });
});
