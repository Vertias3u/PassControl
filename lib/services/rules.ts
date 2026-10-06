// Per-agent service rules: which calls an agent may make to a service.
//
// Stored in `agents.service_rules` (migration 0074) as
//
//   { "github": { "allow": [{ "method": "GET", "path": "/repos/acme/*/issues" }],
//                 "max_requests_per_hour": 200 } }
//
// Deny by default. These rules ARE the scope for a service call, not a policy
// overlay, so they are re-validated on every read — a tenant can PATCH the jsonb
// column directly, and the dashboard editor is not the boundary (the same note
// lib/scope.ts makes for `policy`). Anything malformed denies THAT service and
// leaves every other service and every LLM call alone (plans/any-api-
// credentials.md §3, T11).
//
// Pattern language, deliberately tiny:
//   - a literal segment matches itself exactly (case-sensitive);
//   - `*` matches exactly one segment;
//   - `**` matches one or more trailing segments, and only as the last segment.
// No partial wildcards. Matching is a single left-to-right pass with no
// backtracking, so a tenant-written pattern cannot cost more than its own
// length (the ReDoS history in lib/scope.ts does not apply by construction).
//
// Methods: `GET` (with `HEAD` admitted exactly where `GET` is), and since phase
// 2 the writes `POST`, `PUT`, `PATCH`, `DELETE`. A write rule admits only the
// method it names, and may not use the trailing `**`: a read wildcard can
// over-expose, a write wildcard can destroy (owner decision, 2026-10-01). Any
// other method, or `**` on a write, makes the rule set malformed rather than
// being skipped, so a document this build does not understand fails closed.
// Some writes are refused whatever a rule says; that list lives in the catalog
// (`refused`), because it is about the service, not the tenant.
import { livePolicyRevision } from "@/lib/policy-shadow";
import { SERVICE_CATALOG, isServiceId, ruleShapeFor } from "@/lib/services/catalog";
import { MAX_PATH_SEGMENTS, MAX_SEGMENT_LENGTH } from "@/lib/services/path";

/** Calls per hour when a rule set names no cap. A default, never "unlimited". */
export const DEFAULT_SERVICE_HOURLY_CAP = 500;

/** This service's default cap: its catalog entry's own (lower) one, or the shared default. */
export function defaultHourlyCapFor(service: string): number {
  return isServiceId(service) ? SERVICE_CATALOG[service].defaultHourlyCap ?? DEFAULT_SERVICE_HOURLY_CAP : DEFAULT_SERVICE_HOURLY_CAP;
}
export const MAX_SERVICE_HOURLY_CAP = 1_000_000;
export const MAX_SERVICE_RULES = 200;

export const SERVICE_RULE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ServiceRuleMethod = (typeof SERVICE_RULE_METHODS)[number];

export interface ServiceRule {
  /**
   * An HTTP method, or `CALL` for a service whose rules name a method instead
   * of a verb and a path (Telegram: `{ "call": "sendMessage" }`).
   */
  method: ServiceRuleMethod | "CALL";
  /** As written, e.g. `/repos/acme/*\/issues`, or the method name for `CALL`. The template a log row records. */
  path: string;
  /** Pattern segments; for `CALL`, the lower-cased method name alone. */
  segments: readonly string[];
  /**
   * "Ask me first": a call this rule admits waits for the owner's approval
   * before it is sent (lib/state/approvals.ts). Stored only when true; absent
   * reads as false, so every rule written before the flag keeps working unasked.
   */
  ask: boolean;
}

export interface ServiceRules {
  allow: readonly ServiceRule[];
  maxRequestsPerHour: number;
}

export type ServiceRulesRead =
  | { kind: "rules"; rules: ServiceRules }
  /** No rules for this service: deny, as an empty allow list does. */
  | { kind: "none" }
  /** Present but invalid: deny, and say so. */
  | { kind: "malformed"; reason: string };

const ENTRY_KEYS = new Set(["allow", "max_requests_per_hour"]);
const RULE_KEYS = new Set(["method", "path", "ask"]);
const CALL_RULE_KEYS = new Set(["call", "ask"]);
// A Bot-API-style method name: letters, digits and _, starting with a letter.
// No wildcard on purpose: a call rule names exactly one method.
const CALL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function patternSegments(path: unknown): string[] | null {
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  const segments = path.slice(1).split("/");
  if (segments.length === 0 || segments.length > MAX_PATH_SEGMENTS) return null;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (s === "" || s === "." || s === "..") return null;
    if (s.length > MAX_SEGMENT_LENGTH) return null;
    // Rules are written DECODED, as the matcher sees segments. A `%` here would
    // mean one thing to the author and another to the matcher.
    if (/[/\\%?#]/u.test(s) || /[\u0000-\u001f\u007f]/u.test(s)) return null;
    if (s === "**" && i !== segments.length - 1) return null;
    if (s.includes("*") && s !== "*" && s !== "**") return null;
  }
  return segments;
}

export function parseServiceRules(raw: unknown, service: string): ServiceRulesRead {
  if (raw === null || raw === undefined) return { kind: "none" };
  if (!isPlainObject(raw)) return { kind: "malformed", reason: "document_not_object" };
  // Own properties only: `__proto__` and friends are not services.
  if (!Object.prototype.hasOwnProperty.call(raw, service)) return { kind: "none" };
  const entry = raw[service];
  if (!isPlainObject(entry)) return { kind: "malformed", reason: "entry_not_object" };
  for (const key of Object.keys(entry)) {
    if (!ENTRY_KEYS.has(key)) return { kind: "malformed", reason: `unknown_key:${key}` };
  }

  const allowRaw = entry.allow ?? [];
  if (!Array.isArray(allowRaw)) return { kind: "malformed", reason: "allow_not_array" };
  if (allowRaw.length > MAX_SERVICE_RULES) return { kind: "malformed", reason: "too_many_rules" };

  const allow: ServiceRule[] = [];
  const callShaped = ruleShapeFor(service) === "call";
  for (const rule of allowRaw) {
    if (!isPlainObject(rule)) return { kind: "malformed", reason: "rule_not_object" };
    // A boolean or nothing. Anything else is a document this build does not
    // understand, and that denies the service rather than guessing either way.
    if (rule.ask !== undefined && typeof rule.ask !== "boolean") return { kind: "malformed", reason: "ask" };
    const ask = rule.ask === true;
    if (callShaped) {
      for (const key of Object.keys(rule)) {
        if (!CALL_RULE_KEYS.has(key)) return { kind: "malformed", reason: `unknown_rule_key:${key}` };
      }
      if (typeof rule.call !== "string" || !CALL_NAME.test(rule.call)) {
        return { kind: "malformed", reason: "call" };
      }
      allow.push({ method: "CALL", path: rule.call, segments: [rule.call.toLowerCase()], ask });
      continue;
    }
    for (const key of Object.keys(rule)) {
      if (!RULE_KEYS.has(key)) return { kind: "malformed", reason: `unknown_rule_key:${key}` };
    }
    if (!(SERVICE_RULE_METHODS as readonly unknown[]).includes(rule.method)) {
      return { kind: "malformed", reason: "method" };
    }
    const segments = patternSegments(rule.path);
    if (!segments) return { kind: "malformed", reason: "path" };
    if (rule.method !== "GET" && segments.at(-1) === "**") {
      return { kind: "malformed", reason: "write_wildcard" };
    }
    allow.push({ method: rule.method as ServiceRuleMethod, path: rule.path as string, segments, ask });
  }

  let maxRequestsPerHour = defaultHourlyCapFor(service);
  if (entry.max_requests_per_hour !== undefined) {
    const cap = entry.max_requests_per_hour;
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1 || cap > MAX_SERVICE_HOURLY_CAP) {
      return { kind: "malformed", reason: "max_requests_per_hour" };
    }
    maxRequestsPerHour = cap;
  }
  return { kind: "rules", rules: { allow, maxRequestsPerHour } };
}

function segmentsMatch(pattern: readonly string[], actual: readonly string[]): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!;
    if (p === "**") return actual.length > i; // one or more remaining
    if (i >= actual.length) return false;
    if (p !== "*" && p !== actual[i]) return false;
  }
  return pattern.length === actual.length;
}

/**
 * The first rule admitting this call, or null. HEAD rides on GET. A `CALL` rule
 * admits exactly one method name, in any case (the API's own rule), over GET or
 * POST and nothing else.
 */
function ruleAdmits(rule: ServiceRule, method: string, segments: readonly string[]): boolean {
  if (rule.method === "CALL") {
    return (
      (method === "GET" || method === "POST") &&
      segments.length === 1 &&
      segments[0]!.toLowerCase() === rule.segments[0]
    );
  }
  return rule.method === (method === "HEAD" ? "GET" : method) && segmentsMatch(rule.segments, segments);
}

export function matchServiceRule(
  rules: ServiceRules,
  method: string,
  segments: readonly string[]
): ServiceRule | null {
  for (const rule of rules.allow) if (ruleAdmits(rule, method, segments)) return rule;
  return null;
}

/**
 * Whether this call must wait for the owner: true when ANY rule admitting it
 * asks, not only the first. A broad read rule listed before a narrow rule with
 * "Ask me first" must not quietly win, because the editor shows the narrow
 * rule as asking.
 */
export function serviceCallAsks(rules: ServiceRules, method: string, segments: readonly string[]): boolean {
  return rules.allow.some((rule) => rule.ask && ruleAdmits(rule, method, segments));
}

/**
 * The revision of the rules that decided a service call, for the receipt's
 * `pol`. The same canonicaliser and hash as the LLM path's live revision, over
 * a service-shaped snapshot, so an edit to a rule or the cap moves it.
 */
export function serviceRulesRevision(service: string, rules: ServiceRules | null): string {
  return livePolicyRevision({
    service,
    // `ask` only when on, so a rule set without it keeps the revision it had.
    allow: rules ? rules.allow.map((r) => ({ method: r.method, path: r.path, ...(r.ask ? { ask: true } : {}) })) : null,
    max_requests_per_hour: rules ? rules.maxRequestsPerHour : null,
  });
}
