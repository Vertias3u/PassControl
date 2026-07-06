// Scope matching for visas. Provider must match exactly; model is matched
// against patterns that may contain a trailing/embedded `*` wildcard.
import type { ScopeEntry } from "./auth/visa";
import type { ProviderId } from "./providers";

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

// Deny-by-default endpoint allowlist. Method-aware and exact-segment-match (no
// prefix matching), so a scoped visa can only reach the specific known-good
// endpoints — never the full capability of the injected provider key
// (/v1/files, /v1/fine_tuning, /v1/batches, …). Chat is POST-only; the
// read-only model-listing endpoint is GET-only.
interface EndpointRule {
  readonly method: string;
  readonly path: readonly string[];
}
const ENDPOINT_ALLOWLIST: Record<ProviderId, readonly EndpointRule[]> = {
  openai: [
    { method: "POST", path: ["v1", "chat", "completions"] },
    { method: "GET", path: ["v1", "models"] },
  ],
  anthropic: [
    { method: "POST", path: ["v1", "messages"] },
    { method: "GET", path: ["v1", "models"] },
  ],
};

/** True if this (method, path) is one of the fixed, known-good endpoints. */
export function endpointAllows(
  provider: ProviderId,
  method: string,
  path: readonly string[]
): boolean {
  const m = method.toUpperCase();
  return (ENDPOINT_ALLOWLIST[provider] ?? []).some(
    (rule) =>
      rule.method === m &&
      rule.path.length === path.length &&
      rule.path.every((seg, i) => seg === path[i])
  );
}

/** The model-listing endpoint (GET /v1/models) carries no model, so the
 *  per-model scope check does not apply to it — it is gated by the endpoint
 *  allowlist (GET-only) instead. */
export function isModelListing(path: readonly string[]): boolean {
  return path.length === 2 && path[0] === "v1" && path[1] === "models";
}
