// Scope matching for visas. Provider must match exactly; model is matched
// against patterns that may contain a trailing/embedded `*` wildcard.
import type { ScopeEntry } from "./auth/visa";
import type { ProviderId } from "./providers";

// Real model identifiers are short. Bound the input fed to RegExp.test so a
// pathologically long attacker-supplied model string can't drive regex work
// (defense-in-depth against ReDoS — the glob→`.*` translation is already
// linear, but we never want to evaluate a regex over unbounded input).
const MAX_MODEL_LEN = 200;
const MAX_PROVIDER_LEN = 50;
const POLICY_KEYS = new Set(["deny", "windows", "max_requests_per_hour"]);
const UTC_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const UTC_DAY_SET = new Set<string>(UTC_DAYS);
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function modelMatches(pattern: string, model: string): boolean {
  if (model.length > MAX_MODEL_LEN) return false;
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === model;
  // Translate glob -> anchored regex, escaping regex metachars except `*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(model);
}

export interface ScopeRuleMatch {
  provider: string;
  pattern: string;
}

/** The exact scope rule permitting a provider+model, or null when denied. */
export function scopeRuleMatch(
  scopes: readonly ScopeEntry[],
  provider: string,
  model: string
): ScopeRuleMatch | null {
  if (typeof model !== "string" || model.length > MAX_MODEL_LEN) return null;
  for (const scope of scopes) {
    if (scope.provider !== provider) continue;
    const pattern = scope.models.find((candidate) => modelMatches(candidate, model));
    if (pattern) return { provider: scope.provider, pattern };
  }
  return null;
}

/** True if the requested provider+model is permitted by any scope entry. */
export function scopeAllows(scopes: ScopeEntry[], provider: string, model: string): boolean {
  return scopeRuleMatch(scopes, provider, model) !== null;
}

export type AgentPolicyBlockReason = "deny" | "window" | "malformed";

export type AgentPolicyDecision =
  | { allowed: true; maxRequestsPerHour: number | null }
  | { allowed: false; reason: AgentPolicyBlockReason; rule: string };

interface DenyRule {
  provider: string;
  models: string[];
}

interface TimeWindow {
  days: string[];
  start: string;
  end: string;
  tz: "UTC";
}

interface AgentPolicy {
  deny: DenyRule[];
  windows: TimeWindow[];
  maxRequestsPerHour: number | null;
}

export interface AgentPolicyView {
  configured: boolean;
  valid: boolean;
  deny: DenyRule[];
  windows: TimeWindow[];
  maxRequestsPerHour: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPattern(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_MODEL_LEN;
}

function parsePolicy(value: unknown): AgentPolicy | null {
  // Existing rows and pre-policy visas must preserve the legacy path exactly.
  if (value === null) return { deny: [], windows: [], maxRequestsPerHour: null };
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !POLICY_KEYS.has(key))) return null;

  const deny: DenyRule[] = [];
  if ("deny" in value) {
    if (!Array.isArray(value.deny)) return null;
    for (const candidate of value.deny) {
      if (!isRecord(candidate)) return null;
      if (Object.keys(candidate).some((key) => key !== "provider" && key !== "models")) {
        return null;
      }
      if (
        typeof candidate.provider !== "string" ||
        candidate.provider.length === 0 ||
        candidate.provider.length > MAX_PROVIDER_LEN ||
        !Array.isArray(candidate.models) ||
        !candidate.models.every(validPattern)
      ) {
        return null;
      }
      deny.push({ provider: candidate.provider, models: [...candidate.models] });
    }
  }

  const windows: TimeWindow[] = [];
  if ("windows" in value) {
    if (!Array.isArray(value.windows)) return null;
    for (const candidate of value.windows) {
      if (!isRecord(candidate)) return null;
      if (
        Object.keys(candidate).some(
          (key) => key !== "days" && key !== "start" && key !== "end" && key !== "tz"
        )
      ) {
        return null;
      }
      if (
        !Array.isArray(candidate.days) ||
        candidate.days.length === 0 ||
        !candidate.days.every((day): day is string => typeof day === "string" && UTC_DAY_SET.has(day)) ||
        typeof candidate.start !== "string" ||
        typeof candidate.end !== "string" ||
        !TIME_RE.test(candidate.start) ||
        !TIME_RE.test(candidate.end) ||
        candidate.start >= candidate.end ||
        candidate.tz !== "UTC"
      ) {
        return null;
      }
      windows.push({
        days: [...candidate.days],
        start: candidate.start,
        end: candidate.end,
        tz: "UTC",
      });
    }
  }

  let maxRequestsPerHour: number | null = null;
  if ("max_requests_per_hour" in value) {
    if (
      typeof value.max_requests_per_hour !== "number" ||
      !Number.isSafeInteger(value.max_requests_per_hour) ||
      value.max_requests_per_hour <= 0
    ) {
      return null;
    }
    maxRequestsPerHour = value.max_requests_per_hour;
  }

  return { deny, windows, maxRequestsPerHour };
}

/** Validated, non-editable representation for owner-facing policy summaries. */
export function agentPolicyForDisplay(value: unknown): AgentPolicyView {
  const configured = value !== null && (!isRecord(value) || Object.keys(value).length > 0);
  const policy = parsePolicy(value);
  if (!policy) {
    return {
      configured,
      valid: false,
      deny: [],
      windows: [],
      maxRequestsPerHour: null,
    };
  }
  return {
    configured,
    valid: true,
    deny: policy.deny.map((rule) => ({ ...rule, models: [...rule.models] })),
    windows: policy.windows.map((window) => ({ ...window, days: [...window.days] })),
    maxRequestsPerHour: policy.maxRequestsPerHour,
  };
}

function utcMinuteOfDay(now: Date): number {
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

function timeToMinute(value: string): number {
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

/**
 * Evaluate current per-agent policy after scope and endpoint checks. UTC is the
 * only accepted timezone for now; malformed or unsupported policy fails closed.
 * The clock is injectable so window decisions are deterministic in tests.
 */
export function evaluateAgentPolicy(
  value: unknown,
  provider: string,
  model: string,
  now: Date = new Date()
): AgentPolicyDecision {
  const policy = parsePolicy(value);
  if (!policy || !Number.isFinite(now.getTime())) {
    return { allowed: false, reason: "malformed", rule: "policy:malformed" };
  }

  // Deny precedes every other policy control and therefore always wins.
  if (model) {
    for (const [index, rule] of policy.deny.entries()) {
      if (rule.provider !== provider) continue;
      const pattern = rule.models.find((candidate) => modelMatches(candidate, model));
      if (pattern) {
        return {
          allowed: false,
          reason: "deny",
          rule: `deny[${index}]:${rule.provider}:${pattern}`,
        };
      }
    }
  }

  if (policy.windows.length > 0) {
    const day = UTC_DAYS[now.getUTCDay()] ?? "";
    const minute = utcMinuteOfDay(now);
    const inWindow = policy.windows.some(
      (window) =>
        window.days.includes(day) &&
        minute >= timeToMinute(window.start) &&
        minute < timeToMinute(window.end)
    );
    if (!inWindow) {
      return { allowed: false, reason: "window", rule: "windows:no_match" };
    }
  }

  return { allowed: true, maxRequestsPerHour: policy.maxRequestsPerHour };
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
    // Deepseek's upstream serves chat at /chat/completions, not /v1/chat/completions
    // — but a client can't know that. Anything configured with a host-style base
    // URL sends "v1/chat/completions", so accept it and normalise to the real
    // upstream path. Without this row deepseek was the only OpenAI-shape provider
    // that rejected that spelling.
    { method: "POST", path: OPENAI_CHAT_PATH, upstreamPath: DEEPSEEK_CHAT_PATH },
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
