import { describe, expect, it } from "vitest";
import type { ScopeEntry } from "@/lib/auth/visa";
import { requestShapeFamily } from "@/lib/providers";
import { buildAlternatives } from "@/lib/providers/alternatives";

const chat = { method: "POST", path: ["chat", "completions"] as const };

function alternatives(args: {
  scopes: ScopeEntry[];
  providersWithKeys: string[];
  failing: "openai" | "anthropic" | "groq" | "mistral" | "together" | "deepseek";
  method?: string;
  path?: readonly string[];
}) {
  return buildAlternatives({
    scopes: args.scopes,
    providersWithKeys: args.providersWithKeys,
    failing: args.failing,
    method: args.method ?? chat.method,
    path: args.path ?? chat.path,
  });
}

describe("buildAlternatives", () => {
  // Today's normal case, and the reason this is asserted first. Passport issuance
  // writes exactly one scope entry (PassportIssuanceModal), and the editor that
  // can express a second provider only shipped on 2026-08-06 — so every agent
  // issued before it produces an empty array here. That is a first-class outcome,
  // not an edge case, and the 402 around it has to stay well-formed.
  it("returns nothing for a single-provider agent", () => {
    expect(
      alternatives({
        scopes: [{ provider: "anthropic", models: ["claude-*"] }],
        providersWithKeys: ["anthropic"],
        failing: "anthropic",
      })
    ).toEqual([]);
  });

  it("names a provider that is both in scope and holds a key", () => {
    expect(
      alternatives({
        scopes: [
          { provider: "openai", models: ["gpt-4o"] },
          { provider: "groq", models: ["llama-3.3-70b"] },
        ],
        providersWithKeys: ["openai", "groq"],
        failing: "openai",
      })
    ).toEqual([
      { provider: "groq", models: ["llama-3.3-70b"], same_shape: true, path: "/v1/groq/chat/completions" },
    ]);
  });

  // The scope snapshot is the visa's — the same source the scope gate used. If we
  // advertised anything outside it the agent would retry and be refused by our own
  // gate, which is a worse answer than saying nothing.
  it("never names a provider outside the visa's scope", () => {
    expect(
      alternatives({
        scopes: [{ provider: "openai", models: ["gpt-4o"] }],
        providersWithKeys: ["openai", "groq", "mistral"],
        failing: "openai",
      })
    ).toEqual([]);
  });

  it("never names a provider with no key stored", () => {
    expect(
      alternatives({
        scopes: [
          { provider: "openai", models: ["gpt-4o"] },
          { provider: "groq", models: ["llama-3.3-70b"] },
        ],
        providersWithKeys: ["openai"],
        failing: "openai",
      })
    ).toEqual([]);
  });

  it("never names the provider that just failed", () => {
    const result = alternatives({
      scopes: [
        { provider: "openai", models: ["gpt-4o"] },
        { provider: "groq", models: ["llama-3.3-70b"] },
      ],
      providersWithKeys: ["openai", "groq"],
      failing: "openai",
    });
    expect(result.map((entry) => entry.provider)).not.toContain("openai");
  });

  // The five-to-one split in ENDPOINT_ALLOWLIST: anthropic alone takes v1/messages.
  // A cross-shape alternative is still worth naming — the agent knows both SDKs
  // even though the gateway must never translate between them — but it must be
  // marked, or an agent retries against a path its own endpoint gate refuses.
  it("marks every alternative to a failed Anthropic call as a different shape", () => {
    const result = alternatives({
      scopes: [
        { provider: "anthropic", models: ["claude-*"] },
        { provider: "openai", models: ["gpt-4o"] },
        { provider: "groq", models: ["llama-3.3-70b"] },
      ],
      providersWithKeys: ["anthropic", "openai", "groq"],
      failing: "anthropic",
    });
    expect(result).toHaveLength(2);
    expect(result.every((entry) => entry.same_shape === false)).toBe(true);
    expect(result.map((entry) => entry.path)).toEqual([
      "/v1/openai/chat/completions",
      "/v1/groq/chat/completions",
    ]);
  });

  it("marks an Anthropic alternative to a failed OpenAI call as a different shape", () => {
    const result = alternatives({
      scopes: [
        { provider: "openai", models: ["gpt-4o"] },
        { provider: "anthropic", models: ["claude-sonnet-4-5"] },
      ],
      providersWithKeys: ["openai", "anthropic"],
      failing: "openai",
    });
    expect(result).toEqual([
      {
        provider: "anthropic",
        models: ["claude-sonnet-4-5"],
        same_shape: false,
        path: "/v1/anthropic/v1/messages",
      },
    ]);
  });

  it("orders same-shape alternatives ahead of ones needing a rewrite", () => {
    const result = alternatives({
      scopes: [
        { provider: "openai", models: ["gpt-4o"] },
        { provider: "anthropic", models: ["claude-sonnet-4-5"] },
        { provider: "together", models: ["*"] },
      ],
      providersWithKeys: ["openai", "anthropic", "together"],
      failing: "openai",
    });
    expect(result.map((entry) => entry.provider)).toEqual(["together", "anthropic"]);
  });

  it("preserves scope order within a shape family", () => {
    const result = alternatives({
      scopes: [
        { provider: "openai", models: ["gpt-4o"] },
        { provider: "mistral", models: ["mistral-large"] },
        { provider: "groq", models: ["llama-3.3-70b"] },
      ],
      providersWithKeys: ["openai", "mistral", "groq"],
      failing: "openai",
    });
    expect(result.map((entry) => entry.provider)).toEqual(["mistral", "groq"]);
  });

  // A model the agent is not scoped for is a model the gate would refuse. Echo the
  // scope entry rather than resolving or substituting anything — the gateway has no
  // basis for deciding two models are equivalent, which is exactly what DECISIONS
  // forbids it from guessing.
  it("echoes the agent's own model patterns rather than inventing any", () => {
    const result = alternatives({
      scopes: [
        { provider: "openai", models: ["gpt-4o"] },
        { provider: "groq", models: ["llama-3.3-70b", "mixtral-*"] },
      ],
      providersWithKeys: ["openai", "groq"],
      failing: "openai",
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.models).toEqual(["llama-3.3-70b", "mixtral-*"]);
  });

  // allowed_scopes is jsonb and the visa carries it verbatim, so a scope entry can
  // name something that is not a provider we serve. It must be skipped, not
  // advertised and not thrown on.
  it("ignores a scope entry naming an unknown provider", () => {
    expect(() =>
      alternatives({
        scopes: [
          { provider: "openai", models: ["gpt-4o"] },
          { provider: "not-a-provider", models: ["*"] },
        ],
        providersWithKeys: ["openai", "not-a-provider"],
        failing: "openai",
      })
    ).not.toThrow();
    expect(
      alternatives({
        scopes: [
          { provider: "openai", models: ["gpt-4o"] },
          { provider: "not-a-provider", models: ["*"] },
        ],
        providersWithKeys: ["openai", "not-a-provider"],
        failing: "openai",
      })
    ).toEqual([]);
  });

  it("never names the same provider twice, even if scope repeats it", () => {
    const result = alternatives({
      scopes: [
        { provider: "openai", models: ["gpt-4o"] },
        { provider: "groq", models: ["llama-3.3-70b"] },
        { provider: "groq", models: ["mixtral-*"] },
      ],
      providersWithKeys: ["openai", "groq"],
      failing: "openai",
    });
    expect(result.map((entry) => entry.provider)).toEqual(["groq"]);
  });

  it("points a model-listing failure at the alternative's model-listing path", () => {
    const result = alternatives({
      scopes: [
        { provider: "openai", models: ["*"] },
        { provider: "groq", models: ["*"] },
      ],
      providersWithKeys: ["openai", "groq"],
      failing: "openai",
      method: "GET",
      path: ["models"],
    });
    expect(result).toEqual([
      { provider: "groq", models: ["*"], same_shape: true, path: "/v1/groq/models" },
    ]);
  });
});

describe("requestShapeFamily", () => {
  // Deliberately NOT derived from usesOpenAiUsageShape. That predicate is about
  // parsing usage out of a response; this one is about the request body the client
  // must send. They agree five-to-one today by coincidence, not by contract, and
  // collapsing them would make a future divergence silently wrong.
  it("puts anthropic alone", () => {
    expect(requestShapeFamily("anthropic")).toBe("anthropic");
    for (const provider of ["openai", "groq", "mistral", "together", "deepseek"] as const) {
      expect(requestShapeFamily(provider)).toBe("openai");
    }
  });
});
