// What a recorded call's status MEANS to the operator reading it — one
// vocabulary for the board, the history table, the call drawer, the status pill
// and the agent page (v1 playbook Session 06, Contract D).
//
// Before this module each of those surfaces carried its own words, and they
// disagreed in ways that sent people to the wrong place: a Direct Agent Key's
// scope refusal read "NO VISA" (it presented no visa), a provider's 401 read
// "DIVERTED", and `blocked_budget_state` — PassControl failing to read its own
// counters — was counted among deliberate refusals because its name starts with
// `blocked_`. The categories below are what an operator acts on; the per-status
// labels say which one of them happened.
//
// A Record over LogEntry["status"] for the same reason as StatusPill's map: a
// new audit status cannot ship without a word here.
import type { AuthMethod, LogEntry } from "@/lib/log";

export type OutcomeCategory =
  /** Passed every check and reached the provider, which answered with usage. */
  | "forwarded"
  /** Reached the provider; no usage report came back. */
  | "usage_unconfirmed"
  /** Refused on purpose: outside what the agent is allowed to reach. */
  | "refused_access"
  /** Refused on purpose: a live policy rule. */
  | "refused_policy"
  /** Refused on purpose: a cap, or a cap that cannot be priced for this destination. */
  | "refused_budget"
  /** Refused by a stop control: suspension or kill switch. */
  | "stopped"
  /** Forwarded, and the provider answered with an error. */
  | "provider_failure"
  /** Never forwarded: this workspace has not stored what the call needs. */
  | "setup_incomplete"
  /** Never forwarded: PassControl could not complete its own checks. */
  | "passcontrol_side";

export const OUTCOME_CATEGORY_LABEL: Record<OutcomeCategory, string> = {
  forwarded: "Allowed and forwarded",
  usage_unconfirmed: "Sent, usage unconfirmed",
  refused_access: "Refused: outside allowed access",
  refused_policy: "Refused: policy rule",
  refused_budget: "Refused: budget",
  stopped: "Stopped by a control",
  provider_failure: "Provider failure",
  setup_incomplete: "Setup incomplete",
  passcontrol_side: "Not sent: PassControl side",
};

/**
 * Status → category and the plain primary label. The label is what a surface
 * shows first; the aviation words on the departures board are a motif beside
 * it, not a replacement for it.
 */
export const CALL_OUTCOME: Record<LogEntry["status"], { category: OutcomeCategory; label: string }> = {
  ok: { category: "forwarded", label: "Allowed and forwarded" },
  usage_unknown: { category: "usage_unconfirmed", label: "Sent, usage unconfirmed" },
  blocked_scope: { category: "refused_access", label: "Outside allowed access" },
  blocked_endpoint: { category: "refused_access", label: "Endpoint not allowed" },
  blocked_policy: { category: "refused_policy", label: "Blocked by a policy rule" },
  blocked_budget: { category: "refused_budget", label: "Blocked by a budget cap" },
  blocked_budget_period: { category: "refused_budget", label: "Blocked by the daily/monthly limit" },
  // A configuration answer, not a spend answer: the agent is not out of money,
  // its dollar cap cannot be enforced against a destination nobody can price.
  blocked_unpriced_endpoint: { category: "refused_budget", label: "Cost cap cannot be priced here" },
  blocked_unpriced_model: { category: "refused_budget", label: "Cost cap cannot price this model" },
  blocked_suspended: { category: "stopped", label: "Stopped: agent suspended" },
  blocked_killed: { category: "stopped", label: "Stopped: kill switch" },
  upstream_error: { category: "provider_failure", label: "Provider error" },
  // The provider's own balance, not a PassControl cap.
  provider_exhausted: { category: "provider_failure", label: "Provider credit exhausted" },
  // A setup gap here, not a fault out there — the call never left.
  no_provider_key: { category: "setup_incomplete", label: "No provider key stored" },
  endpoint_unavailable: { category: "passcontrol_side", label: "Not sent: endpoint lookup failed" },
  endpoint_required: { category: "setup_incomplete", label: "Not sent: this key has no resource address" },
  credential_state_unavailable: { category: "passcontrol_side", label: "Not sent: credential check unavailable" },
  // An observation, not a failure: an operator changed the credential while
  // this call was being assembled. A retry gets a matching pair.
  credential_changed: { category: "passcontrol_side", label: "Not sent: credential changed mid-call" },
  blocked_budget_state: { category: "passcontrol_side", label: "Not sent: budget state unavailable" },
  dispatch_unavailable: { category: "passcontrol_side", label: "Not sent: dispatch unconfirmed" },
};

export interface CallOutcome {
  category: OutcomeCategory;
  label: string;
  /** False for a status this build does not know: shown verbatim, never reinterpreted. */
  known: boolean;
}

export function callOutcome(status: string | null | undefined): CallOutcome {
  const known = CALL_OUTCOME[status as LogEntry["status"]];
  if (known) return { ...known, known: true };
  // Unknown is not "refused" and not "failed": it is a status this dashboard
  // cannot read, so it goes in the one bucket that makes no claim about why.
  return { category: "passcontrol_side", label: status ? `Unrecognised status: ${status}` : "Status not recorded", known: false };
}

/** A refusal PassControl made on purpose, as opposed to one it could not avoid. */
export function isDeliberateRefusal(category: OutcomeCategory): boolean {
  return (
    category === "refused_access" ||
    category === "refused_policy" ||
    category === "refused_budget" ||
    category === "stopped"
  );
}

/** Whether the request left the gateway for the provider at all. */
export function wasForwarded(category: OutcomeCategory): boolean {
  return category === "forwarded" || category === "usage_unconfirmed" || category === "provider_failure";
}

/**
 * The scope-refusal explanation, by credential. A Direct Agent Key is checked
 * against the agent's CURRENT access on every request; a passport work-visa
 * carries the access it was issued with. "The visa's snapshot" on a Direct
 * Agent Key row described a credential that was never presented.
 */
export function scopeRefusalExplanation(authMethod: AuthMethod | null | undefined): string {
  if (authMethod === "direct_key") {
    return "This agent's allowed access, read when the request arrived, did not include this provider and model. Nothing was forwarded.";
  }
  if (authMethod === "passport" || authMethod === "passport_proof_per_request") {
    return "The work-visa presented carries the access it was issued with, and that access did not include this provider and model. Nothing was forwarded.";
  }
  return "The agent's allowed access did not include this provider and model. This older row does not record which credential was presented. Nothing was forwarded.";
}

// ── Figures an operator can trust on a row ─────────────────────────────────

export type ReportedTokens =
  /** Not forwarded: there was nothing to measure, and the stored zeros are not a measurement. */
  | { kind: "not_sent" }
  /** Forwarded, and the provider's usage report arrived. `total` may genuinely be 0. */
  | { kind: "reported"; total: number }
  /** Forwarded, one side of the count recorded. */
  | { kind: "partial"; known: number }
  /** Forwarded, nothing recorded (older row). */
  | { kind: "not_reported" }
  /** Forwarded, no usage report came back. `observed` is what was seen before it broke. */
  | { kind: "unconfirmed"; observed: number };

export function reportedTokens(row: {
  status: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
}): ReportedTokens {
  const { category } = callOutcome(row.status);
  if (!wasForwarded(category)) return { kind: "not_sent" };
  const input = row.input_tokens;
  const output = row.output_tokens;
  if (category === "usage_unconfirmed") return { kind: "unconfirmed", observed: (input ?? 0) + (output ?? 0) };
  // A provider error carries no usage by construction (the proxy settles it
  // with none), so its zeros are not a report either.
  if (category === "provider_failure") return { kind: "not_sent" };
  if (input == null && output == null) return { kind: "not_reported" };
  if (input == null || output == null) return { kind: "partial", known: (input ?? 0) + (output ?? 0) };
  return { kind: "reported", total: input + output };
}

export function reportedTokensText(tokens: ReportedTokens): string {
  switch (tokens.kind) {
    case "not_sent":
      return "—";
    case "reported":
      return tokens.total.toLocaleString("en-US");
    case "partial":
      return `${tokens.known.toLocaleString("en-US")} + not reported`;
    case "not_reported":
      return "Not reported";
    case "unconfirmed":
      return tokens.observed > 0 ? `${tokens.observed.toLocaleString("en-US")} seen · unconfirmed` : "Unconfirmed";
  }
}

/**
 * What a row can say about its charge against the agent's cap.
 *
 * `enforced_*` is written only when the enforced figure DIFFERS from the
 * observed one, and is also absent when a settlement was refused (the hold
 * stays open) or on rows written before migration 0055. So on a
 * `usage_unknown` row — the one shape where the observed figures are known not
 * to be the whole story — absence cannot be read as "charged the observed
 * amount". Everywhere else the observed figure is the charge, exactly as the
 * spend view (0056) computes it.
 */
export type CapCharge =
  | { kind: "none" }
  | { kind: "charged"; microcents: number; tokens: number; enforcedDiffers: boolean }
  | { kind: "not_recorded" }
  | { kind: "held" };

export function capCharge(row: {
  status: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_microcents: number | null;
  enforced_tokens?: number | null;
  enforced_microcents?: number | null;
}): CapCharge {
  // Not sent, and its reservation deliberately left in place — see the
  // dispatch_unavailable explanation. Nothing settled, nothing returned.
  if (row.status === "dispatch_unavailable") return { kind: "held" };
  if (row.status !== "ok" && row.status !== "usage_unknown") return { kind: "none" };
  const enforcedTokens = row.enforced_tokens ?? null;
  const enforcedMicrocents = row.enforced_microcents ?? null;
  if (row.status === "usage_unknown" && enforcedTokens == null && enforcedMicrocents == null) {
    return { kind: "not_recorded" };
  }
  const observedTokens = (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
  return {
    kind: "charged",
    tokens: Math.max(0, observedTokens, enforcedTokens ?? 0),
    microcents: Math.max(0, row.cost_microcents ?? 0, enforcedMicrocents ?? 0),
    enforcedDiffers: enforcedTokens != null || enforcedMicrocents != null,
  };
}

/** The short usage word the board and drawer show beside the figures. */
export function usageLabel(row: { status: string | null; enforced_tokens?: number | null; enforced_microcents?: number | null }): string {
  const { category } = callOutcome(row.status);
  if (row.status === "dispatch_unavailable") return "Not sent · reservation held";
  if (category === "forwarded") return "Reported";
  if (category === "usage_unconfirmed") {
    return row.enforced_tokens != null || row.enforced_microcents != null
      ? "Unconfirmed · reserve charged"
      : "Unconfirmed · charge not recorded";
  }
  if (category === "provider_failure") return "No usage · not charged";
  return "Not sent · not charged";
}
