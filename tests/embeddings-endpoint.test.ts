// Package 2, step 2+3: which embeddings endpoints the gateway serves, and how
// the rest of the admission path treats them.
//
// Served where the provider's own docs confirm both the request and a usage
// report the gateway can settle on: OpenAI (installed SDK) and Mistral
// (docs.mistral.ai/api/endpoint/embeddings, read 2026-09-27: `POST /v1/embeddings`,
// `usage` required, with `prompt_tokens`). Everything else stays denied —
// deny-by-default is the allowlist's whole contract.
import { describe, expect, it } from "vitest";
import { evaluateGate, type GateInput } from "@/lib/gate";
import { PROVIDERS, type ProviderId } from "@/lib/providers";
import { buildAlternatives } from "@/lib/providers/alternatives";
import { costMicrocents } from "@/lib/pricing";
import {
  advertisedClientPath,
  canonicalEndpointPath,
  endpointAllows,
  isEmbeddingsEndpoint,
} from "@/lib/scope";

// Azure: learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/embeddings
// (v1, updated 2026-07-09, read 2026-09-29): `POST {endpoint}/openai/v1/embeddings`,
// and `usage.prompt_tokens` is a REQUIRED response field — the settle-on rule.
const SERVES_EMBEDDINGS: readonly ProviderId[] = ["openai", "mistral", "azure"];

describe("embeddings endpoint allowlist", () => {
  it.each(
    SERVES_EMBEDDINGS.flatMap((provider) => [
      [provider, ["embeddings"]],
      [provider, ["v1", "embeddings"]],
    ]) as [ProviderId, string[]][]
  )("serves %s POST /%s at the provider's /v1/embeddings", (provider, path) => {
    expect(endpointAllows(provider, "POST", path)).toBe(true);
    expect(canonicalEndpointPath(provider, "POST", path)).toEqual(["v1", "embeddings"]);
    expect(isEmbeddingsEndpoint(provider, "POST", path)).toBe(true);
  });

  it("keeps exact-segment, method-aware deny-by-default around it", () => {
    for (const [method, path] of [
      ["GET", ["v1", "embeddings"]],
      ["POST", ["v1", "embeddings", "extra"]],
      ["POST", ["v1", "embedding"]],
      ["POST", ["embeddings", "v1"]],
    ] as const) {
      expect(endpointAllows("openai", method, path)).toBe(false);
      expect(isEmbeddingsEndpoint("openai", method, path)).toBe(false);
    }
  });

  it.each(PROVIDERS.filter((p) => !SERVES_EMBEDDINGS.includes(p)))(
    "denies embeddings on %s until its API shape is verified",
    (provider) => {
      for (const path of [["embeddings"], ["v1", "embeddings"]]) {
        expect(endpointAllows(provider as ProviderId, "POST", path)).toBe(false);
        expect(isEmbeddingsEndpoint(provider as ProviderId, "POST", path)).toBe(false);
      }
    }
  );

  // Together's embeddings response carries no usage at all: its OpenAPI schema
  // (docs.together.ai/reference/embeddings.md) and both SDKs' response types
  // (together-python, together-py), read 2026-09-27, have only object/model/data.
  // Every call would settle as usage_unknown and be charged a characters ÷ 4
  // guess, which can be BELOW the real bill, so a cap would not bound it.
  it("denies Together embeddings: the response reports no usage to settle on", () => {
    expect(endpointAllows("together", "POST", ["v1", "embeddings"])).toBe(false);
    expect(advertisedClientPath("together", "embeddings")).toBeNull();
  });

  it("does not call inference or discovery an embeddings call", () => {
    expect(isEmbeddingsEndpoint("openai", "POST", ["v1", "chat", "completions"])).toBe(false);
    expect(isEmbeddingsEndpoint("openai", "POST", ["v1", "responses"])).toBe(false);
    expect(isEmbeddingsEndpoint("openai", "GET", ["v1", "models"])).toBe(false);
  });
});

describe("advertised paths", () => {
  it.each(SERVES_EMBEDDINGS)(
    "still advertises chat completions, not the shorter embeddings path, as %s's chat base",
    (provider) => {
      expect(advertisedClientPath(provider, "chat")).toEqual(["chat", "completions"]);
      expect(advertisedClientPath(provider, "models")).toEqual(["models"]);
    }
  );

  it("advertises an embeddings path only where one is served", () => {
    for (const provider of SERVES_EMBEDDINGS) {
      expect(advertisedClientPath(provider, "embeddings")).toEqual(["embeddings"]);
    }
    for (const provider of PROVIDERS.filter((p) => !SERVES_EMBEDDINGS.includes(p))) {
      expect(advertisedClientPath(provider as ProviderId, "embeddings")).toBeNull();
    }
  });

  it("names no chat provider as an alternative to a failed embeddings call", () => {
    const alternatives = buildAlternatives({
      scopes: [
        { provider: "openai", models: ["text-embedding-*"] },
        { provider: "groq", models: ["llama-*"] },
        { provider: "anthropic", models: ["claude-*"] },
      ],
      providersWithKeys: ["openai", "groq", "anthropic"],
      failing: "openai",
      method: "POST",
      path: ["v1", "embeddings"],
    });
    expect(alternatives).toEqual([]);
  });

  // An alternative is offered as a base-URL swap. For embeddings a swap changes
  // the model, and vectors from another model do not belong in the same index,
  // so no provider is named — not even one that embeds.
  it("names no alternative to a failed embeddings call, even a provider that embeds", () => {
    const alternatives = buildAlternatives({
      scopes: [
        { provider: "openai", models: ["text-embedding-*"] },
        { provider: "mistral", models: ["mistral-embed*"] },
      ],
      providersWithKeys: ["openai", "mistral"],
      failing: "openai",
      method: "POST",
      path: ["v1", "embeddings"],
    });
    expect(alternatives).toEqual([]);
  });
});

const MONDAY_MORNING = new Date("2026-07-27T10:00:00.000Z");

function embeddingsInput(overrides: Partial<GateInput> = {}): GateInput {
  return {
    agentId: "agent-a",
    killState: { platformKill: false, userKill: false, denylist: [] },
    suspended: false,
    scopes: [{ provider: "openai", models: ["text-embedding-*"] }],
    provider: "openai",
    method: "POST",
    path: ["v1", "embeddings"],
    model: "text-embedding-3-small",
    policy: { kind: "value", value: { max_output_tokens: 30 } },
    policyFailClosed: false,
    now: MONDAY_MORNING,
    // What the proxy computes for an embeddings body: no output field at all.
    requestedOutput: { kind: "absent" },
    ...overrides,
  };
}

describe("the output ceiling (K2) and embeddings", () => {
  it("exempts an embeddings call, which generates no output", () => {
    const result = evaluateGate(embeddingsInput());
    expect(result.deniedBy).toBeUndefined();
    expect(result.steps.find((s) => s.name === "policy")?.status).toBe("pass");
  });

  it("still refuses a chat call with no stated limit under the same policy", () => {
    const result = evaluateGate(
      embeddingsInput({
        path: ["v1", "chat", "completions"],
        model: "text-embedding-3-small",
      })
    );
    expect(result.deniedBy).toBe("policy");
    expect(result.steps.find((s) => s.name === "policy")?.rule).toBe("max_output_tokens:missing");
  });

  it("exempts a Mistral embeddings call the same way", () => {
    const result = evaluateGate(
      embeddingsInput({
        provider: "mistral",
        scopes: [{ provider: "mistral", models: ["mistral-embed*"] }],
        model: "mistral-embed",
      })
    );
    expect(result.deniedBy).toBeUndefined();
    expect(result.steps.find((s) => s.name === "policy")?.status).toBe("pass");
  });

  it("does not exempt the same path on a provider that does not serve it", () => {
    const result = evaluateGate(
      embeddingsInput({ provider: "groq", scopes: [{ provider: "groq", models: ["*"] }] })
    );
    expect(result.deniedBy).toBe("endpoint");
  });

  it("keeps the other policy rules: a deny rule still refuses an embeddings model", () => {
    const result = evaluateGate(
      embeddingsInput({
        policy: {
          kind: "value",
          value: { max_output_tokens: 30, deny: [{ provider: "openai", models: ["text-embedding-3-large"] }] },
        },
        model: "text-embedding-3-large",
      })
    );
    expect(result.deniedBy).toBe("policy");
  });
});

describe("embedding prices", () => {
  // developers.openai.com/api/docs/pricing, read 2026-09-27: text-embedding-3-small
  // $0.02, text-embedding-3-large $0.13, text-embedding-ada-002 $0.10 per 1M tokens.
  it.each([
    ["text-embedding-3-small", 2_000_000],
    ["text-embedding-3-large", 13_000_000],
    ["text-embedding-ada-002", 10_000_000],
  ])("prices %s at OpenAI's published rate", (model, microcentsPerMillion) => {
    expect(costMicrocents(model, 1_000_000, 0, "openai")).toBe(microcentsPerMillion);
  });

  // mistral.ai/pricing/api, read 2026-09-27: Mistral Embed $0.1 and Codestral
  // Embed $0.15 per 1M input tokens; the Codestral Embed launch post names the
  // API model `codestral-embed-2505`. Model ids per docs.mistral.ai models
  // overview: `mistral-embed-23-12`, `codestral-embed-25-05`.
  it.each([
    ["mistral-embed", 10_000_000],
    ["mistral-embed-23-12", 10_000_000],
    ["mistral-embed-2312", 10_000_000],
    ["codestral-embed", 15_000_000],
    ["codestral-embed-2505", 15_000_000],
    ["codestral-embed-25-05", 15_000_000],
  ])("prices %s at Mistral's published rate", (model, microcentsPerMillion) => {
    expect(costMicrocents(model, 1_000_000, 0, "mistral")).toBe(microcentsPerMillion);
  });

  it("does not lower what an unknown Mistral model is reserved at", () => {
    // The fallback is the provider's maximum per dimension; the cheap embedding
    // rows must not pull it down below any chat model's rate.
    const unknown = costMicrocents("some-new-model", 1_000_000, 1_000, "mistral");
    for (const chat of ["mistral-medium-latest", "magistral-medium-latest", "open-mixtral-8x22b"]) {
      expect(unknown).toBeGreaterThanOrEqual(costMicrocents(chat, 1_000_000, 1_000, "mistral"));
    }
    // The chat rows keep their rates: `codestral-latest` is not an embedding model.
    expect(costMicrocents("codestral-latest", 1_000_000, 0, "mistral")).toBe(30_000_000);
  });

  it("does not lower what an unknown OpenAI model is reserved at", () => {
    expect(costMicrocents("some-new-model", 1_000_000, 0, "openai")).toBeGreaterThanOrEqual(
      costMicrocents("gpt-4o", 1_000_000, 0, "openai")
    );
  });
});
