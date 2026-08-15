// Reconciliation core (Tension 2), extracted from the cron route so the
// orchestration is unit-testable. The expensive part — recomputing authoritative
// spend — is now done DB-side and INCREMENTALLY via the reconcile_agent_spend RPC
// (a cron-owned checkpoint folds in only newly-settled agent_logs rows each run),
// replacing the old per-agent full-history scan that didn't scale.
import type { Redis } from "@upstash/redis";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function scanKeys(r: Redis, match: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = (await r.scan(cursor, { match, count: 200 })) as [string, string[]];
    out.push(...keys);
    cursor = next;
  } while (cursor !== "0");
  return out;
}

export interface ReconcileResult {
  agents: number;
  lastSeenFlushed: number;
  /** Retired passport keys whose grace window had closed and were cleared. */
  retiredKeysCleared: number;
  /** Passports expiring inside EXPIRY_WARNING_DAYS, as a warning list. */
  expiringSoon: { agentId: string; expiresAt: string }[];
  /** Break-glass grants that had lapsed and were closed out. */
  grantsClosed: number;
}

const EXPIRY_WARNING_DAYS = 7;
const EXPIRY_WARNING_LIMIT = 100;

interface SpendRow {
  agent_id: string;
  spent_tokens: number;
  spent_microcents: number;
}

/**
 * Reconcile budget counters and flush last-seen.
 *  - spent:<agid> / spent_cost:<agid> <- authoritative running totals from the
 *    incremental RPC.
 *  - reserved:<agid> / reserved_cost:<agid> <- sums of still-live per-jti markers
 *    (orphaned reservations from a crashed reconcile have already expired) →
 *    self-heals the leak.
 *  - lastseen:<agid> -> agents.last_seen_at.
 */
export async function runReconcile(
  db: SupabaseClient,
  r: Redis,
  opts: { lagSeconds: number }
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    agents: 0,
    lastSeenFlushed: 0,
    retiredKeysCleared: 0,
    expiringSoon: [],
    grantsClosed: 0,
  };

  // 1. Authoritative spend, computed DB-side and incrementally. Returns the new
  //    running total per budgeted agent — no agent_logs rows are shipped to the edge.
  const { data: totals } = await db.rpc("reconcile_agent_spend", { p_lag_seconds: opts.lagSeconds });
  for (const row of (totals ?? []) as SpendRow[]) {
    const agentId = row.agent_id;
    await r.set(`spent:${agentId}`, Number(row.spent_tokens) || 0);
    await r.set(`spent_cost:${agentId}`, Number(row.spent_microcents) || 0);

    const markerKeys = await scanKeys(r, `reserve:${agentId}:*`);
    let reserved = 0;
    if (markerKeys.length) {
      const vals = ((await r.mget<(number | null)[]>(...markerKeys)) ?? []) as (number | null)[];
      reserved = vals.reduce((s: number, v) => s + (Number(v) || 0), 0);
    }
    await r.set(`reserved:${agentId}`, reserved);

    const costMarkerKeys = await scanKeys(r, `reserve_cost:${agentId}:*`);
    let reservedMicrocents = 0;
    if (costMarkerKeys.length) {
      const vals = ((await r.mget<(number | null)[]>(...costMarkerKeys)) ?? []) as (number | null)[];
      reservedMicrocents = vals.reduce((s: number, v) => s + (Number(v) || 0), 0);
    }
    await r.set(`reserved_cost:${agentId}`, reservedMicrocents);
    result.agents++;
  }

  // 2. Flush coalesced last-seen.
  const lastSeenKeys = await scanKeys(r, "lastseen:*");
  for (const key of lastSeenKeys) {
    const agentId = key.slice("lastseen:".length);
    const ms = Number(await r.get<number>(key));
    if (Number.isFinite(ms)) {
      await db.from("agents").update({ last_seen_at: new Date(ms).toISOString() }).eq("id", agentId);
      result.lastSeenFlushed++;
    }
  }

  // Last, and unable to fail the run. Everything above this line is the
  // money-critical half — authoritative spend and reservation self-heal — and it
  // has already been written to Redis by the time we get here. Letting a
  // housekeeping query turn a successful reconcile into a 500 would page an
  // operator about work that actually completed, and worse, would hide a real
  // spend failure behind an unrelated one.
  try {
    await sweepPassports(db, result);
  } catch {
    // Deliberately silent in the result: the counts stay at their zero values,
    // which is honest — nothing was swept. The next run retries, and nothing
    // about expiry enforcement depends on this having succeeded.
  }
  return result;
}

/**
 * Housekeeping for passport rotation and expiry. Deliberately NOT enforcement.
 *
 * ── Say this out loud, because getting it wrong is the whole risk ───────────
 *
 * Expiry and the end of a grace window are enforced by lib/auth/passport.ts, on
 * every single challenge, by comparing timestamps. A cron that has not run —
 * because it was misconfigured, because CRON_SECRET rotated, because the
 * scheduler was paused — must NEVER be the reason an expired passport still
 * works. Everything here is convenience: clearing a retired key so it stops
 * occupying the unique constraint, and surfacing what is about to lapse. Delete
 * this function entirely and the security properties are unchanged.
 *
 * Both queries are bounded and run once per reconcile, not per agent.
 */
async function sweepPassports(db: SupabaseClient, result: ReconcileResult): Promise<void> {
  const now = new Date().toISOString();

  // 1. Release retired keys whose window has closed. Without this a rotated-away
  //    key holds the unique constraint forever, so an operator could not later
  //    reinstate it, and no one else could ever register it.
  const { data: released } = await db
    .from("agents")
    .update({ previous_passport_pubkey: null, previous_valid_until: null })
    .not("previous_passport_pubkey", "is", null)
    .lt("previous_valid_until", now)
    .select("id");
  result.retiredKeysCleared = Array.isArray(released) ? released.length : 0;

  // 2. What is about to lapse. Reported, not acted on — automatic renewal of an
  //    expiring passport is explicitly out of scope, because a key that renews
  //    itself is a key that never actually expires.
  const horizon = new Date(Date.now() + EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: expiring } = await db
    .from("agents")
    .select("id, expires_at")
    .eq("status", "active")
    .not("expires_at", "is", null)
    .gt("expires_at", now)
    .lt("expires_at", horizon)
    .order("expires_at", { ascending: true })
    .limit(EXPIRY_WARNING_LIMIT);
  result.expiringSoon = (Array.isArray(expiring) ? expiring : []).map((row) => ({
    agentId: String((row as { id?: unknown }).id ?? ""),
    expiresAt: String((row as { expires_at?: unknown }).expires_at ?? ""),
  }));

  // 3. Close out lapsed break-glass grants.
  //
  // This does NOT end an elevation — a lapsed grant stopped being minted the
  // moment it lapsed, because lib/break-glass.ts decides "live" by comparing
  // expires_at in code. What it does is free the one-live-grant-per-agent index
  // slot, whose predicate can only be `revoked_at is null` (Postgres refuses a
  // STABLE function like now() in an index predicate). Without this pass an
  // agent could be elevated once and then never again.
  //
  // So the worst a stalled cron can do here is block the NEXT elevation, with a
  // message telling the operator to end the existing one — which works, because
  // revoking an already-lapsed grant is harmless. It can never extend one.
  const { data: closed } = await db
    .from("break_glass_grants")
    .update({ revoked_at: now })
    .is("revoked_at", null)
    .lt("expires_at", now)
    .select("id");
  result.grantsClosed = Array.isArray(closed) ? closed.length : 0;
}
