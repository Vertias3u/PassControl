// Scope matching for visas. Provider must match exactly; model is matched
// against patterns that may contain a trailing/embedded `*` wildcard.
import type { ScopeEntry } from "./auth/visa";
import type { ProviderId } from "./providers";
import type { RequestedOutput } from "./output-limit";

// Real model identifiers are short. Bound both sides of a match: the model
// comes from the request body and the pattern comes from a jsonb column a
// tenant can PATCH directly, so neither is trusted input.
const MAX_MODEL_LEN = 200;
const MAX_PROVIDER_LEN = 50;
// A real model glob has one wildcard, occasionally two ("claude-3-*-sonnet*").
// Beyond a handful it is not a policy, it is a payload — see the comment on
// globMatchWork. Patterns over this are refused, which is fail-CLOSED on both
// sides: a scope entry that never matches denies, and a deny rule that trips
// this makes the whole document malformed, which also denies.
const MAX_WILDCARDS = 4;
const POLICY_KEYS = new Set(["deny", "windows", "max_requests_per_hour", "max_output_tokens", "subagent_models", "secret_guard"]);
// Exported for the policy editor, which must offer exactly the days the parser
// accepts. Retyping them there is how the form ends up letting an operator save
// a window the gateway reads as malformed — the failure mode validateFallbacks
// documents at length, one column over.
export const POLICY_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const UTC_DAY_SET = new Set<string>(POLICY_DAYS);
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * `.` in a regular expression does not cross a line terminator, and this matcher
 * replaces one, so its wildcard must not either.
 *
 * That is a strange rule for a glob, and it is kept deliberately: model
 * identifiers contain none of these characters, and a wildcard that matched MORE
 * than the regex it replaced would widen `allowed_scopes`, which is an
 * allow-list. Widening an allow-list is the one direction of change a matcher
 * rewrite is not allowed to make. tests/scope-glob.test.ts pins it against the
 * old implementation directly.
 */
const LINE_TERMINATORS = new Set(["\n", "\r", "\u2028", "\u2029"]);

export interface GlobMatchWork {
  matched: boolean;
  /** Loop iterations spent. Exported so a test can bound the work, not the clock. */
  steps: number;
}

/**
 * Glob match with a provable ceiling on the work it can do.
 *
 * ── Why this is not a regular expression any more ───────────────────────────
 *
 * This used to translate the glob to `^…$` with every `*` becoming `.*` and hand
 * it to RegExp.test. That is correct and it is also a stall: a pattern of
 * embedded wildcards (`a*a*a*…b`) against a model of repeated `a` makes V8's
 * backtracking engine explore every way of splitting the model between the
 * wildcards. Measured on this checkout: 12 wildcards took 36ms, 15 took 2.8s,
 * and each added wildcard roughly quadruples it.
 *
 * That cost lands SYNCHRONOUSLY on the credential path — `evaluateAgentPolicy`
 * runs in the proxy before the provider key is resolved — and a policy document
 * is attacker-reachable (a server action is addressable by its id, and the
 * column is writable by SQL). No `try`/`catch` and no timeout can rescue a held
 * event loop, so the fix has to be that the work cannot happen, not that it is
 * caught.
 *
 * ── The ceiling ─────────────────────────────────────────────────────────────
 *
 * Greedy two-pointer with a single backtrack point, the standard wildcard-match
 * algorithm. Every iteration does exactly one of three things: consume a `*`
 * (advances p), match a character (advances p and m), or backtrack (advances
 * `starM`, which never decreases). So backtracks ≤ |model|, and each run between
 * backtracks advances p at most |pattern| times:
 *
 *     steps ≤ (|model| + 1) × (|pattern| + 1) ≤ 201 × 201 = 40,401
 *
 * — no exponent anywhere. Both lengths are bounded above, and the number of
 * patterns a policy may carry is bounded in parsePolicy, so the per-request
 * total is bounded too. tests/policy-bounds.test.ts asserts that product.
 */
export function globMatchWork(pattern: string, model: string): GlobMatchWork {
  let p = 0;
  let m = 0;
  let starP = -1;
  let starM = 0;
  let steps = 0;
  while (m < model.length) {
    steps++;
    const pc = p < pattern.length ? pattern[p] : undefined;
    if (pc === "*") {
      starP = p;
      starM = m;
      p++;
    } else if (pc !== undefined && pc === model[m]) {
      p++;
      m++;
    } else if (starP >= 0 && !LINE_TERMINATORS.has(model[starM] as string)) {
      // Extend the last wildcard by exactly one character — the one at starM,
      // which is why the line-terminator test reads there and not at m.
      p = starP + 1;
      m = ++starM;
    } else {
      return { matched: false, steps };
    }
  }
  while (p < pattern.length && pattern[p] === "*") {
    steps++;
    p++;
  }
  return { matched: p === pattern.length, steps };
}

/** Count wildcards without allocating — called per candidate on the hot path. */
function wildcardCount(pattern: string): number {
  let n = 0;
  for (let i = 0; i < pattern.length; i++) if (pattern[i] === "*") n++;
  return n;
}

/**
 * Is this a pattern the matcher will evaluate at all?
 *
 * Exported because the scope validator must refuse exactly what the matcher
 * refuses. A pattern that saves but can never match is worse than a rejected
 * one: the operator believes the model is scoped and every call 403s.
 */
export function modelPatternIsUsable(pattern: string): boolean {
  return pattern.length > 0 && patternIsBounded(pattern);
}

/** The matcher's own bound. Separate from the validator's because an empty
 *  pattern is refused at every form but is still MATCHED the legacy way (it
 *  equals only the empty model) if one is already sitting in a jsonb column —
 *  the rewrite does not get to change that by accident. */
function patternIsBounded(pattern: string): boolean {
  return pattern.length <= MAX_MODEL_LEN && wildcardCount(pattern) <= MAX_WILDCARDS;
}

function modelMatches(pattern: string, model: string): boolean {
  if (model.length > MAX_MODEL_LEN) return false;
  if (pattern === "*") return true;
  // Fail closed on anything outside the bound rather than evaluating it. Scope
  // patterns reach here from a jsonb column, so the bound cannot live only in
  // the validator.
  if (!patternIsBounded(pattern)) return false;
  if (!pattern.includes("*")) return pattern === model;
  return globMatchWork(pattern, model).matched;
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

export type AgentPolicyBlockReason = "deny" | "window" | "malformed" | "output_limit";

export type AgentPolicyDecision =
  | { allowed: true; maxRequestsPerHour: number | null }
  | {
      allowed: false;
      reason: AgentPolicyBlockReason;
      rule: string;
      /** The configured ceiling, on an `output_limit` refusal only. */
      limit?: number;
    };

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
  maxOutputTokens: number | null;
  /**
   * `subagent_models`: the models a DECLARED sub-agent may call (sprint C(a)).
   * null = the key is absent, no restriction; [] = sub-agents may call nothing.
   * Enforced at the gate's scope step, never here: see subagentAllowlist.
   */
  subagentModels: ScopeEntry[] | null;
  /**
   * `secret_guard: { mode }` (2026-10-08): what the proxy does with a key found in a
   * request (lib/secret-guard.ts). null = absent, the guard is off.
   */
  secretGuard: SecretGuardMode | null;
}

export type SecretGuardMode = "block" | "redact";

export interface AgentPolicyView {
  configured: boolean;
  valid: boolean;
  deny: DenyRule[];
  windows: TimeWindow[];
  maxRequestsPerHour: number | null;
  maxOutputTokens: number | null;
  subagentModels: ScopeEntry[] | null;
  secretGuard: SecretGuardMode | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPattern(value: unknown): value is string {
  return typeof value === "string" && modelPatternIsUsable(value);
}

/**
 * How big a policy document the gateway will read.
 *
 * ── Why these are here and not in the form ──────────────────────────────────
 *
 * They were in the form: `PolicyShadowPanel` stops at 10 deny rules and 6
 * windows, and nothing else stopped anything. A form is not a boundary — a
 * server action is addressable over HTTP by its id, and both policy columns are
 * jsonb besides — so a document with tens of thousands of patterns could be
 * stored, and then walked in full by `evaluateAgentPolicy` on EVERY proxied
 * request, before the provider key is resolved. Bounds that only exist in the UI
 * bound nothing.
 *
 * ── Why these numbers ───────────────────────────────────────────────────────
 *
 * `denyPatterns` is the load-bearing one: it, not the per-rule cap, is what
 * multiplies against the matcher's per-pattern ceiling to give the worst case
 * the proxy can be made to do in one request — 100 × 40,401 ≈ 4×10⁶ character
 * comparisons. Measured rather than assumed: the nastiest pattern an adversarial
 * search finds costs ~10⁴ steps, so a full budget of them is ~10⁶ steps and
 * ~16 ms of held event loop, against 2.8 SECONDS for ONE pattern before this
 * change. A pattern an operator actually writes costs ~200 steps, so a real
 * policy is microseconds. tests/policy-bounds.test.ts asserts the product from
 * these constants, so raising one of them fails a test rather than quietly
 * restoring the stall.
 *
 * The others are set generously ABOVE what the form allows rather than at it.
 * Tightening a READ boundary is retroactive: a document that parses today and
 * does not parse after a deploy is read as `policy:malformed`, which for the
 * live column denies every call for that agent. Deny rules and windows have form
 * caps (10 and 6) to sit above; models-per-rule never had one — it is a
 * comma-separated text field — so that cap is the one deliberately far from any
 * plausible hand-entered list.
 *
 * These also imply the serialized-size ceiling without anyone measuring one —
 * every field is counted, `days` included: 100 patterns × 200 chars + 25
 * providers × 50 + 25 windows × (7 days + two times) ≈ 25 KB. A
 * JSON.stringify length check would have cost a full pass over an
 * attacker-sized document on the credential path to learn what the counts
 * already prove, so there isn't one.
 */
export const POLICY_LIMITS = {
  denyRules: 25,
  modelsPerRule: 100,
  /**
   * Total patterns across all deny rules AND the sub-agent allowlist. The bound
   * that actually matters. Shared rather than one budget each, so adding the
   * allowlist left the per-request worst case where tests/policy-bounds.test.ts
   * measured it; no existing document carries the new key, so sharing tightens
   * nothing retroactively.
   */
  denyPatterns: 100,
  windows: 25,
  /** There are seven days. Longer means duplicates, and duplicates are a payload. */
  daysPerWindow: POLICY_DAYS.length,
  /** Both sides of a match. Part of the product the bound test asserts, so it
   *  belongs with the other limits rather than alone further up the file. */
  patternLen: MAX_MODEL_LEN,
  modelLen: MAX_MODEL_LEN,
  /**
   * The largest `max_output_tokens` ceiling the reader accepts. Far above any
   * model's real output limit on purpose — this is a read boundary, and
   * tightening one is retroactive (see above) — while still refusing a value
   * that is not a plausible token count.
   */
  maxOutputTokens: 10_000_000,
} as const;

function parsePolicy(value: unknown): AgentPolicy | null {
  // Existing rows and pre-policy visas must preserve the legacy path exactly.
  if (value === null) {
    return { deny: [], windows: [], maxRequestsPerHour: null, maxOutputTokens: null, subagentModels: null, secretGuard: null };
  }
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !POLICY_KEYS.has(key))) return null;

  const deny: DenyRule[] = [];
  // One budget for every pattern in the document: deny rules and sub-agent allowlist.
  let patterns = 0;
  if ("deny" in value) {
    if (!Array.isArray(value.deny)) return null;
    // Length first: rejecting a million-entry array must not cost a million
    // iterations, which is the shape of the problem being fixed.
    if (value.deny.length > POLICY_LIMITS.denyRules) return null;
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
        candidate.models.length > POLICY_LIMITS.modelsPerRule ||
        !candidate.models.every(validPattern)
      ) {
        return null;
      }
      patterns += candidate.models.length;
      if (patterns > POLICY_LIMITS.denyPatterns) return null;
      deny.push({ provider: candidate.provider, models: [...candidate.models] });
    }
  }

  const windows: TimeWindow[] = [];
  if ("windows" in value) {
    if (!Array.isArray(value.windows)) return null;
    if (value.windows.length > POLICY_LIMITS.windows) return null;
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
        // Before `.every()`, and before the spread below copies it. There are
        // seven days; anything longer is duplicates, and a million duplicates
        // would be walked twice and ALLOCATED once on every proxied request.
        candidate.days.length > POLICY_LIMITS.daysPerWindow ||
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

  let maxOutputTokens: number | null = null;
  if ("max_output_tokens" in value) {
    if (
      typeof value.max_output_tokens !== "number" ||
      !Number.isSafeInteger(value.max_output_tokens) ||
      value.max_output_tokens <= 0 ||
      value.max_output_tokens > POLICY_LIMITS.maxOutputTokens
    ) {
      return null;
    }
    maxOutputTokens = value.max_output_tokens;
  }

  // Same entry shape and bounds as a deny rule, and the same pattern budget.
  let subagentModels: ScopeEntry[] | null = null;
  if ("subagent_models" in value) {
    if (!Array.isArray(value.subagent_models)) return null;
    if (value.subagent_models.length > POLICY_LIMITS.denyRules) return null;
    subagentModels = [];
    for (const candidate of value.subagent_models) {
      if (!isRecord(candidate)) return null;
      if (Object.keys(candidate).some((key) => key !== "provider" && key !== "models")) return null;
      if (
        typeof candidate.provider !== "string" ||
        candidate.provider.length === 0 ||
        candidate.provider.length > MAX_PROVIDER_LEN ||
        !Array.isArray(candidate.models) ||
        candidate.models.length > POLICY_LIMITS.modelsPerRule ||
        !candidate.models.every(validPattern)
      ) {
        return null;
      }
      patterns += candidate.models.length;
      if (patterns > POLICY_LIMITS.denyPatterns) return null;
      subagentModels.push({ provider: candidate.provider, models: [...candidate.models] });
    }
  }

  // An object with exactly one key, so v2 can add fields without a format change.
  let secretGuard: SecretGuardMode | null = null;
  if ("secret_guard" in value) {
    const guard = value.secret_guard;
    if (!isRecord(guard) || Object.keys(guard).length !== 1 || (guard.mode !== "block" && guard.mode !== "redact")) {
      return null;
    }
    secretGuard = guard.mode;
  }

  return { deny, windows, maxRequestsPerHour, maxOutputTokens, subagentModels, secretGuard };
}

/**
 * What the secret guard does for this live policy: "block", "redact", or null (off,
 * or a document the reader refuses, which the policy step denies anyway). The caller
 * passes nothing for an UNREADABLE policy: the guard is then not applied, under the
 * policy step's posture, as for the sub-agent allowlist.
 */
export function secretGuardMode(value: unknown): SecretGuardMode | null {
  return parsePolicy(value)?.secretGuard ?? null;
}

/**
 * The sub-agent model allowlist a live policy sets, or null for "no restriction".
 *
 * null also for a document the reader refuses: a malformed live policy is denied
 * by the policy step (`policy:malformed`) whatever this says, so it has nothing to
 * add. The caller passes nothing for an UNREADABLE policy: the allowlist is then
 * unknown and is not applied, under the policy step's posture (fail open by
 * default, closed where POLICY_FAIL_CLOSED is set, as on Cloud).
 */
export function subagentAllowlist(value: unknown): ScopeEntry[] | null {
  return parsePolicy(value)?.subagentModels ?? null;
}

/**
 * Would the gateway be able to read this as a policy?
 *
 * The write-side validator must not own a second copy of these bounds. If it
 * did, the two could disagree in either direction, and both directions are bad:
 * a validator stricter than the reader rejects policies the gateway would honour,
 * and a validator looser than it accepts policies the gateway reads as malformed
 * — which for the LIVE policy column means `policy:malformed`, a denial the
 * operator did not ask for. So this exposes the reader's own verdict rather than
 * describing it, and `parsePolicy` stays unexported.
 *
 * `null` is well-formed and means "no policy", the same as the column default.
 */
export function policyIsWellFormed(value: unknown): boolean {
  return parsePolicy(value) !== null;
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
      maxOutputTokens: null,
      subagentModels: null,
      secretGuard: null,
    };
  }
  return {
    configured,
    valid: true,
    deny: policy.deny.map((rule) => ({ ...rule, models: [...rule.models] })),
    windows: policy.windows.map((window) => ({ ...window, days: [...window.days] })),
    maxRequestsPerHour: policy.maxRequestsPerHour,
    maxOutputTokens: policy.maxOutputTokens,
    subagentModels: policy.subagentModels?.map((entry) => ({ ...entry, models: [...entry.models] })) ?? null,
    secretGuard: policy.secretGuard,
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
 *
 * `output` is what the request asks the provider to generate, read strictly for
 * its shape (lib/output-limit.ts). `null` means the request generates no output —
 * a model listing, or an embeddings call — and is exempt from an output ceiling.
 * UNDEFINED IS NOT
 * EXEMPT: it reads as "no limit stated", so a caller that forgets to supply the
 * facts is refused by a configured ceiling rather than silently admitted.
 */
export function evaluateAgentPolicy(
  value: unknown,
  provider: string,
  model: string,
  now: Date = new Date(),
  output?: RequestedOutput | null
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
    const day = POLICY_DAYS[now.getUTCDay()] ?? "";
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

  // The output ceiling, BEFORE the hourly counter is consulted, so a request it
  // refuses never spends a unit of that quota. Refused, never rewritten: a body
  // clamped to the ceiling would be a request the agent never made, truncated in
  // a way it cannot tell from the model stopping.
  if (policy.maxOutputTokens !== null && output !== null) {
    const limit = policy.maxOutputTokens;
    const asked: RequestedOutput = output ?? { kind: "absent" };
    if (asked.kind === "absent") {
      return { allowed: false, reason: "output_limit", rule: "max_output_tokens:missing", limit };
    }
    if (asked.kind === "invalid") {
      return { allowed: false, reason: "output_limit", rule: "max_output_tokens:invalid", limit };
    }
    if (asked.tokens > limit) {
      return { allowed: false, reason: "output_limit", rule: "max_output_tokens:exceeded", limit };
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
  /**
   * `embeddings` marks a rule whose calls turn input into vectors and generate
   * nothing. Everything that treats embeddings differently from chat — the
   * estimate, the usage report, the output ceiling, the stream refusal, the
   * streamed response path, the advertised path — asks `isEmbeddingsEndpoint`,
   * which reads this flag, so no caller re-derives it from a path spelling.
   */
  readonly kind?: "embeddings";
  readonly method: string;
  readonly path: readonly string[];
  readonly upstreamPath: readonly string[];
  /**
   * When set, the rule matches `path` followed by EXACTLY ONE more segment,
   * which is appended (URL-encoded) to `upstreamPath`.
   *
   * This exists for one shape only: retrieving a single model,
   * `GET /v1/models/{id}`. `pathEquals` is exact-length, so that call could
   * never match the length-2 listing rule and came back `blocked_endpoint` —
   * which is what an agent's "detect context length" probe does, so a supported
   * integration pinged an unrouted path around every prompt.
   *
   * Deliberately *one* segment, never a prefix match. A prefix match under
   * `models` would be a way into anything a provider nests below it, and the
   * comment above this allowlist promises exact-segment matching.
   */
  readonly param?: true;
  /**
   * Served from the server's ROOT rather than under the stored base: Ollama's own
   * API is `http://host:11434/api/chat` while the stored `local` base carries
   * `/v1`. The route joins these to `serverRootOf(base)`.
   */
  readonly root?: true;
  /** The request and usage format is Ollama's own (NDJSON, `prompt_eval_count`). */
  readonly protocol?: "ollama";
}

/**
 * A free segment may only ever BE a segment.
 *
 * The route handler already rejects traversal on every path, but this matcher
 * must not depend on its caller having done that — the result is joined
 * straight into the upstream URL. Checked here, and encoded on the way out.
 */
function isSafeParamSegment(segment: string | undefined): segment is string {
  if (!segment) return false;
  if (segment === "." || segment === "..") return false;
  if (segment.includes("/")) return false;
  return !/%2e|%2f/i.test(segment);
}

const OPENAI_CHAT_PATH = ["v1", "chat", "completions"] as const;
const OPENAI_RESPONSES_PATH = ["v1", "responses"] as const;
const OPENAI_MODELS_PATH = ["v1", "models"] as const;
const OPENAI_EMBEDDINGS_PATH = ["v1", "embeddings"] as const;
const ANTHROPIC_MESSAGES_PATH = ["v1", "messages"] as const;
// The versionless spellings, for providers whose base URL already carries its
// own version segment (deepseek, and gemini's OpenAI-compat base `/v1beta/openai`).
const DEEPSEEK_CHAT_PATH = ["chat", "completions"] as const;
const VERSIONLESS_MODELS_PATH = ["models"] as const;

const ENDPOINT_ALLOWLIST: Record<ProviderId, readonly EndpointRule[]> = {
  openai: [
    { method: "POST", path: ["chat", "completions"], upstreamPath: OPENAI_CHAT_PATH },
    { method: "POST", path: OPENAI_CHAT_PATH, upstreamPath: OPENAI_CHAT_PATH },
    { method: "POST", path: ["responses"], upstreamPath: OPENAI_RESPONSES_PATH },
    { method: "POST", path: OPENAI_RESPONSES_PATH, upstreamPath: OPENAI_RESPONSES_PATH },
    // Embeddings, served only where the provider's own docs confirm a usage
    // report the gateway can settle on. Both spellings, as for chat.
    { method: "POST", path: ["embeddings"], upstreamPath: OPENAI_EMBEDDINGS_PATH, kind: "embeddings" },
    { method: "POST", path: OPENAI_EMBEDDINGS_PATH, upstreamPath: OPENAI_EMBEDDINGS_PATH, kind: "embeddings" },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH, param: true },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH, param: true },
  ],
  anthropic: [
    { method: "POST", path: ANTHROPIC_MESSAGES_PATH, upstreamPath: ANTHROPIC_MESSAGES_PATH },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH, param: true },
    // Discovery only, and both spellings, for the same reason the deepseek note
    // below gives: a client can't know which one we accept. Every other
    // OpenAI-shape provider here already carries both. Observed in production
    // on 2026-08-17 — one agent whose chat succeeded at `POST /v1/messages`
    // while its discovery step tried `GET /models`, which was 8 of the 20
    // refusals on the board.
    //
    // Chat is deliberately NOT given the same treatment: anthropic's only chat
    // rule stays `v1/messages`. Listing runs no model and spends nothing, so
    // being generous about how a client spells it costs nothing; being generous
    // about how it spells inference would widen what actually bills.
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH, param: true },
  ],
  groq: [
    { method: "POST", path: ["chat", "completions"], upstreamPath: OPENAI_CHAT_PATH },
    { method: "POST", path: OPENAI_CHAT_PATH, upstreamPath: OPENAI_CHAT_PATH },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH, param: true },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH, param: true },
  ],
  mistral: [
    { method: "POST", path: ["chat", "completions"], upstreamPath: OPENAI_CHAT_PATH },
    { method: "POST", path: OPENAI_CHAT_PATH, upstreamPath: OPENAI_CHAT_PATH },
    // docs.mistral.ai/api/endpoint/embeddings, read 2026-09-27: `POST /v1/embeddings`,
    // and `usage` (with `prompt_tokens`) is a required response field.
    { method: "POST", path: ["embeddings"], upstreamPath: OPENAI_EMBEDDINGS_PATH, kind: "embeddings" },
    { method: "POST", path: OPENAI_EMBEDDINGS_PATH, upstreamPath: OPENAI_EMBEDDINGS_PATH, kind: "embeddings" },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH, param: true },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH, param: true },
  ],
  // No embeddings row: Together's embeddings response reports no usage (its
  // OpenAPI schema and both SDKs, read 2026-09-27), so every call would be charged
  // a characters ÷ 4 guess that can fall below the real bill.
  together: [
    { method: "POST", path: ["chat", "completions"], upstreamPath: OPENAI_CHAT_PATH },
    { method: "POST", path: OPENAI_CHAT_PATH, upstreamPath: OPENAI_CHAT_PATH },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH, param: true },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH, param: true },
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
  // Gemini via Google's OpenAI-compatibility endpoint. The base URL already
  // ends in `/v1beta/openai`, so every upstream path here is versionless —
  // structurally the deepseek case, not the openai one. Both client spellings
  // are accepted and normalised for the reason the deepseek note above gives:
  // a client configured with a host-style base URL sends `v1/chat/completions`
  // and cannot know we serve it unversioned.
  gemini: [
    { method: "POST", path: DEEPSEEK_CHAT_PATH, upstreamPath: DEEPSEEK_CHAT_PATH },
    { method: "POST", path: OPENAI_CHAT_PATH, upstreamPath: DEEPSEEK_CHAT_PATH },
    { method: "GET", path: VERSIONLESS_MODELS_PATH, upstreamPath: VERSIONLESS_MODELS_PATH },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: VERSIONLESS_MODELS_PATH },
    { method: "GET", path: VERSIONLESS_MODELS_PATH, upstreamPath: VERSIONLESS_MODELS_PATH, param: true },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: VERSIONLESS_MODELS_PATH, param: true },
  ],
  // xAI: Responses and model discovery only (plan P2-5). Its Chat Completions
  // endpoint is the legacy API; on it, whether `max_completion_tokens` bounds
  // reasoning is undocumented, so neither the output ceiling nor the hold could
  // be relied on. Responses documents `max_output_tokens` as covering reasoning.
  // Retrieval, deletion and compaction of stored responses are not allowlisted.
  // OpenRouter: Chat Completions and the model list (plans/openrouter.md). Not
  // allowlisted, on purpose: its Responses and Anthropic-shape Messages endpoints
  // (later), embeddings, batches, the legacy completions endpoint, per-model
  // endpoint listings, and every management endpoint (keys, credits, BYOK
  // credentials, workspaces, generations), any of which would let an agent act on
  // the account whose key the gateway holds.
  openrouter: [
    { method: "POST", path: ["chat", "completions"], upstreamPath: OPENAI_CHAT_PATH },
    { method: "POST", path: OPENAI_CHAT_PATH, upstreamPath: OPENAI_CHAT_PATH },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH },
  ],
  xai: [
    { method: "POST", path: ["responses"], upstreamPath: OPENAI_RESPONSES_PATH },
    { method: "POST", path: OPENAI_RESPONSES_PATH, upstreamPath: OPENAI_RESPONSES_PATH },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH, param: true },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH, param: true },
  ],
  // Azure OpenAI's v1 API, OpenAI's paths under the resource's own `/openai/v1`
  // (the stored address carries the version, so `versionlessUpstreamPath` drops
  // ours). Chat, Responses, embeddings (with a deployment name, like chat) and
  // model discovery; no files, fine-tuning, batches or stored-response reads.
  // The legacy `/openai/deployments/<name>/…` shape is not offered: it needs an
  // `api-version`, and the deployment in the path would bypass the model scope.
  azure: [
    { method: "POST", path: ["chat", "completions"], upstreamPath: OPENAI_CHAT_PATH },
    { method: "POST", path: OPENAI_CHAT_PATH, upstreamPath: OPENAI_CHAT_PATH },
    { method: "POST", path: ["responses"], upstreamPath: OPENAI_RESPONSES_PATH },
    { method: "POST", path: OPENAI_RESPONSES_PATH, upstreamPath: OPENAI_RESPONSES_PATH },
    { method: "POST", path: ["embeddings"], upstreamPath: OPENAI_EMBEDDINGS_PATH, kind: "embeddings" },
    { method: "POST", path: OPENAI_EMBEDDINGS_PATH, upstreamPath: OPENAI_EMBEDDINGS_PATH, kind: "embeddings" },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH },
  ],
  // A local OpenAI-compatible server (Ollama, LM Studio, vLLM). Its stored base
  // carries the version (`http://localhost:11434/v1`), so `versionlessUpstreamPath`
  // drops ours, and both client spellings are accepted for the reason Azure's
  // are. Chat and model discovery, which every one of those servers implements.
  // Nothing else, so a server's own admin API (Ollama's `/api/pull`,
  // `/api/delete`) is never reachable through an agent key. Embeddings wait
  // until a local server's usage report is verified: Ollama 0.35.1 refused
  // embeddings from a chat model outright (2026-10-05), so there was nothing to
  // settle on yet.
  local: [
    { method: "POST", path: ["chat", "completions"], upstreamPath: OPENAI_CHAT_PATH },
    { method: "POST", path: OPENAI_CHAT_PATH, upstreamPath: OPENAI_CHAT_PATH },
    { method: "GET", path: ["models"], upstreamPath: OPENAI_MODELS_PATH },
    { method: "GET", path: OPENAI_MODELS_PATH, upstreamPath: OPENAI_MODELS_PATH },
    // Ollama's own API, for apps that only take OLLAMA_HOST (1.3.0 #3; captured
    // from the ollama CLI against Ollama 0.40.0, 2026-10-07). Chat and generate
    // are governed calls in Ollama's NDJSON format; show, tags and version are
    // metadata, treated like a model listing (OLLAMA_METADATA_PATHS). Pull, push,
    // create, copy, delete and embeddings are not here, so they are refused.
    { method: "POST", path: ["api", "chat"], upstreamPath: ["api", "chat"], root: true, protocol: "ollama" },
    { method: "POST", path: ["api", "generate"], upstreamPath: ["api", "generate"], root: true, protocol: "ollama" },
    { method: "POST", path: ["api", "show"], upstreamPath: ["api", "show"], root: true },
    { method: "GET", path: ["api", "tags"], upstreamPath: ["api", "tags"], root: true },
    { method: "GET", path: ["api", "version"], upstreamPath: ["api", "version"], root: true },
  ],
};

function pathEquals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((seg, i) => seg === b[i]);
}

/** The matched rule plus, for a parameterised rule, the segment it captured. */
interface EndpointMatch {
  rule: EndpointRule;
  param: string | null;
}

function endpointMatchFor(
  provider: ProviderId,
  method: string,
  path: readonly string[]
): EndpointMatch | null {
  const m = method.toUpperCase();
  for (const rule of ENDPOINT_ALLOWLIST[provider]) {
    if (rule.method !== m) continue;
    if (!rule.param) {
      if (pathEquals(rule.path, path)) return { rule, param: null };
      continue;
    }
    // Exactly one more segment than the rule, and it must be a safe one.
    if (path.length !== rule.path.length + 1) continue;
    if (!pathEquals(rule.path, path.slice(0, rule.path.length))) continue;
    const segment = path[path.length - 1];
    if (!isSafeParamSegment(segment)) continue;
    return { rule, param: segment };
  }
  return null;
}

function endpointRuleFor(
  provider: ProviderId,
  method: string,
  path: readonly string[]
): EndpointRule | null {
  return endpointMatchFor(provider, method, path)?.rule ?? null;
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
  const match = endpointMatchFor(provider, method, path);
  if (!match) return null;
  if (match.param == null) return match.rule.upstreamPath;
  // Encoded, so a captured segment cannot introduce a slash, a query or a
  // fragment into the URL the proxy builds by joining these parts.
  return [...match.rule.upstreamPath, encodeURIComponent(match.param)];
}

/**
 * Whether this (method, path) is an allowlisted embeddings call on this provider.
 *
 * Keyed on the provider as well as the path because the same spelling is
 * denied on a provider with no embeddings row, and a denied call must not pick
 * up an embeddings exemption on its way to being refused.
 */
export function isEmbeddingsEndpoint(
  provider: ProviderId,
  method: string,
  path: readonly string[]
): boolean {
  return endpointRuleFor(provider, method, path)?.kind === "embeddings";
}

/**
 * Whether a canonical attempt speaks the Responses wire shape: OpenAI's, or
 * xAI's, which follows it (`input`, `max_output_tokens`, a terminal
 * `response.completed` carrying `response.usage`). The usage report differs in
 * one respect, handled where usage is read (lib/usage/parseStream.ts).
 */
export function isResponsesEndpoint(
  provider: ProviderId,
  upstreamPath: readonly string[]
): boolean {
  return (
    (provider === "openai" || provider === "xai" || provider === "azure") &&
    pathEquals(upstreamPath, OPENAI_RESPONSES_PATH)
  );
}

/** The model-listing endpoints (GET /models or /v1/models) carry no model, so the
 *  per-model scope check does not apply to it — it is gated by the endpoint
 *  allowlist (GET-only) instead. */
/**
 * The listing INDEX only — `GET /models` or `GET /v1/models`, never the
 * single-model retrieve.
 *
 * Separate from `isModelListing` because the two answer different questions.
 * That one asks "is this exempt from the per-model scope check" (both forms
 * are). This one asks "is this the agent discovering what it may use", which is
 * the index alone — and it is the only response the gateway narrows to scope.
 */
/** Ollama's metadata calls: they read about models and generate nothing. */
const OLLAMA_METADATA_PATHS: readonly (readonly string[])[] = [
  ["api", "tags"],
  ["api", "version"],
  ["api", "show"],
];

/** Whether this call speaks Ollama's own format (NDJSON, `prompt_eval_count`). */
export function isOllamaNativeEndpoint(provider: ProviderId, method: string, path: readonly string[]): boolean {
  return endpointRuleFor(provider, method, path)?.protocol === "ollama";
}

/** Whether the upstream path joins the server's root rather than the stored base. */
export function isRootRelativeEndpoint(provider: ProviderId, method: string, path: readonly string[]): boolean {
  return endpointRuleFor(provider, method, path)?.root === true;
}

export function isModelListingIndex(path: readonly string[]): boolean {
  return (path.length === 1 && path[0] === "models") || pathEquals(path, OPENAI_MODELS_PATH);
}

export function isModelListing(path: readonly string[]): boolean {
  const listing = isModelListingIndex;
  if (listing(path)) return true;
  // Ollama's metadata calls generate nothing either, and /api/tags names no
  // model to match a scope against. The endpoint allowlist is what admits them
  // (only `local` lists these paths).
  if (OLLAMA_METADATA_PATHS.some((p) => pathEquals(p, path))) return true;
  // Retrieving ONE model is exempt for the same reason, and it must be exempt
  // for consistency: `GET /v1/models` returns every model and is already exempt,
  // so gating the strictly narrower call more tightly would mean an agent may
  // list every model but not read one of them. Neither call runs inference, so
  // neither has a model to match a scope pattern against.
  return path.length > 1 && isSafeParamSegment(path[path.length - 1])
    ? listing(path.slice(0, -1))
    : false;
}

/**
 * A provider PassControl serves for inference only through Responses — it has a
 * Responses endpoint and no Chat Completions endpoint. Derived from the
 * allowlist, so onboarding copy cannot drift from what the gateway admits.
 */
export function servesResponsesOnly(provider: ProviderId): boolean {
  return advertisedClientPath(provider, "chat") === null && advertisedClientPath(provider, "responses") !== null;
}

/**
 * The client path to advertise for a provider — what an SDK pointed at
 * `/api/v1/<provider>` would actually send.
 *
 * Derived from the allowlist rather than typed, per the same discipline that
 * generates the CLI's integration list: several providers accept more than one
 * spelling (deepseek takes both `chat/completions` and `v1/chat/completions`),
 * and the shortest is the one that corresponds to the plain base URL. Typing it
 * out would be a second list to drift from the first.
 */
export function advertisedClientPath(
  provider: ProviderId,
  operation: "chat" | "models" | "embeddings" | "responses"
): readonly string[] | null {
  const candidates = ENDPOINT_ALLOWLIST[provider].filter((rule) => {
    // Parameterised rules are excluded: what is advertised is a BASE path an SDK
    // is pointed at, and `/v1/models/{id}` is not one.
    if (rule.param) return false;
    // Embeddings rows are advertised only as embeddings. They are also the
    // SHORTEST non-listing rows (`embeddings`), so without this the chat base
    // would be advertised as the embeddings endpoint.
    if (operation === "embeddings") return rule.kind === "embeddings";
    if (rule.kind === "embeddings") return false;
    // Responses is also an inference endpoint, but it is not the Chat
    // Completions base; it is advertised only as itself.
    const responses = isResponsesEndpoint(provider, rule.upstreamPath);
    if (operation === "responses") return responses;
    if (responses) return false;
    return isModelListing(rule.path) === (operation === "models");
  });
  if (candidates.length === 0) return null;
  return candidates.reduce((shortest, rule) =>
    rule.path.length < shortest.path.length ? rule : shortest
  ).path;
}
