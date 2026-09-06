import type { SupabaseClient } from "@supabase/supabase-js";
import {
  POLICY_UNREADABLE,
  evaluateGate,
  type GateBudgetInput,
  type GateEvaluation,
} from "@/lib/gate";
import { readKillState } from "@/lib/state/killswitch";
import { isSuspended, readBudgetSnapshot } from "@/lib/state/redis";
import { readCurrentAgentPolicy } from "@/lib/state/policy";
import { peekRateLimit } from "@/lib/ratelimit";
import {
  costMicrocents,
  demoCostMicrocents,
  estimateTokenUsage,
  MICROCENTS_PER_CENT,
} from "@/lib/pricing";
import { isProvider, type ScopeProviderId } from "@/lib/providers";
import type { ScopeEntry } from "@/lib/auth/visa";
import { readLiveGrant, unionScopes } from "@/lib/break-glass";

const TRACE_AGENT_COLUMNS =
  "id, status, allowed_scopes, budget_tokens, budget_cents, spent_tokens, spent_microcents";

interface TraceAgentRow {
  id: string;
  status: string;
  allowed_scopes: unknown;
  budget_tokens: number | null;
  budget_cents: number | null;
  spent_tokens: number;
  spent_microcents: number;
}

export interface DecisionTrace {
  snapshot: true;
  evaluated_at: string;
  policy_time: string;
  agent_id: string;
  provider: ScopeProviderId;
  model: string;
  method: "POST";
  path: string[];
  verdict: GateEvaluation["verdict"];
  /**
   * Present only while a break-glass elevation is live.
   *
   * The trace reads `allowed_scopes` off the row, but the proxy gates on the
   * scope snapshot inside the visa — which, during an elevation, is wider. A
   * simulator that ignored the grant would report "denied by scope" for calls
   * that actually succeed, and it would do so exactly when someone is most
   * likely to be consulting it. So the grant is folded into the evaluation AND
   * declared here, because a trace that silently agreed would be answering a
   * different question from the one printed on it.
   */
  break_glass?: { expires_at: string; reason: string };
  denied_by?: GateEvaluation["deniedBy"];
  policy?: GateEvaluation["policy"];
  steps: GateEvaluation["steps"];
}

export type DecisionTraceResult =
  | { ok: true; trace: DecisionTrace }
  | { ok: false; status: 404 | 500; code: "not_found" | "query_failed" };

export interface EvaluateDecisionTraceInput {
  db: Pick<SupabaseClient, "from">;
  userId: string;
  agentId: string;
  provider: ScopeProviderId;
  model: string;
  /**
   * The output allowance to project, when the operator knows the call they mean.
   *
   * The panel has no request body, so it projects `estimateTokenUsage`'s own
   * default of 1024 output tokens — exactly what the gateway projects for a body
   * that names no maximum. It is therefore EXACT for a default-shaped call and
   * permissive for a larger one: an agent with 1,500 tokens of headroom traces
   * as allowed, then a request carrying `max_tokens: 2000` is refused 402 by the
   * gateway that agreed a moment earlier. Nothing about the panel is wrong for
   * the call it was asked about; the size was simply never part of the question.
   *
   * So the size becomes part of the question. Optional, because the default is
   * the honest answer to "what happens if I just call it", and the projection is
   * stated on the budget step either way.
   */
  maxOutputTokens?: number | null;
  evaluatedAt: Date;
  policyAt: Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function nullableCap(value: unknown): number | null {
  return value === null ? null : finiteNonNegative(value);
}

function scopes(value: unknown): ScopeEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.provider !== "string") return [];
    const models = Array.isArray(candidate.models)
      ? candidate.models.filter((model): model is string => typeof model === "string")
      : [];
    return [{ provider: candidate.provider, models }];
  });
}

function defaultChatPath(provider: ScopeProviderId): string[] {
  return provider === "anthropic" ? ["v1", "messages"] : ["chat", "completions"];
}

function projectBudget(
  agent: TraceAgentRow,
  snapshot: Awaited<ReturnType<typeof readBudgetSnapshot>>,
  provider: ScopeProviderId,
  model: string,
  maxOutputTokens: number | null
): GateBudgetInput {
  // The panel has no prompt body by design. Use the same estimator as the proxy
  // with the selected model and its normal default-output allowance, and label
  // the result as a projection rather than an atomic reservation.
  const usage = estimateTokenUsage(
    maxOutputTokens === null ? { model } : { model, max_tokens: maxOutputTokens }
  );
  const estimateTokens = usage.totalTokens;
  // The demo has no invoice to price against, so `costMicrocents` has no row for
  // it and would answer 0 — which renders as "affordable" whatever is left of
  // the cap. It charges a flat rate per token against the same counters, so the
  // projection uses the same helper the proxy charges with.
  const estimateMicrocents = isProvider(provider)
    ? costMicrocents(model, usage.inputTokens, usage.outputTokens, provider)
    : demoCostMicrocents(estimateTokens);
  const capTokens = nullableCap(agent.budget_tokens);
  const capMicrocents =
    agent.budget_cents === null
      ? null
      : finiteNonNegative(agent.budget_cents) * MICROCENTS_PER_CENT;
  const spentTokens = snapshot.spentTokens ?? finiteNonNegative(agent.spent_tokens);
  const spentMicrocents =
    snapshot.spentMicrocents ?? finiteNonNegative(agent.spent_microcents);
  const reservedTokens = finiteNonNegative(snapshot.reservedTokens);
  const reservedMicrocents = finiteNonNegative(snapshot.reservedMicrocents);

  // Stated on EVERY outcome, not just the permissive one. A refusal is when the
  // number matters most — "cannot reserve 2001" alone does not tell an operator
  // whether they are 500 tokens over or 500,000, and the browser is where that
  // omission showed: the allow path carried the room and the deny path did not.
  const headroom = {
    ...(capTokens === null
      ? {}
      : { headroomTokens: Math.max(0, capTokens - reservedTokens - spentTokens) }),
    ...(capMicrocents === null
      ? {}
      : {
          headroomMicrocents: Math.max(
            0,
            capMicrocents - reservedMicrocents - spentMicrocents
          ),
        }),
  };

  if (
    capTokens !== null &&
    reservedTokens + spentTokens + estimateTokens > capTokens
  ) {
    return {
      ok: false,
      reason: "tokens",
      estimateTokens,
      estimateMicrocents,
      source: "snapshot",
      ...headroom,
    };
  }
  if (
    capMicrocents !== null &&
    reservedMicrocents + spentMicrocents + estimateMicrocents > capMicrocents
  ) {
    return {
      ok: false,
      reason: "cost",
      estimateTokens,
      estimateMicrocents,
      source: "snapshot",
      ...headroom,
    };
  }
  return {
    ok: true,
    estimateTokens,
    estimateMicrocents,
    reservedTokens: reservedTokens + estimateTokens,
    reservedMicrocents: reservedMicrocents + estimateMicrocents,
    source: "snapshot",
    // What is left regardless of how big the next call is. The projection above
    // answers one question — "does a call THIS size fit" — and a reader with no
    // way to see the headroom cannot tell how much of the answer was the size.
    ...headroom,
  };
}

/**
 * Build a trace after proving ownership. Every dependency here is a read:
 * policy-rate counters are peeked, budgets are snapshotted, and no key/log/
 * nonce/reserve primitive is imported. Endpoint protection is applied by the
 * callers in a separate decision-trace rate-limit namespace.
 */
export async function evaluateDecisionTrace(
  input: EvaluateDecisionTraceInput
): Promise<DecisionTraceResult> {
  const { data, error } = await input.db
    .from("agents")
    .select(TRACE_AGENT_COLUMNS)
    .eq("user_id", input.userId)
    .eq("id", input.agentId)
    .maybeSingle();

  if (error) return { ok: false, status: 500, code: "query_failed" };
  if (!data) return { ok: false, status: 404, code: "not_found" };
  if (!isRecord(data)) return { ok: false, status: 500, code: "query_failed" };
  const agent = data as unknown as TraceAgentRow;

  const [killState, suspended, budgetSnapshot, currentPolicy, grant] = await Promise.all([
    readKillState(input.userId),
    isSuspended(input.agentId),
    readBudgetSnapshot(input.agentId),
    readCurrentAgentPolicy(input.db, input.userId, input.agentId, { cacheOnMiss: false }),
    // Null on any failure, as everywhere else this is read: for break-glass,
    // closed means no elevation.
    readLiveGrant(input.db, input.userId, input.agentId),
  ]);
  const path = defaultChatPath(input.provider);
  const budget = projectBudget(
    agent,
    budgetSnapshot,
    input.provider,
    input.model,
    input.maxOutputTokens ?? null
  );
  const gateInput = {
    agentId: input.agentId,
    killState,
    suspended,
    // What a visa minted right now would actually carry — the challenge route
    // does the same union. Using allowed_scopes alone would make this simulator
    // disagree with the gateway for the whole duration of an elevation.
    scopes: grant
      ? unionScopes(scopes(agent.allowed_scopes), grant.scopes)
      : scopes(agent.allowed_scopes),
    provider: input.provider,
    method: "POST",
    path,
    model: input.model,
    policy:
      currentPolicy === POLICY_UNREADABLE
        ? ({ kind: POLICY_UNREADABLE } as const)
        : ({ kind: "value", value: currentPolicy } as const),
    policyFailClosed: process.env.POLICY_FAIL_CLOSED === "true",
    now: input.policyAt,
    budget,
  };

  const preliminary = evaluateGate(gateInput);
  const policyRateLimit =
    preliminary.policyRateLimitRequired === null || preliminary.deniedBy
      ? undefined
      : await peekRateLimit(
          `policy-hour:${input.userId}:${input.agentId}`,
          preliminary.policyRateLimitRequired
        );
  const gate = evaluateGate({ ...gateInput, ...(policyRateLimit ? { policyRateLimit } : {}) });

  return {
    ok: true,
    trace: {
      snapshot: true,
      evaluated_at: input.evaluatedAt.toISOString(),
      policy_time: input.policyAt.toISOString(),
      agent_id: input.agentId,
      provider: input.provider,
      model: input.model,
      method: "POST",
      path,
      verdict: gate.verdict,
      ...(grant ? { break_glass: { expires_at: grant.expiresAt, reason: grant.reason } } : {}),
      ...(gate.deniedBy ? { denied_by: gate.deniedBy } : {}),
      ...(gate.policy ? { policy: gate.policy } : {}),
      steps: gate.steps,
    },
  };
}
