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
  readonly upstreamPath: readonly string[];
}

const OPENAI_CHAT_PATH = ["v1", "chat", "completions"] as const;
const OPENAI_MODELS_PATH = ["v1", "models"] as const;
const ANTHROPIC_MESSAGES_PATH = ["v1", "messages"] as const;
const DEEPSEEK_CHAT_PATH = ["chat", "completions"] as const;

const ENDPOINT_ALLOWLIST: Record<ProviderId, readonly EndpointRule[]> = {
  openai: [
    { method: "POST", path: ["chat", "completions"], upstreamPath: OPENAI_CHAT_PATH },
    { method: "POST", path: OPENAI_CHAT_PATH, upstreamPath: OPENAI_CHAT_PATH },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH },
  ],
  anthropic: [
    { method: "POST", path: ANTHROPIC_MESSAGES_PATH, upstreamPath: ANTHROPIC_MESSAGES_PATH },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH },
  ],
  groq: [
    { method: "POST", path: ["chat", "completions"], upstreamPath: OPENAI_CHAT_PATH },
    { method: "POST", path: OPENAI_CHAT_PATH, upstreamPath: OPENAI_CHAT_PATH },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH },
  ],
  mistral: [
    { method: "POST", path: ["chat", "completions"], upstreamPath: OPENAI_CHAT_PATH },
    { method: "POST", path: OPENAI_CHAT_PATH, upstreamPath: OPENAI_CHAT_PATH },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH },
  ],
  together: [
    { method: "POST", path: ["chat", "completions"], upstreamPath: OPENAI_CHAT_PATH },
    { method: "POST", path: OPENAI_CHAT_PATH, upstreamPath: OPENAI_CHAT_PATH },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH },
  ],
  deepseek: [
    { method: "POST", path: DEEPSEEK_CHAT_PATH, upstreamPath: DEEPSEEK_CHAT_PATH },
  ],
};

function pathEquals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

function endpointRuleFor(
  provider: ProviderId,
  method: string,
  path: readonly string[]
): EndpointRule | null {
  const m = method.toUpperCase();
  return ENDPOINT_ALLOWLIST[provider].find((rule) => rule.method === m && pathEquals(rule.path, path)) ?? null;
}

/** True if this (method, path) is one of the fixed, known-good endpoints. */
export function endpointAllows(
  provider: ProviderId,
  method: string,
  path: readonly string[]
): boolean {
  return endpointRuleFor(provider, method, path) !== null;
}

/** Canonical upstream endpoint path for an allowed client path, or null if denied. */
export function canonicalEndpointPath(
  provider: ProviderId,
  method: string,
  path: readonly string[]
): readonly string[] | null {
  return endpointRuleFor(provider, method, path)?.upstreamPath ?? null;
}

/** The model-listing endpoints (GET /models or /v1/models) carry no model, so the
 *  per-model scope check does not apply to it — it is gated by the endpoint
 *  allowlist (GET-only) instead. */
export function isModelListing(path: readonly string[]): boolean {
  return (path.length === 1 && path[0] === "models") || pathEquals(path, OPENAI_MODELS_PATH);
}
