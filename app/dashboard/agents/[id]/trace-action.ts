"use server";

import { needsMfaStepUp } from "@/lib/mfa";
import { isScopeProvider } from "@/lib/providers";
import { rateLimit } from "@/lib/ratelimit";
import { userClient } from "@/lib/supabase/server";
import {
  evaluateDecisionTrace,
  type DecisionTrace,
} from "@/app/api/control/v1/agents/[id]/trace/decision-trace";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const TRACE_RATE_LIMIT = 30;
const TRACE_RATE_WINDOW_S = 60;

export interface DecisionTraceActionState {
  trace?: DecisionTrace;
  error?: string;
}

export async function runDecisionTrace(
  agentId: string,
  _previousState: DecisionTraceActionState | undefined,
  formData: FormData
): Promise<DecisionTraceActionState> {
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) return { error: "Sign in again to run a decision trace." };
  if (await needsMfaStepUp(db)) return { error: "Complete MFA verification to run a trace." };

  if (!UUID_RE.test(agentId)) return { error: "This agent is unavailable." };
  const providerRaw = String(formData.get("provider") ?? "");
  const model = String(formData.get("model") ?? "").trim();
  if (!isScopeProvider(providerRaw) || !model || model.length > 200) {
    return { error: "Choose a provider and enter a model name." };
  }

  // Minimum mutation required to make the read-only trace non-probeable. It is
  // isolated from policy-hour, budget, spend, nonce, cache, and log namespaces.
  const limited = await rateLimit(
    `decision-trace:${user.id}`,
    TRACE_RATE_LIMIT,
    TRACE_RATE_WINDOW_S
  );
  if (!limited.success) return { error: "Too many traces. Wait a minute and try again." };

  // Optional. Blank means "project the gateway's own default", which is what
  // this panel has always done — and is exact for a call that names no maximum.
  let maxOutputTokens: number | null = null;
  const maxRaw = String(formData.get("max_tokens") ?? "").trim();
  if (maxRaw) {
    const parsedMax = Number(maxRaw);
    if (!Number.isFinite(parsedMax) || parsedMax < 1 || parsedMax > 10_000_000) {
      return { error: "Enter a max output size between 1 and 10,000,000, or leave it blank." };
    }
    maxOutputTokens = Math.floor(parsedMax);
  }

  const evaluatedAt = new Date();
  let policyAt = evaluatedAt;
  const timestamp = String(formData.get("timestamp") ?? "").trim();
  if (timestamp) {
    if (!UTC_LOCAL_RE.test(timestamp)) return { error: "Enter a valid UTC date and time." };
    policyAt = new Date(`${timestamp}:00.000Z`);
    if (!Number.isFinite(policyAt.getTime())) {
      return { error: "Enter a valid UTC date and time." };
    }
  }

  const result = await evaluateDecisionTrace({
    db,
    userId: user.id,
    agentId,
    provider: providerRaw,
    model,
    maxOutputTokens,
    evaluatedAt,
    policyAt,
  });
  if (!result.ok) {
    return {
      error:
        result.status === 404
          ? "This agent is unavailable."
          : "The snapshot could not be evaluated. Try again.",
    };
  }
  return { trace: result.trace };
}
