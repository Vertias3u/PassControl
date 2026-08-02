// Pure, ordered gateway decision evaluator. It performs no I/O and owns no
// mutable state: callers supply point-in-time read results, and the proxy also
// supplies its atomic budget-reserve result. This is the one decision chain
// shared by live proxy calls and owner-facing traces.
import type { ScopeEntry } from "./auth/visa";
import type { KillState } from "./state/killswitch";
import { isProvider } from "./providers";
import {
  endpointAllows,
  evaluateAgentPolicy,
  isModelListing,
  scopeRuleMatch,
} from "./scope";

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
  reason?: "tokens" | "cost";
  estimateTokens: number;
  estimateMicrocents: number;
  reservedTokens?: number;
  reservedMicrocents?: number;
  source: "atomic_reserve" | "snapshot";
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
 * Evaluate kill → suspend → scope → endpoint → policy → budget in order.
 *
 * Missing inputs are deliberate staging points for the live route. They mark
 * this evaluation incomplete and skip the rest of the chain. That lets the
 * route preserve its historical error/side-effect order while still delegating
 * every gate decision to this function. A trace always supplies every input.
 */
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
  } else {
    steps.push({
      name: "endpoint",
      status: "pass",
      reason: `${input.method.toUpperCase()} /${input.path.join("/")} is allowlisted.`,
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
      input.now
    );
    if (!decision.allowed) {
      policy = { outcome: "deny_by_rule" };
      fail(
        "policy",
        `Policy rule ${decision.rule} denied this call.`,
        decision.rule,
        403
      );
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
    const dimension = input.budget.reason === "cost" ? "cost" : "token";
    fail(
      "budget",
      `The ${dimension} budget cannot reserve ${input.budget.estimateTokens} estimated tokens (${input.budget.estimateMicrocents} micro-cents).`,
      `budget:${input.budget.reason ?? "tokens"}`,
      402
    );
  } else {
    steps.push({
      name: "budget",
      status: "pass",
      reason: `A ${input.budget.source === "snapshot" ? "snapshot projects" : "live atomic reserve confirmed"} ${input.budget.estimateTokens} tokens (${input.budget.estimateMicrocents} micro-cents).`,
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
