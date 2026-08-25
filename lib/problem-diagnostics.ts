/**
 * The diagnostic artifact attached to a problem report.
 *
 * ── Why this wraps buildCloudSupportBundle instead of replacing or editing it ──
 *
 * lib/cloud-operations.ts already builds exactly the right thing, from an
 * explicit allowlist of safe fields, and its docstring carries the property
 * that matters: it never clones or serializes a database row, so a future
 * secret-bearing column cannot leak into it by being added to a SELECT. That
 * builder is reused verbatim. Editing it to add provenance would bump its
 * schema_version and invalidate the Cloud appendix's own tests for no gain.
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
import { buildCloudSupportBundle, type CloudOperationsSignals, type CloudSupportBundle } from "@/lib/cloud-operations";
import { readCloudBetaQuotaSnapshot } from "@/lib/cloud-beta-quota";
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
  bundle: CloudSupportBundle;
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
  now: Date
): Promise<ProblemDiagnostics> {
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
      readCloudBetaQuotaSnapshot(user.id, now),
      readKillState(user.id),
    ]);

  const logRows = logs ?? [];
  const signals: CloudOperationsSignals = {
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
    bundle: buildCloudSupportBundle({
      generatedAt: now.toISOString(),
      quota,
      signals,
      controls: { workspaceKillArmed: kill.userKill, platformKillArmed: kill.platformKill },
      agents: (agents ?? []) as Record<string, unknown>[],
      logs: logRows as Record<string, unknown>[],
    }),
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
