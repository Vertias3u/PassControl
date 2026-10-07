// Pure, ordered gateway decision evaluator. It performs no I/O and owns no
// mutable state: callers supply point-in-time read results, and the proxy also
// supplies its atomic budget-reserve result. This is the one decision chain
// shared by live proxy calls and owner-facing traces.
import type { ScopeEntry } from "./auth/visa";
import type { KillState } from "./state/killswitch";
import { isProvider, providerRequiresEndpoint } from "./providers";
import {
  endpointAllows,
  evaluateAgentPolicy,
  isEmbeddingsEndpoint,
  isModelListing,
  scopeRuleMatch,
} from "./scope";
import type { RequestedOutput } from "./output-limit";
import { isServerSideSearchModel } from "./providers/server-side-tools";
import { hasListedPrice, isLivePricedProvider } from "./pricing";
import { isOpenRouterModelRouter } from "./providers/openrouter";

export const POLICY_UNREADABLE = "POLICY_UNREADABLE" as const;

export type GateStepName = "kill" | "suspend" | "scope" | "endpoint" | "policy" | "budget";
export type GateStepStatus = "pass" | "fail" | "skipped";

export interface GateStepResult {
  name: GateStepName;
  status: GateStepStatus;
  reason: string;
  rule?: string;
  httpStatus?: 402 | 403 | 429;
  presentation?: "normal" | "warning";
  /** The configured output ceiling, on a `max_output_tokens:*` refusal only. */
  limit?: number;
}

export type GatePolicyInput =
  | { kind: "value"; value: unknown }
  | { kind: typeof POLICY_UNREADABLE };

export interface GateRateLimitInput {
  success: boolean;
  remaining: number;
  unreadable?: boolean;
}

export interface GateBudgetInput {
  ok: boolean;
  /** Which cap refused. `period` is the periodic spend limit (K1). */
  reason?: "tokens" | "cost" | "period";
  estimateTokens: number;
  estimateMicrocents: number;
  reservedTokens?: number;
  reservedMicrocents?: number;
  source: "atomic_reserve" | "snapshot";
  /**
   * What the cap still has room for, independent of this call's size.
   *
   * Supplied by the snapshot projection only. The proxy's atomic reserve does
   * not compute it and must not: its answer is authoritative about THIS call
   * and says nothing it would have to keep true for the next one.
   *
   * It exists because a projection's verdict is only as good as the size it
   * assumed, and a reader who cannot see the remaining room cannot tell how
   * much of "allowed" was the assumption. Omitted where there is no cap in
   * that dimension — unlimited has no headroom to state.
   */
  headroomTokens?: number;
  headroomMicrocents?: number;
}

export interface GateInput {
  agentId: string;
  killState?: KillState;
  suspended?: boolean;
  scopes?: readonly ScopeEntry[];
  provider: string;
  method: string;
  path: readonly string[];
  model: string;
  policy?: GatePolicyInput;
  policyFailClosed?: boolean;
  policyRateLimit?: GateRateLimitInput;
  now?: Date;
  budget?: GateBudgetInput;
  /**
   * What the request asks the provider to generate (lib/output-limit.ts), for
   * the policy's output ceiling. Model listings are exempt by path. For any other
   * request an ABSENT value reads as "no limit stated", so a configured ceiling
   * refuses it: forgetting to supply the facts can never become an admission.
   */
  requestedOutput?: RequestedOutput;
  /**
   * The agent has a dollar limit: a cost cap or a periodic limit. A model with no
   * price row of its own is then refused (`endpoint:unpriced_model`), because
   * its cost could only be the provider fallback, and a limit enforced with a
   * number that is not the model's price does not hold. Owner decision
   * 2026-09-27. Absent reads as no dollar limit: a token cap alone is enforced
   * with provider-reported counts, which are real for any model.
   */
  dollarLimited?: boolean;
}

export interface GatePolicyResult {
  outcome: "allow" | "deny_by_rule" | "unreadable";
  posture?: "fail_open" | "fail_closed";
}

export interface GateEvaluation {
  verdict: "allow" | "deny";
  deniedBy?: GateStepName;
  complete: boolean;
  steps: GateStepResult[];
  policy?: GatePolicyResult;
  policyRateLimitRequired: number | null;
}

function demoEndpointAllows(method: string, path: readonly string[]): boolean {
  return (
    method.toUpperCase() === "POST" &&
    path.length === 2 &&
    path[0] === "chat" &&
    path[1] === "completions"
  );
}

function endpointIsAllowed(input: GateInput): boolean {
  if (input.provider === "demo") return demoEndpointAllows(input.method, input.path);
  return isProvider(input.provider)
    ? endpointAllows(input.provider, input.method, input.path)
    : false;
}

function skipped(name: GateStepName, reason: string): GateStepResult {
  return { name, status: "skipped", reason };
}

/**
 * State the room left, when the caller knows it.
 *
 * A projection reads as a verdict, and a verdict hides its assumption. "Projects
 * 1025 tokens" beside "1500 available" lets a reader see that a bigger request
 * would not fit — which is exactly the gap between what this panel is asked and
 * what the gateway is later asked.
 */
function headroomSuffix(budget: GateBudgetInput): string {
  const parts: string[] = [];
  if (budget.headroomTokens !== undefined) parts.push(`${budget.headroomTokens} tokens`);
  if (budget.headroomMicrocents !== undefined) {
    parts.push(`${budget.headroomMicrocents} micro-cents`);
  }
  return parts.length > 0 ? `, against ${parts.join(" and ")} of remaining budget` : "";
}

/**
 * Evaluate kill → suspend → scope → endpoint → policy → budget in order.
 *
 * Missing inputs are deliberate staging points for the live route. They mark
 * this evaluation incomplete and skip the rest of the chain. That lets the
 * route preserve its historical error/side-effect order while still delegating
 * every gate decision to this function. A trace always supplies every input.
 */
/**
 * Whether the call generates nothing, and so is exempt from an output ceiling:
 * a model listing, or an embeddings call on a provider that serves one.
 */
function generatesNoOutput(input: Pick<GateInput, "provider" | "method" | "path">): boolean {
  if (isModelListing(input.path)) return true;
  return isProvider(input.provider) && isEmbeddingsEndpoint(input.provider, input.method, input.path);
}

export function evaluateGate(input: GateInput): GateEvaluation {
  const steps: GateStepResult[] = [];
  let deniedBy: GateStepName | undefined;
  let pending = false;
  let policy: GatePolicyResult | undefined;
  let policyRateLimitRequired: number | null = null;

  const afterStop = (name: GateStepName) => {
    steps.push(
      skipped(
        name,
        deniedBy
          ? `Not evaluated because ${deniedBy} denied earlier.`
          : "Not evaluated because an earlier step is pending."
      )
    );
  };

  const fail = (
    name: GateStepName,
    reason: string,
    rule: string,
    httpStatus: 402 | 403 | 429,
    presentation: "normal" | "warning" = "normal"
  ) => {
    steps.push({ name, status: "fail", reason, rule, httpStatus, presentation });
    deniedBy = name;
  };

  // kill
  if (input.killState === undefined) {
    steps.push(skipped("kill", "Kill state has not been read yet."));
    pending = true;
  } else {
    const state = input.killState;
    if (state.platformKill) {
      fail("kill", "The platform kill switch is armed.", "kill:platform", 403);
    } else if (state.userKill) {
      fail("kill", "The tenant kill switch is armed.", "kill:tenant", 403);
    } else if (state.denylist.includes(input.agentId)) {
      fail("kill", "The agent is on the emergency denylist.", "kill:denylist", 403);
    } else {
      steps.push({
        name: "kill",
        status: "pass",
        reason: "Platform, tenant, and denylist kill controls are not armed.",
        rule: "kill:none",
        presentation: "normal",
      });
    }
  }

  // suspend
  if (deniedBy || pending) {
    afterStop("suspend");
  } else if (input.suspended === undefined) {
    steps.push(skipped("suspend", "Suspension state has not been read yet."));
    pending = true;
  } else if (input.suspended) {
    fail("suspend", "The agent suspension is active.", "suspend:active", 403);
  } else {
    steps.push({
      name: "suspend",
      status: "pass",
      reason: "The agent is not suspended.",
      rule: "suspend:inactive",
      presentation: "normal",
    });
  }

  // scope
  if (deniedBy || pending) {
    afterStop("scope");
  } else if (input.scopes === undefined) {
    steps.push(skipped("scope", "Visa scope has not been supplied yet."));
    pending = true;
  } else if (isModelListing(input.path)) {
    steps.push(
      skipped("scope", "Model-listing requests are governed by the endpoint allowlist.")
    );
  } else {
    const match = scopeRuleMatch(input.scopes, input.provider, input.model);
    if (!match) {
      fail(
        "scope",
        `${input.provider}/${input.model || "(no model)"} is outside the visa scope.`,
        "scope:no_match",
        403
      );
    } else {
      steps.push({
        name: "scope",
        status: "pass",
        reason: `${match.provider}/${match.pattern} allows ${input.model}.`,
        rule: `scope:${match.provider}:${match.pattern}`,
        presentation: "normal",
      });
    }
  }

  // endpoint
  if (deniedBy || pending) {
    afterStop("endpoint");
  } else if (!endpointIsAllowed(input)) {
    fail(
      "endpoint",
      `${input.method.toUpperCase()} /${input.path.join("/")} is not allowlisted.`,
      "endpoint:no_match",
      403
    );
  } else if (input.provider === "openrouter" && isOpenRouterModelRouter(input.model)) {
    // A router or a preset names no one model, so scope cannot judge the one that
    // answers (plans/openrouter.md). Refused whatever the scope says, for the reason
    // a search model is: the gate is what the decision trace and failover share.
    fail(
      "endpoint",
      `${input.model} lets OpenRouter choose the model, so the scope cannot judge which one answers.`,
      "endpoint:model_router",
      403
    );
  } else if (isServerSideSearchModel(input.provider, input.model)) {
    // Refused here rather than in the proxy so the decision trace and failover,
    // which share this evaluator, give the same answer (lib/providers/server-side-tools.ts).
    fail(
      "endpoint",
      `${input.model} runs a web search on every call, billed outside tokens, which no budget here can hold.`,
      "endpoint:openai_search_model",
      403
    );
  } else if (
    input.dollarLimited === true &&
    isProvider(input.provider) &&
    providerRequiresEndpoint(input.provider)
  ) {
    // A provider with no host of its own (Azure) is always a custom endpoint and
    // never priced: its `model` is a deployment name that says nothing about the
    // model behind it. Refused here with S3-03's own answer, `unpriced_endpoint`,
    // rather than `unpriced_model` — "add a price for this model" is advice no
    // operator can follow for a deployment name. Model listings included: the
    // proxy's step 5b refuses them on every custom endpoint under a dollar limit,
    // and this must agree with it for the decision trace to.
    fail(
      "endpoint",
      `${input.provider} calls cannot be priced, so they cannot be held to a dollar limit.`,
      "endpoint:unpriced_endpoint",
      402
    );
  } else if (
    input.dollarLimited === true &&
    isProvider(input.provider) &&
    !isModelListing(input.path) &&
    // OpenRouter is priced per call from its own listing; the proxy refuses it as
    // unpriced there when that listing cannot price the model.
    !isLivePricedProvider(input.provider) &&
    !hasListedPrice(input.model, input.provider)
  ) {
    // Here, not at the budget step, so it is refused before policy: the hourly
    // counter is never consumed and no hold is opened for a call that cannot be
    // priced. 402 like its siblings `unpriced_endpoint` and `unpriced_option`, and
    // like a spent budget: the OpenAI and Anthropic SDKs retry 409 and 429 on their
    // own, and a retry cannot price a model (owner decision 2026-09-27).
    fail(
      "endpoint",
      `${input.model || "(no model)"} has no price row, so a dollar limit cannot be enforced against it.`,
      "endpoint:unpriced_model",
      402
    );
  } else {
    steps.push({
      name: "endpoint",
      status: "pass",
      reason:
        `${input.method.toUpperCase()} /${input.path.join("/")} is allowlisted.` +
        // The trace cannot read OpenRouter's listing; the proxy prices the call when
        // it is made, and refuses there a model the listing cannot price.
        (input.dollarLimited === true && input.provider === "openrouter" && !isModelListing(input.path)
          ? " OpenRouter is priced per call from its own listing, and a model it cannot price is refused then."
          : ""),
      rule: `endpoint:${input.method.toUpperCase()}:/${input.path.join("/")}`,
      presentation: "normal",
    });
  }

  // policy
  if (deniedBy || pending) {
    afterStop("policy");
  } else if (input.policy === undefined) {
    steps.push(skipped("policy", "Current policy has not been read yet."));
    pending = true;
  } else if (input.policy.kind === POLICY_UNREADABLE) {
    const failClosed = input.policyFailClosed === true;
    policy = {
      outcome: "unreadable",
      posture: failClosed ? "fail_closed" : "fail_open",
    };
    if (failClosed) {
      fail(
        "policy",
        "Policy is unreadable; the configured fail-closed posture blocks this call.",
        "policy:unreadable",
        403,
        "warning"
      );
    } else {
      steps.push({
        name: "policy",
        status: "pass",
        reason: "Policy is unreadable; the configured fail-open posture allows this call to continue.",
        rule: "policy:unreadable",
        presentation: "warning",
      });
    }
  } else if (input.now === undefined) {
    steps.push(skipped("policy", "The policy evaluation clock has not been supplied yet."));
    pending = true;
  } else {
    const decision = evaluateAgentPolicy(
      input.policy.value,
      input.provider,
      input.model,
      input.now,
      generatesNoOutput(input) ? null : input.requestedOutput
    );
    if (!decision.allowed) {
      policy = { outcome: "deny_by_rule" };
      fail(
        "policy",
        decision.limit !== undefined
          ? `Policy rule ${decision.rule} denied this call (output ceiling ${decision.limit} tokens).`
          : `Policy rule ${decision.rule} denied this call.`,
        decision.rule,
        403
      );
      if (decision.limit !== undefined) steps[steps.length - 1]!.limit = decision.limit;
    } else {
      policyRateLimitRequired = decision.maxRequestsPerHour;
      if (decision.maxRequestsPerHour !== null && input.policyRateLimit === undefined) {
        policy = { outcome: "allow" };
        steps.push(
          skipped(
            "policy",
            `The ${decision.maxRequestsPerHour}/hour policy counter has not been evaluated yet.`
          )
        );
        pending = true;
      } else if (decision.maxRequestsPerHour !== null && !input.policyRateLimit?.success) {
        policy = { outcome: "deny_by_rule" };
        const unreadable = input.policyRateLimit?.unreadable === true;
        if (unreadable) {
          steps.push({
            name: "policy",
            status: "pass",
            reason: "The hourly policy counter is unreadable; its fail-open posture allows this call to continue.",
            rule: "max_requests_per_hour:unreadable",
            presentation: "warning",
          });
          policy = { outcome: "allow" };
        } else {
          fail(
            "policy",
            `The max_requests_per_hour rule (${decision.maxRequestsPerHour}) is exhausted.`,
            "max_requests_per_hour",
            429
          );
        }
      } else {
        policy = { outcome: "allow" };
        const hourly = decision.maxRequestsPerHour;
        steps.push({
          name: "policy",
          status: "pass",
          reason:
            hourly === null
              ? "No current policy rule denies this call."
              : `Policy allows this call; ${input.policyRateLimit?.remaining ?? 0} of ${hourly} hourly requests remain after it.`,
          rule: hourly === null ? "policy:allow" : "max_requests_per_hour",
          presentation: "normal",
        });
      }
    }
  }

  // budget
  if (deniedBy || pending) {
    afterStop("budget");
  } else if (input.budget === undefined) {
    steps.push(skipped("budget", "Budget has not been evaluated yet."));
    pending = true;
  } else if (!input.budget.ok) {
    const dimension =
      input.budget.reason === "period"
        ? "periodic spend limit"
        : input.budget.reason === "cost"
          ? "cost budget"
          : "token budget";
    fail(
      "budget",
      `The ${dimension} cannot reserve ${input.budget.estimateTokens} estimated tokens ` +
        `(${input.budget.estimateMicrocents} micro-cents)${headroomSuffix(input.budget)}.`,
      `budget:${input.budget.reason ?? "tokens"}`,
      402
    );
  } else {
    steps.push({
      name: "budget",
      status: "pass",
      reason:
        `A ${input.budget.source === "snapshot" ? "snapshot projects" : "live atomic reserve confirmed"} ` +
        `${input.budget.estimateTokens} tokens (${input.budget.estimateMicrocents} micro-cents)` +
        headroomSuffix(input.budget) + ".",
      rule: `budget:${input.budget.source}`,
      presentation: "normal",
    });
  }

  return {
    verdict: deniedBy ? "deny" : "allow",
    ...(deniedBy ? { deniedBy } : {}),
    complete: !pending,
    steps,
    ...(policy ? { policy } : {}),
    policyRateLimitRequired,
  };
}
