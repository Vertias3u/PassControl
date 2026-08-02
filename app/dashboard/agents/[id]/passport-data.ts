import { notFound as nextNotFound } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MICROCENTS_PER_CENT } from "@/lib/pricing";
import { agentPolicyForDisplay, type AgentPolicyView } from "@/lib/scope";

const AGENT_PASSPORT_COLUMNS =
  "id, name, passport_pubkey, status, budget_tokens, budget_cents, spent_tokens, spent_microcents, allowed_scopes, policy, created_at, last_seen_at";
const PASSPORT_LOG_COLUMNS = "id, provider, model, status, created_at";
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
  passport_pubkey: string;
  status: string;
  budget_tokens: number | null;
  budget_cents: number | null;
  spent_tokens: number;
  spent_microcents: number;
  allowed_scopes: unknown;
  policy?: unknown;
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
  };
  visas: PassportVisaView[];
  policy: AgentPolicyView;
  providerStamps: PassportProviderStampView[];
  recentVerdicts: PassportVerdictView[];
  budgets: {
    tokens: PassportTokenBudgetView;
    cost: PassportCostBudgetView;
  };
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
  lifetimeProviderStamps?: readonly PassportProviderStampView[]
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
    },
    visas: normalizeVisas(agent.allowed_scopes),
    policy: agentPolicyForDisplay(agent.policy ?? null),
    providerStamps: lifetimeProviderStamps
      ? [...lifetimeProviderStamps]
      : buildProviderStamps(verdicts),
    recentVerdicts: verdicts.slice(0, RECENT_VERDICT_LIMIT),
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

  const [logs, providerStamps] = await Promise.all([
    loadRecentPassportLogs(db, userId, agentId),
    loadProviderStamps(db, userId, agentId),
  ]);
  // A null aggregate (function not deployed) falls through to stamps derived
  // from the recent history already fetched above.
  return buildAgentPassportView(agent, logs, providerStamps ?? undefined);
}
