
type OperationsQuota = null;

export interface CloudFailureGuideItem {
  title: string;
  codes: readonly string[];
  meaning: string;
  action: string;
}

/** The wire and stored refusal vocabulary, translated without conflating gates. */
export const CLOUD_FAILURE_GUIDE: readonly CloudFailureGuideItem[] = [
  {
    title: "Burst protection",
    codes: ["rate_limited"],
    meaning: "Too many calls arrived in the short rate-limit window.",
    action: "Back off with jitter and retry; the monthly allowance is a separate limit.",
  },
  {
    title: "Authentication limiter unavailable",
    codes: ["authentication_rate_limit_unavailable"],
    meaning: "The pre-authentication abuse limiter could not answer and failed closed.",
    action: "Retry later; do not rotate a valid credential solely for this response.",
  },
  {
    title: "Agent budget",
    codes: ["blocked_budget"],
    meaning: "The agent reached its PassControl token or cost budget before provider dispatch.",
    action: "Review reconciled spend, then deliberately raise or reset that agent’s budget if appropriate.",
  },
  {
    title: "Agent suspended",
    codes: ["blocked_suspended"],
    meaning: "This individual agent is suspended and every new call is refused.",
    action: "Inspect the agent and reactivate it only if the suspension is no longer required.",
  },
  {
    title: "Kill switch armed",
    codes: ["blocked_killed"],
    meaning: "A workspace, platform, or denylist emergency control stopped the call.",
    action: "Find the armed emergency control; do not bypass it by changing scopes or budgets.",
  },
  {
    title: "Credential rejected",
    codes: ["invalid_credential", "invalid_visa"],
    meaning: "The presented Direct Agent Key or signed visa is invalid, expired, or revoked.",
    action: "Check the configured credential and gateway URL, then issue a replacement only if needed.",
  },
  {
    title: "Authentication service unavailable",
    codes: ["authentication_unavailable"],
    meaning: "PassControl could not verify the credential against trusted state and failed closed.",
    action: "Retry after service recovery; a new credential will not repair a database outage.",
  },
] as const;

export type ConfigurationSignal = "configured" | "missing" | "available" | "unavailable";

export interface CloudOperationsSignals {
  providerCredentials: ConfigurationSignal;
  receiptSigning: ConfigurationSignal;
  observability: ConfigurationSignal;
  agentRegistry: ConfigurationSignal;
  activityLog: ConfigurationSignal;
}

/**
 * Controls whether the collapsed operations appendix should call for attention.
 * Missing optional setup is informative, not an incident. Only a broken read,
 * missing receipt signer, or constrained shared/workspace capacity opens it.
 */
// `quota` is null wherever there is no hosted allowance to report — every
// self-hosted deployment. The signal checks below are Core's own and run either
// way; only the three capacity checks depend on a hosted counter existing. Same
// shape as the optional Cloud contributor in lib/problem-diagnostics.ts.
export function cloudOperationsNeedsAttention(
  quota: OperationsQuota,
  signals: CloudOperationsSignals
): boolean {
  return signals.receiptSigning === "missing"
    || signals.receiptSigning === "unavailable"
    || signals.agentRegistry === "unavailable"
    || signals.activityLog === "unavailable";
}

interface BuildSupportBundleInput {
  generatedAt: string;
  quota: OperationsQuota;
  signals: CloudOperationsSignals;
  controls: { workspaceKillArmed: boolean; platformKillArmed: boolean };
  agents: readonly Record<string, unknown>[];
  logs: readonly Record<string, unknown>[];
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function summarizeAgent(row: Record<string, unknown>) {
  const scopes = array(row.allowed_scopes);
  const modelPatternCount = scopes.reduce<number>((total, entry) => {
    const models = array(object(entry)?.models);
    return total + models.length;
  }, 0);
  const providers = new Set(
    scopes
      .map((entry) => text(object(entry)?.provider))
      .filter((provider): provider is string => provider !== null)
  );
  const policy = object(row.policy);
  const passport = text(row.passport_pubkey);
  return {
    id: text(row.id) ?? "unknown",
    name: text(row.name) ?? "Unnamed agent",
    status: text(row.status) ?? "unknown",
    passport: {
      attached: passport !== null,
      public_key_suffix: passport?.slice(-8) ?? null,
      expires_at: text(row.expires_at),
      previous_key_valid_until: text(row.previous_valid_until),
    },
    budget: {
      token_limit: finite(row.budget_tokens),
      cost_limit_cents: finite(row.budget_cents),
      reconciled_tokens: finite(row.spent_tokens) ?? 0,
      reconciled_cost_microcents: finite(row.spent_microcents) ?? 0,
    },
    scopes: {
      provider_count: providers.size,
      entry_count: scopes.length,
      model_pattern_count: modelPatternCount,
    },
    fallbacks: { count: array(row.fallbacks).length },
    policy: {
      configured: policy !== null && Object.keys(policy).length > 0,
      deny_rule_count: array(policy?.deny).length,
      has_time_window: array(policy?.windows).length > 0,
      has_hourly_cap: finite(policy?.max_requests_per_hour) !== null,
    },
    shadow_policy: { configured: object(row.policy_shadow) !== null },
    created_at: text(row.created_at),
    last_seen_at: text(row.last_seen_at),
  };
}

function summarizeFailures(rows: readonly Record<string, unknown>[]) {
  const grouped = new Map<string, {
    code: string;
    agent_id: string | null;
    provider: string | null;
    count: number;
    latest_at: string | null;
  }>();
  for (const row of rows) {
    const code = text(row.status);
    if (!code || code === "ok") continue;
    const agentId = text(row.agent_id);
    const provider = text(row.provider);
    const key = JSON.stringify([code, agentId, provider]);
    const createdAt = text(row.created_at);
    const prior = grouped.get(key);
    if (prior) {
      prior.count += 1;
      if (createdAt && (!prior.latest_at || createdAt > prior.latest_at)) prior.latest_at = createdAt;
    } else {
      grouped.set(key, { code, agent_id: agentId, provider, count: 1, latest_at: createdAt });
    }
  }
  return [...grouped.values()]
    .sort((a, b) => (b.latest_at ?? "").localeCompare(a.latest_at ?? ""))
    .slice(0, 50);
}

/**
 * Constructs a support artifact from explicit safe fields. It never clones or
 * serializes a database row, so future secret-bearing columns cannot leak by
 * being added to a SELECT or to the row type.
 */
export function buildCloudSupportBundle(input: BuildSupportBundleInput) {
  return {
    schema_version: 1,
    generated_at: input.generatedAt,
    notice: "Redacted operational metadata. No prompts, receipts, provider keys, or raw credentials.",
    // Omitted, not nulled, when there is no hosted allowance — the same choice
    // ProblemSupportBundle already makes for the same two fields
    // (lib/problem-diagnostics.ts: `quota?`, `quota_counter?`). Two bundles
    // disagreeing about how "no Cloud contribution" is spelled is how a reader
    // ends up believing one of them is broken.
    service_health: {
      agent_registry: input.signals.agentRegistry,
      activity_log: input.signals.activityLog,
    },
    configuration_signals: {
      provider_credentials: input.signals.providerCredentials,
      receipt_signing: input.signals.receiptSigning,
      observability: input.signals.observability,
    },
    emergency_controls: input.controls,
    agents: input.agents.map(summarizeAgent),
    recent_failures: summarizeFailures(input.logs),
  };
}

export type CloudSupportBundle = ReturnType<typeof buildCloudSupportBundle>;
