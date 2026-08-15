// The per-agent fallback list, parsed out of untrusted jsonb.
//
// `agents.fallbacks` is granted to `authenticated` (migration 0018) so the
// dashboard editor can write it, which means a tenant can also PATCH arbitrary
// jsonb straight into the column through PostgREST, bypassing validateFallbacks.
// This parser is the gateway's boundary against that — the same job parsePolicy
// does for `agents.policy`.
//
// Two rules do the work:
//
//   1. **Never throw, always return a list.** An unparseable list means "no
//      failover", which is exactly the behaviour the gateway had before this
//      feature. Note this is the OPPOSITE posture from policy, which fails
//      closed on malformed input: policy is a restriction, so an unreadable one
//      must not silently permit; a fallback list is an enhancement, so an
//      unreadable one must not silently fail a call.
//
//   2. **One bad entry rejects the whole list.** A partially honoured list means
//      the gateway is failing over somewhere the operator's screen does not
//      show. Half-understood configuration is worse than none.
//
// Nothing here grants capability. Every entry is re-checked against scope,
// policy, budget and the kill switch on the attempt that uses it.
import { isProvider, type ProviderId } from "../providers";
import { classifyUpstreamFailure } from "./exhaustion";

/**
 * Why one attempt gave way to another. An allowlisted enum, never free text —
 * it becomes a receipt claim a third party reads.
 *
 * The split that matters to a reader is which of these could have been BILLED:
 *
 *   credit_exhausted, rate_limited  — the provider refused before doing work.
 *   upstream_5xx, unreachable       — the provider MAY have run and charged the
 *                                     call. `unreachable` cannot even tell
 *                                     "never sent" from "sent, no answer".
 *
 * So a failover on either of the second pair can mean two providers bill for one
 * client request, and the gateway has no way to detect it. That exposure is
 * accepted only on the condition that it is always legible; this claim is what
 * makes that possible in the receipt.
 */
export type FailoverReason = "credit_exhausted" | "rate_limited" | "upstream_5xx" | "unreachable";

/**
 * Whether an upstream response may be retried on another provider — an
 * allowlist, never "not 2xx".
 *
 * A 400 from a malformed request must never retry: the second provider gets the
 * same broken call and a second key is spent on the same failure. Same for 401,
 * 403 and 404, which say something about the request or the key, not about the
 * provider's availability.
 */
export function failoverReasonFor(
  provider: ProviderId,
  status: number,
  body: string
): FailoverReason | null {
  if (classifyUpstreamFailure(provider, status, body) === "credit_exhausted") {
    return "credit_exhausted";
  }
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "upstream_5xx";
  return null;
}

/** The two reasons where the previous attempt may already have been billed. */
export function mayHaveBeenBilled(reason: FailoverReason): boolean {
  return reason === "upstream_5xx" || reason === "unreachable";
}

export interface FallbackEntry {
  provider: ProviderId;
  model: string;
}

/** Hard cap on how far one client request may fan out across providers. */
export const MAX_FALLBACKS = 3;

/**
 * Exported so `validateFallbacks` can bound the write path with the SAME number
 * the gateway bounds the read path with. Typing it twice is how the two drift,
 * and drift here has a nasty shape: this parser rejects the WHOLE list on any
 * violation, so a validator that accepts one model string longer than this lets
 * an operator save a list the gateway then honours none of.
 */
export const MAX_FALLBACK_MODEL_LEN = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseFallbacks(value: unknown): FallbackEntry[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_FALLBACKS) return [];

  const entries: FallbackEntry[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return [];
    if (Object.keys(candidate).some((key) => key !== "provider" && key !== "model")) return [];
    const { provider, model } = candidate;
    if (typeof provider !== "string" || !isProvider(provider)) return [];
    if (typeof model !== "string") return [];
    const trimmed = model.trim();
    if (!trimmed || trimmed.length > MAX_FALLBACK_MODEL_LEN) return [];
    // A fallback names a model to CALL. `*` and `llama-*` are scope patterns —
    // legitimate in allowed_scopes, meaningless to send upstream.
    if (trimmed.includes("*")) return [];
    entries.push({ provider, model: trimmed });
  }
  return entries;
}
