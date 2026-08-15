import { notFound as nextNotFound } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MICROCENTS_PER_CENT } from "@/lib/pricing";
import { agentPolicyForDisplay, type AgentPolicyView } from "@/lib/scope";
import { toFallbackRows, type FallbackRow } from "@/lib/fallback-rows";
import { toCapabilityHistory, type CapabilityChange } from "@/lib/audit-history";
import { toShadowState, type ShadowState } from "@/lib/policy-shadow";
import { readLiveGrant, type BreakGlassGrant } from "@/lib/break-glass";

// `policy_shadow` is named here rather than omitted-when-absent the way
// lib/log.ts handles `policy_shadow_would`, and the asymmetry is deliberate.
// That one is on the credential path, where a pre-0020 schema would silently
// cost every audit row; this one is a single dashboard page, which fails loudly
// and only for the operator who can fix it — the same trade `fallbacks` already
// makes against 0018.
const AGENT_PASSPORT_COLUMNS =
  "id, name, passport_pubkey, status, budget_tokens, budget_cents, spent_tokens, spent_microcents, allowed_scopes, policy, policy_shadow, fallbacks, expires_at, previous_passport_pubkey, previous_valid_until, created_at, last_seen_at";
const PASSPORT_LOG_COLUMNS = "id, provider, model, status, created_at";
// created_at is selected so the sample can be cut at the moment the CURRENT
// draft was saved. Without it the panel attributes an earlier draft's verdicts
// to the one now in the column — see loadShadowCutoff.
const SHADOW_LOG_COLUMNS = "status, policy_shadow_would, created_at";
const SHADOW_SAMPLE_LIMIT = 200;
const HISTORY_COLUMNS = "id, action, target_type, target_id, metadata, created_at";
const HISTORY_LIMIT = 20;
const DIRECT_KEY_COLUMNS = "id, name, key_suffix, expires_at, revoked_at, created_at";
const RECENT_VERDICT_LIMIT = 50;
const STAMP_PROVIDER_LIMIT = 16;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOAD_ERROR = "Unable to load this agent passport.";

type PassportDatabase = Pick<SupabaseClient, "from" | "rpc">;
type NotFoundHandler = () => never;

export interface AgentPassportRow extends Record<string, unknown> {
  id: string;
  name: string;
  passport_pubkey: string | null;
  status: string;
  budget_tokens: number | null;
  budget_cents: number | null;
  spent_tokens: number;
  spent_microcents: number;
  allowed_scopes: unknown;
  policy?: unknown;
  policy_shadow?: unknown;
  fallbacks?: unknown;
  expires_at?: string | null;
  previous_passport_pubkey?: string | null;
  previous_valid_until?: string | null;
  created_at: string;
  last_seen_at: string | null;
}

export interface PassportLogRow extends Record<string, unknown> {
  id: string;
  provider: string | null;
  model: string | null;
  status: string;
  created_at: string;
}

export interface PassportVisaView {
  provider: string;
  models: string[];
}

export interface PassportProviderStampView {
  provider: string;
  firstSeenAt: string;
  lastSeenAt: string;
  recordedCalls: number;
}

export interface PassportVerdictView {
  id: string;
  provider: string;
  model: string | null;
  status: string;
  createdAt: string | null;
}

export interface PassportTokenBudgetView {
  spentTokens: number;
  capTokens: number | null;
  percentUsed: number;
  unlimited: boolean;
}

export interface PassportCostBudgetView {
  spentMicrocents: number;
  spentCents: number;
  capCents: number | null;
  percentUsed: number;
  unlimited: boolean;
}

export interface AgentPassportView {
  agent: {
    id: string;
    name: string;
    passportId: string;
    status: string;
    issuedAt: string | null;
    lastEntryAt: string | null;
    /** When this passport stops authenticating. null = never. */
    expiresAt: string | null;
    /**
     * The key retired by the most recent rotation, and when it stops working.
     * Both null once the sweep has cleared them — or if nothing was ever
     * rotated. The UI must not present a closed window as an open one.
     */
    previousPassportId: string | null;
    previousValidUntil: string | null;
  };
  visas: PassportVisaView[];
  policy: AgentPolicyView;
  /** Exact stored policy document, used only for prospective promotion wording. */
  policyDocument: unknown;
  shadow: ShadowState;
  /** A live break-glass elevation, or null. */
  breakGlass: BreakGlassGrant | null;
  fallbacks: FallbackRow[];
  history: CapabilityChange[];
  providerStamps: PassportProviderStampView[];
  recentVerdicts: PassportVerdictView[];
  directKeys: AgentAccessKeyView[];
  budgets: {
    tokens: PassportTokenBudgetView;
    cost: PassportCostBudgetView;
  };
}

export interface AgentAccessKeyView {
  id: string;
  name: string;
  suffix: string;
  createdAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Derived from agent_logs by agent_access_key_activity; never a mutable key column. */
  lastUsedAt: string | null;
  recordedCalls: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

function cap(value: unknown): number | null {
  // Only an explicit database NULL means unlimited. A malformed value becomes
  // the conservative zero cap rather than silently widening the passport.
  return value === null ? null : nonNegativeInteger(value);
}

function percentUsed(spent: number, limit: number | null): number {
  if (limit === null) return 0;
  if (limit === 0) return 100;
  return Math.min(100, (spent / limit) * 100);
}

function normalizeVisas(value: unknown): PassportVisaView[] {
  if (!Array.isArray(value)) return [];

  const visas: PassportVisaView[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    const provider = text(candidate.provider);
    if (!provider) continue;

    const models = Array.isArray(candidate.models)
      ? candidate.models
          .map((model) => text(model))
          .filter((model): model is string => Boolean(model))
      : [];
    visas.push({ provider, models });
  }
  return visas;
}

function normalizeVerdicts(logs: readonly PassportLogRow[]): PassportVerdictView[] {
  return logs
    .map((row, index) => {
      const record: Record<string, unknown> = isRecord(row) ? row : {};
      return {
        id: text(record.id, `recorded-${index + 1}`),
        provider: text(record.provider, "unknown"),
        model: text(record.model) || null,
        status: text(record.status, "unknown"),
        createdAt: timestamp(record.created_at),
      };
    })
    .sort((left, right) => {
      const timeDifference =
        (right.createdAt ? Date.parse(right.createdAt) : Number.NEGATIVE_INFINITY) -
        (left.createdAt ? Date.parse(left.createdAt) : Number.NEGATIVE_INFINITY);
      return timeDifference || right.id.localeCompare(left.id);
    });
}

function buildProviderStamps(
  verdicts: readonly PassportVerdictView[]
): PassportProviderStampView[] {
  const stamps = new Map<
    string,
    { provider: string; firstSeenAt: string; lastSeenAt: string; recordedCalls: number }
  >();

  for (const verdict of verdicts) {
    if (verdict.status !== "ok" || verdict.provider === "unknown" || !verdict.createdAt) {
      continue;
    }

    const current = stamps.get(verdict.provider);
    if (!current) {
      stamps.set(verdict.provider, {
        provider: verdict.provider,
        firstSeenAt: verdict.createdAt,
        lastSeenAt: verdict.createdAt,
        recordedCalls: 1,
      });
      continue;
    }

    current.recordedCalls += 1;
    if (Date.parse(verdict.createdAt) < Date.parse(current.firstSeenAt)) {
      current.firstSeenAt = verdict.createdAt;
    }
    if (Date.parse(verdict.createdAt) > Date.parse(current.lastSeenAt)) {
      current.lastSeenAt = verdict.createdAt;
    }
  }

  return [...stamps.values()].sort(
    (left, right) =>
      Date.parse(left.firstSeenAt) - Date.parse(right.firstSeenAt) ||
      left.provider.localeCompare(right.provider)
  );
}

export function buildAgentPassportView(
  rawAgent: AgentPassportRow,
  rawLogs: readonly PassportLogRow[],
  lifetimeProviderStamps?: readonly PassportProviderStampView[],
  rawHistory?: unknown,
  rawShadowLogs?: unknown,
  shadowSince?: string | null,
  breakGlass: BreakGlassGrant | null = null,
  directKeys: readonly AgentAccessKeyView[] = []
): AgentPassportView {
  const agent: Record<string, unknown> = isRecord(rawAgent) ? rawAgent : {};
  const verdicts = normalizeVerdicts(Array.isArray(rawLogs) ? rawLogs : []);
  const spentTokens = nonNegativeInteger(agent.spent_tokens);
  const capTokens = cap(agent.budget_tokens);
  const spentMicrocents = nonNegativeInteger(agent.spent_microcents);
  const capCents = cap(agent.budget_cents);

  return {
    agent: {
      id: text(agent.id),
      name: text(agent.name, "Unnamed agent"),
      passportId: text(agent.passport_pubkey),
      status: text(agent.status, "unknown"),
      issuedAt: timestamp(agent.created_at),
      lastEntryAt: timestamp(agent.last_seen_at),
      expiresAt: timestamp(agent.expires_at),
      previousPassportId: text(agent.previous_passport_pubkey) || null,
      previousValidUntil: timestamp(agent.previous_valid_until),
    },
    visas: normalizeVisas(agent.allowed_scopes),
    policy: agentPolicyForDisplay(agent.policy ?? null),
    policyDocument: agent.policy ?? null,
    shadow: toShadowState(agent.policy_shadow ?? null, rawShadowLogs ?? [], shadowSince ?? null),
    breakGlass,
    fallbacks: toFallbackRows(agent.fallbacks ?? null),
    history: toCapabilityHistory(rawHistory ?? []),
    providerStamps: lifetimeProviderStamps
      ? [...lifetimeProviderStamps]
      : buildProviderStamps(verdicts),
    recentVerdicts: verdicts.slice(0, RECENT_VERDICT_LIMIT),
    directKeys: [...directKeys],
    budgets: {
      tokens: {
        spentTokens,
        capTokens,
        percentUsed: percentUsed(spentTokens, capTokens),
        unlimited: capTokens === null,
      },
      cost: {
        spentMicrocents,
        spentCents: spentMicrocents / MICROCENTS_PER_CENT,
        capCents,
        percentUsed: percentUsed(
          spentMicrocents,
          capCents === null ? null : capCents * MICROCENTS_PER_CENT
        ),
        unlimited: capCents === null,
      },
    },
  };
}

async function loadDirectKeys(
  db: PassportDatabase,
  userId: string,
  agentId: string
): Promise<AgentAccessKeyView[]> {
  try {
    const [{ data: keyRows, error: keyError }, { data: activityRows, error: activityError }] =
      await Promise.all([
        db
          .from("agent_access_keys")
          .select(DIRECT_KEY_COLUMNS)
          .eq("user_id", userId)
          .eq("agent_id", agentId)
          .order("created_at", { ascending: false }),
        db.rpc("agent_access_key_activity", {
          p_user_id: userId,
          p_agent_id: agentId,
        }),
      ]);
    // Supplementary and migration-skew safe: before 0023, both reads are
    // unknown. The rest of the agent workspace remains available.
    if (keyError || activityError || !Array.isArray(keyRows)) return [];

    const activity = new Map<string, { lastUsedAt: string | null; recordedCalls: number }>();
    if (Array.isArray(activityRows)) {
      for (const candidate of activityRows) {
        if (!isRecord(candidate)) continue;
        const keyId = text(candidate.key_id);
        if (!keyId) continue;
        activity.set(keyId, {
          lastUsedAt: timestamp(candidate.last_used_at),
          recordedCalls: nonNegativeInteger(candidate.recorded_calls),
        });
      }
    }

    return keyRows.flatMap((candidate): AgentAccessKeyView[] => {
      if (!isRecord(candidate)) return [];
      const id = text(candidate.id);
      const suffix = text(candidate.key_suffix);
      if (!id || !suffix) return [];
      const usage = activity.get(id);
      return [{
        id,
        name: text(candidate.name, "Unnamed installation"),
        suffix,
        createdAt: timestamp(candidate.created_at),
        expiresAt: timestamp(candidate.expires_at),
        revokedAt: timestamp(candidate.revoked_at),
        lastUsedAt: usage?.lastUsedAt ?? null,
        recordedCalls: usage?.recordedCalls ?? 0,
      }];
    });
  } catch {
    return [];
  }
}

async function loadOwnedAgent(
  db: PassportDatabase,
  userId: string,
  agentId: string
): Promise<AgentPassportRow | null> {
  try {
    const { data, error } = await db
      .from("agents")
      .select(AGENT_PASSPORT_COLUMNS)
      .eq("user_id", userId)
      .eq("id", agentId)
      .maybeSingle();

    if (error) throw new Error(LOAD_ERROR);
    if (data === null) return null;
    if (!isRecord(data)) throw new Error(LOAD_ERROR);
    return data as unknown as AgentPassportRow;
  } catch {
    throw new Error(LOAD_ERROR);
  }
}

async function loadRecentPassportLogs(
  db: PassportDatabase,
  userId: string,
  agentId: string
): Promise<PassportLogRow[]> {
  try {
    const { data, error } = await db
      .from("agent_logs")
      .select(PASSPORT_LOG_COLUMNS)
      .eq("user_id", userId)
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(RECENT_VERDICT_LIMIT);

    if (error || !Array.isArray(data)) throw new Error(LOAD_ERROR);
    return data as unknown as PassportLogRow[];
  } catch {
    throw new Error(LOAD_ERROR);
  }
}

/**
 * What has been done to this passport.
 *
 * Supplementary, so it follows loadProviderStamps' posture rather than
 * loadOwnedAgent's: a failure returns an empty list and the panel says nothing
 * is recorded, instead of taking the whole passport page down. The history is
 * the least load-bearing thing on the page and must not be the most fragile.
 *
 * Only (user_id, created_at desc) is indexed on admin_audit. The user_id prefix
 * is used and per-tenant audit volume is small; if that ever stops being true,
 * a partial index on target_id is the fix.
 */
async function loadCapabilityHistory(
  db: PassportDatabase,
  userId: string,
  agentId: string
): Promise<unknown[]> {
  try {
    const { data, error } = await db
      .from("admin_audit")
      .select(HISTORY_COLUMNS)
      .eq("user_id", userId) // tenant boundary
      .eq("target_id", agentId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    if (error || !Array.isArray(data)) return [];
    return data;
  } catch {
    return [];
  }
}

/**
 * What a shadow policy would have decided, over a wider sample than the 50 rows
 * the verdict list shows.
 *
 * Supplementary, like loadCapabilityHistory: an error returns an empty sample
 * and the panel says nothing has been observed yet. That posture is what keeps
 * this column decoupled from migration 0020 — a deployment running this code
 * against a pre-0020 schema gets a PostgREST error for the unknown column here,
 * loses the counts, and keeps its passport page.
 *
 * The rows are ATTEMPTS. A call that failed over writes one row per attempt,
 * each carrying the verdict for the provider and model that attempt went to —
 * they can disagree, because a draft can deny one provider by name and not the
 * other. lib/policy-shadow.ts labels them accordingly rather than dividing and
 * calling them calls.
 */
async function loadShadowSample(
  db: PassportDatabase,
  userId: string,
  agentId: string
): Promise<unknown[]> {
  try {
    const { data, error } = await db
      .from("agent_logs")
      .select(SHADOW_LOG_COLUMNS)
      .eq("user_id", userId) // tenant boundary
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })
      .limit(SHADOW_SAMPLE_LIMIT);
    if (error || !Array.isArray(data)) return [];
    return data;
  } catch {
    return [];
  }
}

/**
 * When the draft currently in the column was saved.
 *
 * This is no longer what attributes a verdict to a draft — `policy_shadow_would`
 * now carries the revision of the document that produced it, and
 * summariseShadowDivergence counts only matching stamps. A timestamp could never
 * do that job correctly: a streaming request that read draft A stays open across
 * a save and inserts A's verdict AFTER draft B's cutoff, and a policy-cache miss
 * that began before the purge does the same. Both land inside B's window.
 *
 * It is kept for two reasons: it dates the measurement for the operator, and it
 * is a strictly conservative second filter — a row it drops was already not
 * being counted for any decision.
 *
 * saveAgentPolicyShadow writes an admin_audit row with `fields: "policy_shadow"`
 * on every draft change, so the newest of those IS the moment the current draft
 * began. Promotion writes `fields: "policy"` instead, which is correct to ignore
 * here: it also nulls the column, so shadow mode is off and no counts render.
 *
 * Returns null when no such row exists — a draft planted by SQL, or one that
 * predates this record. The panel says so rather than passing undatable numbers
 * off as current.
 *
 * Issued in parallel with the sample rather than before it: the cutoff is
 * applied in memory, so neither query waits on the other.
 */
async function loadShadowCutoff(
  db: PassportDatabase,
  userId: string,
  agentId: string
): Promise<string | null> {
  try {
    const { data, error } = await db
      .from("admin_audit")
      .select("created_at")
      .eq("user_id", userId) // tenant boundary
      .eq("target_id", agentId)
      .eq("metadata->>fields", "policy_shadow")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !isRecord(data)) return null;
    return timestamp(data.created_at);
  } catch {
    return null;
  }
}

/**
 * Lifetime per-provider stamps in one grouped aggregate (migration 0013). The
 * function is SECURITY INVOKER, so RLS on agent_logs is what scopes the rows;
 * p_user_id mirrors the explicit filter used everywhere else and can only
 * narrow the result further.
 *
 * Returns null when the function is absent, which happens to anyone running new
 * code against a database that has not applied 0013 yet. That degrades to
 * stamps derived from recent history rather than breaking the page. Any other
 * error still fails closed.
 */
async function loadProviderStamps(
  db: PassportDatabase,
  userId: string,
  agentId: string
): Promise<PassportProviderStampView[] | null> {
  const { data, error } = await db.rpc("agent_provider_stamps", {
    p_agent_id: agentId,
    p_user_id: userId,
  });

  if (error) {
    if (isMissingFunction(error)) return null;
    throw new Error(LOAD_ERROR);
  }
  if (!Array.isArray(data)) throw new Error(LOAD_ERROR);

  const stamps: PassportProviderStampView[] = [];
  for (const row of data) {
    if (!isRecord(row)) continue;
    const provider = text(row.provider);
    const firstSeenAt = timestamp(row.first_seen_at);
    const lastSeenAt = timestamp(row.last_seen_at);
    const recordedCalls = nonNegativeInteger(row.recorded_calls);
    if (!provider || !firstSeenAt || !lastSeenAt || recordedCalls === 0) continue;
    stamps.push({ provider, firstSeenAt, lastSeenAt, recordedCalls });
  }

  return stamps
    .slice(0, STAMP_PROVIDER_LIMIT)
    .sort(
      (left, right) =>
        Date.parse(left.firstSeenAt) - Date.parse(right.firstSeenAt) ||
        left.provider.localeCompare(right.provider)
    );
}

/** PostgREST reports an unknown routine as PGRST202; Postgres as 42883. */
function isMissingFunction(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = typeof error.code === "string" ? error.code : "";
  return code === "PGRST202" || code === "42883";
}

/**
 * Load one passport through the cookie-bound, RLS-backed Supabase client.
 * Ownership is resolved before any log query, keeping foreign and absent IDs on
 * the same not-found path and avoiding a history side channel.
 */
export async function requireAgentPassport(
  db: PassportDatabase,
  userId: string,
  agentId: string,
  notFound: NotFoundHandler = nextNotFound
): Promise<AgentPassportView> {
  if (!UUID_RE.test(userId) || !UUID_RE.test(agentId)) return notFound();

  const agent = await loadOwnedAgent(db, userId, agentId);
  if (!agent) return notFound();

  const [logs, providerStamps, history, shadowLogs, shadowSince, breakGlass, directKeys] = await Promise.all([
    loadRecentPassportLogs(db, userId, agentId),
    loadProviderStamps(db, userId, agentId),
    loadCapabilityHistory(db, userId, agentId),
    loadShadowSample(db, userId, agentId),
    loadShadowCutoff(db, userId, agentId),
    // Returns null on any failure, including a pre-0022 schema — the same
    // posture the credential path takes. A page that cannot read the grants
    // table shows no elevation rather than failing.
    readLiveGrant(db, userId, agentId),
    loadDirectKeys(db, userId, agentId),
  ]);
  // A null aggregate (function not deployed) falls through to stamps derived
  // from the recent history already fetched above.
  return buildAgentPassportView(
    agent,
    logs,
    providerStamps ?? undefined,
    history,
    shadowLogs,
    shadowSince,
    breakGlass,
    directKeys
  );
}
