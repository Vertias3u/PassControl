// Mission-bound visas (idea 11): what a mission says about ONE gateway call. Pure.
//
// A mission only ever INTERSECTS the agent's standing authority. Every door checks
// its own rules first (scope, service rules, kill switch, budget); the mission is an
// extra condition, never a grant. What it adds is a way to skip the per-step
// question: a service call INSIDE the owner-approved envelope does not wait for
// "Ask me first", because the owner already answered for the whole job. Anything
// outside holds through the same "Ask me first" — never silently allowed, never
// silently dropped.
import { matchServiceRule, parseServiceRules } from "@/lib/services/rules";
import type { MissionDocument } from "./document";

export type MissionDimension = "model" | "service" | "money" | "subagents" | "window" | "tool";
export type MissionDecision =
  | { state: "inside" }
  | { state: "outside"; dimension: MissionDimension; detail: string };

/** Is `now` (seconds) inside the mission's window? */
export function missionWindowDecision(doc: MissionDocument, nowS: number): MissionDecision {
  if (nowS < doc.starts) return { state: "outside", dimension: "window", detail: "the mission has not started" };
  if (nowS >= doc.expires) return { state: "outside", dimension: "window", detail: "the mission has expired" };
  return { state: "inside" };
}

/** Exact provider and model id. A failover target is a model call like any other. */
export function missionModelDecision(doc: MissionDocument, provider: string, model: string): MissionDecision {
  if (doc.models.some((m) => m.provider === provider && m.model === model)) return { state: "inside" };
  return {
    state: "outside",
    dimension: "model",
    detail: model ? `${provider}/${model} is not in the mission` : `a ${provider} call that names no model`,
  };
}

/**
 * A service call, matched with the service route's OWN parser and matcher
 * (lib/services/rules.ts), over the decoded segments that route forwards. A mission
 * therefore cannot admit a path the route would read differently.
 */
export function missionServiceDecision(
  doc: MissionDocument,
  service: string,
  method: string,
  segments: readonly string[]
): MissionDecision {
  // Fail closed on its own, whatever the caller already refused (red team R2-08): a
  // `**` pattern would otherwise admit a `..` or an encoded segment beneath it.
  if (segments.length === 0 || segments.some((s) => s === "" || s === "." || s === ".." || /[\\/%?#\u0000-\u001f\u007f]/u.test(s))) {
    return { state: "outside", dimension: "service", detail: "a path the mission cannot read safely" };
  }
  const allow = doc.services
    .filter((s) => s.service === service)
    .map((s) => (s.method === "CALL" ? { call: s.path } : { method: s.method, path: s.path }));
  const read = parseServiceRules({ [service]: { allow } }, service);
  if (read.kind === "rules" && matchServiceRule(read.rules, method, segments)) return { state: "inside" };
  return {
    state: "outside",
    dimension: "service",
    detail: `${method} /${segments.join("/")} on ${service} is not in the mission`,
  };
}
