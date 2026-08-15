import { describe, it, expect } from "vitest";
import {
  LIMITS,
  validateAgentInput,
  validateAgentUpdate,
  validateFallbacks,
  validatePolicy,
  validateProviderKeyInput,
  validateRotateInput,
  validateScopes,
} from "../lib/validate";
import { POLICY_LIMITS, scopeAllows } from "../lib/scope";
import {
  MAX_FALLBACKS,
  MAX_FALLBACK_MODEL_LEN,
  parseFallbacks,
} from "../lib/providers/fallbacks";

// A valid base64url-encoded 32-byte key (43 chars, no padding).
const VALID_PUBKEY = "A".repeat(43);

describe("validateAgentInput", () => {
  it("accepts a well-formed agent", () => {
    const out = validateAgentInput({
      name: "  Bot  ",
      passportPubkey: VALID_PUBKEY,
      scopes: [{ provider: "anthropic", models: ["claude-*"] }],
    });
    expect(out.name).toBe("Bot");
    expect(out.scopes[0]!.provider).toBe("anthropic");
  });
  it("accepts OpenAI-compatible providers in scopes", () => {
    const out = validateAgentInput({
      name: "Groq Bot",
      passportPubkey: VALID_PUBKEY,
      scopes: [{ provider: "groq", models: ["llama-*"] }],
    });
    expect(out.scopes[0]!.provider).toBe("groq");
  });
  it("rejects empty name", () => {
    expect(() => validateAgentInput({ name: "", passportPubkey: VALID_PUBKEY, scopes: [] })).toThrow();
  });
  it("rejects bad pubkey", () => {
    expect(() => validateAgentInput({ name: "x", passportPubkey: "nope", scopes: [] })).toThrow();
  });
  it("rejects unknown provider", () => {
    expect(() =>
      validateAgentInput({ name: "x", passportPubkey: VALID_PUBKEY, scopes: [{ provider: "evil", models: ["*"] }] })
    ).toThrow();
  });
});

describe("validateProviderKeyInput", () => {
  it("accepts valid", () => {
    expect(validateProviderKeyInput({ provider: "openai", label: "main", key: "sk-x" }).provider).toBe("openai");
  });
  it("accepts OpenAI-compatible provider keys", () => {
    expect(validateProviderKeyInput({ provider: "deepseek", label: "main", key: "sk-x" }).provider).toBe("deepseek");
  });
  it("rejects unknown provider + empty key", () => {
    expect(() => validateProviderKeyInput({ provider: "x", label: "", key: "k" })).toThrow();
    expect(() => validateProviderKeyInput({ provider: "openai", label: "", key: "" })).toThrow();
  });
});

describe("validateRotateInput", () => {
  it("requires a UUID credential id", () => {
    expect(() => validateRotateInput({ credentialId: "not-a-uuid", key: "k" })).toThrow();
    expect(
      validateRotateInput({ credentialId: "123e4567-e89b-12d3-a456-426614174000", key: "k" }).key
    ).toBe("k");
  });
});

describe("validateFallbacks", () => {
  it("accepts an ordered list of concrete provider/model pairs", () => {
    expect(
      validateFallbacks([
        { provider: "groq", model: "llama-3.3-70b" },
        { provider: " mistral ", model: "  mistral-large-latest  " },
      ])
    ).toEqual([
      { provider: "groq", model: "llama-3.3-70b" },
      { provider: "mistral", model: "mistral-large-latest" },
    ]);
  });

  it("accepts an empty list — that is how failover is turned off", () => {
    expect(validateFallbacks([])).toEqual([]);
  });

  it("rejects an unknown provider", () => {
    expect(() => validateFallbacks([{ provider: "evil", model: "x" }])).toThrow();
  });

  it("rejects a missing or non-string model", () => {
    expect(() => validateFallbacks([{ provider: "groq" }])).toThrow();
    expect(() => validateFallbacks([{ provider: "groq", model: 7 }])).toThrow();
    expect(() => validateFallbacks([{ provider: "groq", model: "  " }])).toThrow();
  });

  it("rejects a wildcard — a fallback names a model to call, not a pattern to match", () => {
    expect(() => validateFallbacks([{ provider: "groq", model: "*" }])).toThrow();
    expect(() => validateFallbacks([{ provider: "groq", model: "llama-*" }])).toThrow();
  });

  it("rejects a list longer than the cap", () => {
    const tooMany = Array.from({ length: MAX_FALLBACKS + 1 }, () => ({
      provider: "groq",
      model: "llama-3.3-70b",
    }));
    expect(() => validateFallbacks(tooMany)).toThrow();
  });

  it("rejects a model string longer than the gateway will parse", () => {
    expect(() =>
      validateFallbacks([{ provider: "groq", model: "x".repeat(MAX_FALLBACK_MODEL_LEN + 1) }])
    ).toThrow();
  });

  it("rejects a non-array", () => {
    for (const value of [null, undefined, 42, "groq", { provider: "groq", model: "x" }]) {
      expect(() => validateFallbacks(value)).toThrow();
    }
  });

  // The property that keeps the two ends of this feature honest.
  //
  // parseFallbacks rejects the ENTIRE list on any violation, so a validator that
  // is even slightly more permissive than the parser produces the worst possible
  // outcome: the operator's save succeeds, the editor shows the list back to
  // them, and the gateway honours none of it. Silent, and indistinguishable from
  // "the provider never failed".
  it("never accepts anything the gateway's parser would throw away", () => {
    const candidates: unknown[] = [
      [{ provider: "groq", model: "llama-3.3-70b" }],
      [
        { provider: "groq", model: "llama-3.3-70b" },
        { provider: "mistral", model: "mistral-large-latest" },
        { provider: "openai", model: "gpt-4o-mini" },
      ],
      [],
      [{ provider: "groq", model: "x".repeat(MAX_FALLBACK_MODEL_LEN) }],
      [{ provider: "anthropic", model: " claude-opus-5 " }],
    ];
    for (const candidate of candidates) {
      const accepted = validateFallbacks(candidate);
      // Round-trips through jsonb unchanged: what the column holds is what the
      // gateway will act on.
      expect(parseFallbacks(JSON.parse(JSON.stringify(accepted)))).toEqual(accepted);
    }
  });
});

describe("validateScopes — a saved pattern must be one the matcher will run", () => {
  it("accepts the wildcard shapes a scope actually uses", () => {
    expect(validateScopes([{ provider: "openai", models: ["gpt-4*", "*", "o1-*-preview"] }])).toEqual(
      [{ provider: "openai", models: ["gpt-4*", "*", "o1-*-preview"] }]
    );
  });

  it("rejects a wildcard-stuffed pattern instead of saving one that never matches", () => {
    // The matcher refuses these outright — evaluating them is the stall this
    // whole change is about. A validator that accepted one would store a scope
    // row the operator can see and the gateway will never honour.
    const stuffed = `${"a*".repeat(15)}b`;
    expect(scopeAllows([{ provider: "openai", models: [stuffed] }], "openai", "aaaaab")).toBe(false);
    expect(() => validateScopes([{ provider: "openai", models: [stuffed] }])).toThrow();
  });

  it("rejects a pattern longer than the matcher will evaluate", () => {
    expect(() =>
      validateScopes([{ provider: "openai", models: ["a".repeat(LIMITS.modelPattern + 1)] }])
    ).toThrow();
  });
});

describe("validatePolicy — bounds live in the parser, not in the form", () => {
  // Every case here is reachable WITHOUT the dashboard: a server action is
  // addressable over HTTP by its id, and both policy columns are jsonb a tenant
  // can PATCH. The form's own caps (10 rules, 6 windows) bound nothing.
  it("accepts a policy an operator would actually write", () => {
    const policy = {
      deny: [{ provider: "openai", models: ["gpt-4*"] }],
      windows: [{ days: ["mon"], start: "09:00", end: "18:00", tz: "UTC" }],
      max_requests_per_hour: 100,
    };
    expect(validatePolicy(policy)).toEqual(policy);
  });

  it("rejects more deny rules than the gateway will read", () => {
    const deny = Array.from({ length: POLICY_LIMITS.denyRules + 1 }, () => ({
      provider: "openai",
      models: ["gpt-4*"],
    }));
    expect(() => validatePolicy({ deny })).toThrow();
  });

  it("rejects more patterns than the gateway will read, however they are spread", () => {
    const perRule = 5;
    const rules = Math.ceil((POLICY_LIMITS.denyPatterns + 1) / perRule);
    const deny = Array.from({ length: rules }, () => ({
      provider: "openai",
      models: Array.from({ length: perRule }, (_, i) => `m${i}*`),
    }));
    expect(deny.length).toBeLessThanOrEqual(POLICY_LIMITS.denyRules); // under the rule cap …
    expect(() => validatePolicy({ deny })).toThrow(); // … and still refused
  });

  it("rejects a single rule carrying an unbounded model list", () => {
    const models = Array.from({ length: POLICY_LIMITS.modelsPerRule + 1 }, (_, i) => `m${i}`);
    expect(() => validatePolicy({ deny: [{ provider: "openai", models }] })).toThrow();
  });

  it("rejects more windows than the gateway will read", () => {
    const windows = Array.from({ length: POLICY_LIMITS.windows + 1 }, () => ({
      days: ["mon"],
      start: "09:00",
      end: "18:00",
      tz: "UTC",
    }));
    expect(() => validatePolicy({ windows })).toThrow();
  });

  it("still treats null as a value — that is how a policy is turned off", () => {
    expect(validatePolicy(null)).toBeNull();
    expect(validatePolicy(undefined)).toBeNull();
  });
});

describe("validateAgentUpdate — fallbacks", () => {
  it("passes a valid list through to the column patch", () => {
    const patch = validateAgentUpdate({ fallbacks: [{ provider: "groq", model: "llama-3.3-70b" }] });
    expect(patch.fallbacks).toEqual([{ provider: "groq", model: "llama-3.3-70b" }]);
  });

  it("leaves the column alone when the caller does not mention it", () => {
    const patch = validateAgentUpdate({ name: "Bot" });
    expect("fallbacks" in patch).toBe(false);
  });

  // [] is a real value, not "unset": it is how an operator turns failover off.
  it("distinguishes an empty list from an absent field", () => {
    const patch = validateAgentUpdate({ fallbacks: [] });
    expect(patch.fallbacks).toEqual([]);
  });

  it("rejects a bad list rather than dropping it silently", () => {
    expect(() => validateAgentUpdate({ fallbacks: [{ provider: "evil", model: "x" }] })).toThrow();
  });
});
