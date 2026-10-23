// The cheaper model an agent goes on with at its pause line (1.6.0, L7, 0088).
//
// The switch never widens what the agent may call: the model must already be in
// its scope, checked here when the owner saves it and by the gateway on every
// switched call (the scope can be narrowed after the switch was saved). Shared by
// the editor's suggestion and the save path, so the two cannot disagree.
import type { ScopeEntry } from "./auth/visa";
import { hasListedPrice } from "./pricing";
import { isProvider } from "./providers";
import { scopeAllows } from "./scope";

/**
 * Per provider, the small models the editor suggests, best first. Each has a row
 * in lib/pricing.ts, so the hold prices the switched call (tested).
 */
export const CHEAPER_MODELS: Readonly<Partial<Record<string, readonly string[]>>> = {
  anthropic: ["claude-haiku-4-5", "claude-haiku-5-5"],
  openai: ["gpt-5-mini", "gpt-5.4-mini", "gpt-4.1-mini", "gpt-4o-mini"],
};

export interface SwitchModel {
  provider: string;
  model: string;
}

/** The first suggested model the agent's scope already allows, or null. */
export function suggestCheaperModel(scopes: readonly ScopeEntry[]): SwitchModel | null {
  for (const scope of scopes) {
    for (const model of CHEAPER_MODELS[scope.provider] ?? []) {
      if (scopeAllows([...scopes], scope.provider, model)) return { provider: scope.provider, model };
    }
  }
  return null;
}

/** Why this switch cannot be saved for an agent with these scopes, or null when it can. */
export function switchModelProblem(scopes: readonly ScopeEntry[], to: SwitchModel): string | null {
  if (!isProvider(to.provider) || !scopeAllows([...scopes], to.provider, to.model)) {
    return `${to.provider}/${to.model} is not in this agent's scope. The cheaper model must be one the agent may already call; widen its scope first if you mean it.`;
  }
  if (!hasListedPrice(to.model, to.provider)) {
    return `PassControl has no price for ${to.provider}/${to.model}, so a dollar limit could not hold it. Pick a listed model.`;
  }
  return null;
}
