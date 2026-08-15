import { describe, expect, it } from "vitest";
import { PROVIDERS } from "@/lib/providers";
import { classifyUpstreamFailure, isClassifiableStatus } from "@/lib/providers/exhaustion";

// Real response bodies, kept verbatim. The whole classifier is a claim about what
// these look like on the wire, so a paraphrased fixture tests nothing.
const OPENAI_QUOTA = JSON.stringify({
  error: {
    message: "You exceeded your current quota, please check your plan and billing details.",
    type: "insufficient_quota",
    param: null,
    code: "insufficient_quota",
  },
});

const OPENAI_RATE_LIMIT = JSON.stringify({
  error: {
    message: "Rate limit reached for gpt-4o in organization org-abc on requests per min (RPM).",
    type: "requests",
    param: null,
    code: "rate_limit_exceeded",
  },
});

const ANTHROPIC_LOW_CREDIT = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message:
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  },
});

const ANTHROPIC_MALFORMED = JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: "messages: at least one message is required" },
});

const DEEPSEEK_BALANCE = JSON.stringify({
  error: {
    message: "Insufficient Balance",
    type: "unknown_error",
    param: null,
    code: "invalid_request_error",
  },
});

describe("classifyUpstreamFailure", () => {
  it("recognises OpenAI quota exhaustion", () => {
    expect(classifyUpstreamFailure("openai", 429, OPENAI_QUOTA)).toBe("credit_exhausted");
  });

  // The load-bearing negative. OpenAI answers 429 for BOTH a transient rate limit
  // and permanent quota exhaustion, and only `code` separates them. Classifying a
  // rate limit as exhaustion tells an agent to abandon a provider it should simply
  // have waited for — and, once phase 2 exists, spends a second provider's key on
  // a call the first one would have served a second later.
  it("does NOT treat an OpenAI rate limit as exhaustion", () => {
    expect(classifyUpstreamFailure("openai", 429, OPENAI_RATE_LIMIT)).toBeNull();
  });

  it("recognises Anthropic low credit, which arrives as a 400", () => {
    expect(classifyUpstreamFailure("anthropic", 400, ANTHROPIC_LOW_CREDIT)).toBe("credit_exhausted");
  });

  // Anthropic publishes no distinct code for low credit: an exhausted account and a
  // malformed request are both `400 invalid_request_error`, and the message is the
  // only thing that differs. That makes this the one free-text match in the table
  // and the one most able to go wrong, so it is pinned from both sides.
  it("does NOT treat an ordinary Anthropic 400 as exhaustion", () => {
    expect(classifyUpstreamFailure("anthropic", 400, ANTHROPIC_MALFORMED)).toBeNull();
  });

  it("recognises a DeepSeek 402", () => {
    expect(classifyUpstreamFailure("deepseek", 402, DEEPSEEK_BALANCE)).toBe("credit_exhausted");
  });

  // groq/mistral/together carry no verified signature yet. Silence here is the
  // designed answer, not an oversight: an unmatched provider passes the upstream
  // error through untouched, exactly as the gateway does today.
  it("returns null for a provider with no rule, whatever the body", () => {
    for (const provider of ["groq", "mistral", "together"] as const) {
      expect(classifyUpstreamFailure(provider, 429, OPENAI_QUOTA)).toBeNull();
      expect(classifyUpstreamFailure(provider, 402, DEEPSEEK_BALANCE)).toBeNull();
    }
  });

  it("returns null on a status the provider's rule does not name", () => {
    // The right body on the wrong status is not the signal.
    expect(classifyUpstreamFailure("openai", 500, OPENAI_QUOTA)).toBeNull();
    expect(classifyUpstreamFailure("anthropic", 429, ANTHROPIC_LOW_CREDIT)).toBeNull();
  });

  it("never throws on a body that is not the JSON it expects", () => {
    for (const body of ["", "not json", "null", "[]", '{"error":"a string"}', "{}"]) {
      for (const provider of PROVIDERS) {
        expect(() => classifyUpstreamFailure(provider, 429, body)).not.toThrow();
        expect(classifyUpstreamFailure(provider, 429, body)).toBeNull();
      }
    }
  });
});

describe("isClassifiableStatus", () => {
  // This is what decides whether the proxy reads the error body at all. Every
  // status NOT named here keeps streaming straight through, unread — so this
  // predicate is the boundary of the behaviour change, not an optimisation.
  it("names exactly the statuses each provider has a rule for", () => {
    expect(isClassifiableStatus("openai", 429)).toBe(true);
    expect(isClassifiableStatus("openai", 400)).toBe(false);
    expect(isClassifiableStatus("anthropic", 400)).toBe(true);
    expect(isClassifiableStatus("anthropic", 429)).toBe(false);
    expect(isClassifiableStatus("deepseek", 402)).toBe(true);
  });

  it("is false for every status on a provider with no rule", () => {
    for (const provider of ["groq", "mistral", "together"] as const) {
      for (const status of [400, 402, 429, 500, 503]) {
        expect(isClassifiableStatus(provider, status)).toBe(false);
      }
    }
  });

  // A status the classifier could never match must not cause a body read: that
  // read is what turns a streamed pass-through into a buffered one.
  it("agrees with the classifier — nothing classifies on an unread status", () => {
    const bodies = [OPENAI_QUOTA, ANTHROPIC_LOW_CREDIT, DEEPSEEK_BALANCE];
    for (const provider of PROVIDERS) {
      for (const status of [400, 401, 402, 403, 404, 429, 500, 502, 503]) {
        if (isClassifiableStatus(provider, status)) continue;
        for (const body of bodies) {
          expect(classifyUpstreamFailure(provider, status, body)).toBeNull();
        }
      }
    }
  });
});
