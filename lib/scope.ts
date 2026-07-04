// Scope matching for visas. Provider must match exactly; model is matched
// against patterns that may contain a trailing/embedded `*` wildcard.
import type { ScopeEntry } from "./auth/visa";

// Real model identifiers are short. Bound the input fed to RegExp.test so a
// pathologically long attacker-supplied model string can't drive regex work
// (defense-in-depth against ReDoS — the glob→`.*` translation is already
// linear, but we never want to evaluate a regex over unbounded input).
const MAX_MODEL_LEN = 200;

function modelMatches(pattern: string, model: string): boolean {
  if (model.length > MAX_MODEL_LEN) return false;
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === model;
  // Translate glob -> anchored regex, escaping regex metachars except `*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(model);
}

/** True if the requested provider+model is permitted by any scope entry. */
export function scopeAllows(scopes: ScopeEntry[], provider: string, model: string): boolean {
  if (typeof model !== "string" || model.length > MAX_MODEL_LEN) return false;
  return scopes.some(
    (s) => s.provider === provider && s.models.some((m) => modelMatches(m, model))
  );
}
