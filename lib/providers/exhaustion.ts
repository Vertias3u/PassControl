// Did this upstream error mean "the account is out of credit"?
//
// There is no uniform signal for that across providers, and the differences are
// not cosmetic:
//
//   - OpenAI answers 429 for BOTH a transient rate limit and permanent quota
//     exhaustion. Only `error.code` separates them.
//   - Anthropic answers 400 for low credit — the same status and the same
//     `invalid_request_error` type as a malformed request. Only the message
//     differs.
//   - DeepSeek answers 402.
//
// So the table below is an allowlist of exact signatures, and **anything that
// does not match returns null**, which leaves the proxy's existing behaviour —
// pass the upstream error through untouched — completely unchanged. That default
// is the safety property: a misfire here does not produce a wrong error, it
// produces a call routed to a second provider that was never going to help, or
// an agent abandoning a provider it should have waited one second for.
//
// The Anthropic message match is the only free-text rule, and it exists because
// Anthropic publishes no distinct code for the case. It is provider-controlled
// text and can change without notice; if it does, the rule stops matching and
// the gateway reverts to today's behaviour rather than misclassifying. Failing
// back to "unknown" is the only acceptable direction for this to break in.
import { type ProviderId } from "../providers";

export type UpstreamFailure = "credit_exhausted";

interface ExhaustionRule {
  status: number;
  /** Matched against `error.code`, then `error.type`, when present. */
  code?: string;
  /** Only for providers that publish no distinct code. Matched case-insensitively. */
  message?: RegExp;
}

// Providers absent from this map have no verified signature yet. That is stated
// as an empty list rather than left implicit, so adding one is a deliberate edit
// with a fixture beside it — not something that happens by accident.
const RULES: Record<ProviderId, readonly ExhaustionRule[]> = {
  openai: [{ status: 429, code: "insufficient_quota" }],
  anthropic: [{ status: 400, message: /credit balance is too low/i }],
  deepseek: [{ status: 402, message: /insufficient balance/i }],
  groq: [],
  mistral: [],
  together: [],
};

function errorObject(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return null;
    const error = (parsed as Record<string, unknown>).error;
    return error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Whether the proxy should read this error body at all.
 *
 * This is the boundary of the behaviour change, not an optimisation. Today the
 * proxy returns the upstream body as a stream; reading it to classify turns that
 * into a buffered response. Every status not named here keeps streaming through
 * unread, so the untouched path stays structurally untouched rather than
 * merely asserted-unchanged in a test.
 */
export function isClassifiableStatus(provider: ProviderId, status: number): boolean {
  return RULES[provider].some((rule) => rule.status === status);
}

/** The failure this body describes, or null — null meaning "behave as before". */
export function classifyUpstreamFailure(
  provider: ProviderId,
  status: number,
  body: string
): UpstreamFailure | null {
  const rules = RULES[provider].filter((rule) => rule.status === status);
  if (rules.length === 0) return null;

  const error = errorObject(body);
  if (!error) return null;
  const code = typeof error.code === "string" ? error.code : null;
  const type = typeof error.type === "string" ? error.type : null;
  const message = typeof error.message === "string" ? error.message : "";

  for (const rule of rules) {
    if (rule.code && rule.code !== code && rule.code !== type) continue;
    if (rule.message && !rule.message.test(message)) continue;
    return "credit_exhausted";
  }
  return null;
}
