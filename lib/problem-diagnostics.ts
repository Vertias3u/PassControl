/**
 * The diagnostic artifact attached to a problem report.
 *
 * ── Why the Cloud contribution is a seam ──
 *
 * The artifact is useful to every operator: it summarizes agents, budgets,
 * failure codes, emergency controls and instance configuration from explicit
 * safe fields. The hosted distribution adds two things to that generic
 * artifact: its quota snapshot and the existing hosted bundle shape. Both sit
 * behind one narrow contributor so the self-host build has no Cloud dependency
 * while the hosted build keeps the artifact it already emits.
 *
 * What it does NOT record is the window it was built over. Two bundles taken
 * across different spans look identical and compare falsely, which is a real
 * hazard once an operator is holding one from a report and one from a download.
 * The `scan` block here says so explicitly.
 *
 * ── Why the window is 7 days and not the dashboard's 30 ──
 *
 * The dashboard's 30-day / 2,000-row scan exists for buildFleetAttention, not
 * for the bundle. summarizeFailures emits grouped, top-50 non-ok rows, so a
 * tighter bound loses almost nothing and keeps a page that anyone can open from
 * costing what the Control Tower costs.
 *
 * ── Why the instance stamp is separate from the bundle ──
 *
 * `readInstanceStamp` describes OUR deployment, not the reporter's workspace.
 * It is recorded on every report whether or not workspace diagnostics were
 * consented to, because consent is about the reporter's data. It is also the
 * reason problem_reports is server-read-only: those columns are what
 * /dashboard/system restricts to named operators.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { readKillState } from "@/lib/state/killswitch";
import { loadInstanceSigner, instanceIssuer } from "@/lib/crypto/instanceKey";
import { isSentryConfigured } from "@/lib/observability";
import { RELEASE_VERSION } from "@/lib/version";
import { releaseChannel, releaseCommit } from "@/lib/system-health/build-identity-values";
import { getCachedMigrationHealth } from "@/lib/system-health/cache";

export const DIAGNOSTIC_SCAN_DAYS = 7;
export const DIAGNOSTIC_SCAN_LIMIT = 200;
/** Mirrors the check constraint in 0038. A free tier is not a blob store. */
export const DIAGNOSTIC_MAX_BYTES = 262_144;

export type DiagnosticConfigurationSignal =
  | "configured"
  | "missing"
  | "available"
  | "unavailable";

export interface ProblemDiagnosticSignals {
  providerCredentials: DiagnosticConfigurationSignal;
  receiptSigning: DiagnosticConfigurationSignal;
  observability: DiagnosticConfigurationSignal;
  agentRegistry: DiagnosticConfigurationSignal;
  activityLog: DiagnosticConfigurationSignal;
}

export interface ProblemSupportBundle {
  schema_version: number;
  generated_at: string;
  notice: string;
  quota?: unknown;
  service_health: {
    quota_counter?: string;
    agent_registry: DiagnosticConfigurationSignal;
    activity_log: DiagnosticConfigurationSignal;
  };
  configuration_signals: {
    provider_credentials: DiagnosticConfigurationSignal;
    receipt_signing: DiagnosticConfigurationSignal;
    observability: DiagnosticConfigurationSignal;
  };
  emergency_controls: {
    workspaceKillArmed: boolean;
    platformKillArmed: boolean;
  };
  agents: ReturnType<typeof summarizeAgent>[];
  recent_failures: ReturnType<typeof summarizeFailures>;
}

export interface ProblemBundleInput {
  generatedAt: string;
  signals: ProblemDiagnosticSignals;
  controls: ProblemSupportBundle["emergency_controls"];
  agents: readonly Record<string, unknown>[];
  logs: readonly Record<string, unknown>[];
}

export interface CloudDiagnosticsContributor {
  readQuota(userId: string, now: Date): Promise<unknown>;
  buildBundle(input: ProblemBundleInput, quota: unknown): ProblemSupportBundle;
}

const LOG_COLUMNS =
  "id, agent_id, user_id, created_at, passport_id, jti, auth_method, agent_access_key_id, credential_use_id, provider, model, input_tokens, output_tokens, cost_microcents, status, latency_ms, policy_shadow_would";

/**
 * Narrow on purpose. summarizeAgent is allowlist-based, so `select("*")` would
 * be safe by construction the way the dashboard's is — but a file whose whole
 * claim is "this cannot leak a new column" reads better when the SELECT cannot
 * fetch one either. `receipt` is absent from LOG_COLUMNS for the same reason:
 * summarizeFailures never looks at it, and it has no business being fetched.
 */
const AGENT_COLUMNS =
  "id, name, status, passport_pubkey, expires_at, previous_valid_until, allowed_scopes, fallbacks, policy, policy_shadow, budget_tokens, budget_cents, spent_tokens, spent_microcents, created_at, last_seen_at";

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
  const grouped = new Map<
    string,
    {
      code: string;
      agent_id: string | null;
      provider: string | null;
      count: number;
      latest_at: string | null;
    }
  >();
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
      if (createdAt && (!prior.latest_at || createdAt > prior.latest_at)) {
        prior.latest_at = createdAt;
      }
    } else {
      grouped.set(key, {
        code,
        agent_id: agentId,
        provider,
        count: 1,
        latest_at: createdAt,
      });
    }
  }
  return [...grouped.values()]
    .sort((a, b) => (b.latest_at ?? "").localeCompare(a.latest_at ?? ""))
    .slice(0, 50);
}

function buildGenericSupportBundle(input: ProblemBundleInput): ProblemSupportBundle {
  return {
    schema_version: 1,
    generated_at: input.generatedAt,
    notice:
      "Redacted operational metadata. No prompts, receipts, provider keys, or raw credentials.",
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

const noCloudDiagnosticsContributor: CloudDiagnosticsContributor = {
  async readQuota() {
    return undefined;
  },
  buildBundle(input) {
    return buildGenericSupportBundle(input);
  },
};

let defaultDiagnosticsContributor = noCloudDiagnosticsContributor;


export interface ProblemDiagnostics {
  artifact_version: 1;
  source: "problem_report";
  scan: {
    since: string;
    until: string;
    log_rows: number;
    log_row_limit: number;
    truncated: boolean;
  };
  bundle: ProblemSupportBundle;
}

export interface InstanceStamp {
  app_version: string | null;
  release_channel: string | null;
  build_commit: string | null;
  schema_head: string | null;
  schema_state: string | null;
}

/**
 * Build the artifact from the reporter's OWN data, through the RLS client, so
 * the tenant boundary is enforced by the database rather than by a filter this
 * function remembers to apply.
 */
export async function buildProblemDiagnostics(
  db: SupabaseClient,
  user: User,
  now: Date,
  contributor: CloudDiagnosticsContributor | null = defaultDiagnosticsContributor
): Promise<ProblemDiagnostics> {
  const selectedContributor = contributor ?? noCloudDiagnosticsContributor;
  const since = new Date(now.getTime() - DIAGNOSTIC_SCAN_DAYS * 86_400_000).toISOString();

  const [{ data: agents, error: agentsError }, { data: logs, error: logsError }, providerKeys, quota, kill] =
    await Promise.all([
      db.from("agents").select(AGENT_COLUMNS).order("created_at", { ascending: false }).limit(200),
      db
        .from("agent_logs")
        .select(LOG_COLUMNS)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(DIAGNOSTIC_SCAN_LIMIT),
      db.from("provider_credentials").select("provider", { count: "exact", head: true }),
      selectedContributor.readQuota(user.id, now),
      readKillState(user.id),
    ]);

  const logRows = logs ?? [];
  const signals: ProblemDiagnosticSignals = {
    providerCredentials: providerKeys.error ? "unavailable" : (providerKeys.count ?? 0) > 0 ? "configured" : "missing",
    receiptSigning: loadInstanceSigner() && instanceIssuer() ? "configured" : "missing",
    observability: isSentryConfigured() ? "configured" : "missing",
    agentRegistry: agentsError ? "unavailable" : "available",
    activityLog: logsError ? "unavailable" : "available",
  };

  return {
    artifact_version: 1,
    source: "problem_report",
    scan: {
      since,
      until: now.toISOString(),
      log_rows: logRows.length,
      log_row_limit: DIAGNOSTIC_SCAN_LIMIT,
      // An operator reading "50 failures" needs to know whether that was all of
      // them or the first page of far more.
      truncated: logRows.length >= DIAGNOSTIC_SCAN_LIMIT,
    },
    bundle: selectedContributor.buildBundle(
      {
        generatedAt: now.toISOString(),
        signals,
        controls: { workspaceKillArmed: kill.userKill, platformKillArmed: kill.platformKill },
        agents: (agents ?? []) as Record<string, unknown>[],
        logs: logRows as Record<string, unknown>[],
      },
      quota
    ),
  };
}

/**
 * Which build of PassControl the report was filed against.
 *
 * Degrades to nulls rather than throwing. getCachedMigrationHealth sits behind
 * a 1,200 ms race inside readInternalSnapshot, and a diagnostics collector that
 * timed out must never be the reason a bug report is refused — the report is
 * the point; the stamp is a convenience for whoever reads it.
 */
export async function readInstanceStamp(): Promise<InstanceStamp> {
  const stamp: InstanceStamp = {
    app_version: null,
    release_channel: null,
    build_commit: null,
    schema_head: null,
    schema_state: null,
  };
  try {
    stamp.app_version = RELEASE_VERSION;
    stamp.release_channel = releaseChannel(process.env);
    stamp.build_commit = releaseCommit(process.env);
  } catch {
    // Leave the three as null; a missing stamp is not a failed report.
  }
  try {
    const migrations = await getCachedMigrationHealth();
    stamp.schema_head = migrations.applied_head;
    stamp.schema_state = migrations.state;
  } catch {
    // Same.
  }
  return stamp;
}

/**
 * Refuse an oversized artifact by dropping it, never by refusing the report.
 * A truncated artifact would be worse than none — it would look complete.
 */
export function withinDiagnosticSizeLimit(diagnostics: ProblemDiagnostics): boolean {
  return JSON.stringify(diagnostics).length <= DIAGNOSTIC_MAX_BYTES;
}
