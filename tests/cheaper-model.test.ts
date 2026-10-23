import { describe, expect, it } from "vitest";

import { CHEAPER_MODELS, suggestCheaperModel, switchModelProblem } from "@/lib/cheaper-model";
import { hasListedPrice } from "@/lib/pricing";
import { isProvider } from "@/lib/providers";

// L7 (1.6.0): at the pause line an agent can go on with a cheaper model. The editor
// suggests one (owner, 2026-10-22: "we do l7 on ur decision"); the owner can type
// another. The switch never widens what the agent may call.
describe("suggestCheaperModel", () => {
  it("suggests the provider's small model when the scope allows it", () => {
    expect(suggestCheaperModel([{ provider: "anthropic", models: ["claude-*"] }])).toEqual({
      provider: "anthropic",
      model: CHEAPER_MODELS.anthropic![0],
    });
    expect(suggestCheaperModel([{ provider: "openai", models: ["gpt-5*"] }])).toEqual({ provider: "openai", model: "gpt-5-mini" });
  });

  it("suggests nothing the scope does not already allow", () => {
    expect(suggestCheaperModel([{ provider: "anthropic", models: ["claude-sonnet-*"] }])).toBeNull();
    expect(suggestCheaperModel([])).toBeNull();
  });

  it("only suggests models PassControl has a price for, so the hold can price the switch", () => {
    for (const [provider, models] of Object.entries(CHEAPER_MODELS)) {
      expect(isProvider(provider)).toBe(true);
      for (const model of models ?? []) expect(hasListedPrice(model, provider as never), `${provider}/${model}`).toBe(true);
    }
  });
});

describe("switchModelProblem", () => {
  const scopes = [{ provider: "openai", models: ["gpt-5", "gpt-5-mini"] }];

  it("accepts a model in the agent's scope", () => {
    expect(switchModelProblem(scopes, { provider: "openai", model: "gpt-5-mini" })).toBeNull();
  });

  it("refuses a model outside the agent's scope", () => {
    expect(switchModelProblem(scopes, { provider: "openai", model: "gpt-4o-mini" })).toMatch(/not in this agent's scope/);
  });

  it("refuses a provider the agent cannot call: an OpenAI agent switched to a Claude model", () => {
    expect(switchModelProblem(scopes, { provider: "anthropic", model: "claude-haiku-4-5" })).toMatch(/not in this agent's scope/);
  });
});
