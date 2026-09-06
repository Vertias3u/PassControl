// Reconciliation core (Tension 2), extracted from the cron route so the
// orchestration is unit-testable. The expensive part — recomputing authoritative
// spend — is now done DB-side and INCREMENTALLY via the reconcile_agent_spend RPC
// (a cron-owned checkpoint folds in only newly-settled agent_logs rows each run),
// replacing the old per-agent full-history scan that didn't scale.
import type { Redis } from "@upstash/redis";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PASSPORT_EXPIRY_WARNING_DAYS } from "@/lib/passport-limits";
import {
  PASSPORT_SOURCE_SIGNAL_KEY_PREFIX,
  readPassportSourceSignals,
  type PassportSourceSignal,
} from "@/lib/passport-source-observation";
import { raiseSpentFloor, countOpenHolds, readReserved } from "@/lib/state/holds";

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
  /** Passports expiring inside PASSPORT_EXPIRY_WARNING_DAYS, as a warning list. */
  expiringSoon: { agentId: string; expiresAt: string }[];
  /** Break-glass grants that had lapsed and were closed out. */
  grantsClosed: number;
  /** Observe-only passport source signals. Never implies suspension or refusal. */
  passportSourceSignals: Array<PassportSourceSignal & { agentId: string }>;
  /**
   * How many attempt holds are still open across the agents this run touched.
   *
   * REPORTED, NEVER ACTED ON. An open hold means an attempt that started and
   * whose ending never ran — a worker that died, a body never consumed. Only a
   * human can say whether that call was billed, so the cron surfaces the number
   * and stops. A cron that "cleaned up" open holds would be the old
   * self-heal-by-expiry bug with a scheduler attached.
   */
  openHolds: number;
  /**
   * Agents whose `reserved:` counter does not match the sum of their open
   * holds. Diagnostics only.
   *
   * Should always be empty: reservations now move exclusively through the
   * atomic transitions, so they cannot drift except through state loss — and
   * state loss takes the holds with it, leaving nothing to drift FROM. A
   * non-zero value here means an invariant broke, which is worth seeing rather
   * than silently correcting.
   */
  reservedDrift: number;
}

const EXPIRY_WARNING_LIMIT = 100;
const PASSPORT_SOURCE_AGENT_LIMIT = 100;

interface SpendRow {
  agent_id: string;
  spent_tokens: number;
  spent_microcents: number;
}

/**
 * Reconcile budget counters and flush last-seen.
 *
 *  - spent:<agid> / spent_cost:<agid> <- RAISED TOWARD the authoritative running
 *    totals from the incremental RPC. Never lowered. See below.
 *  - reserved:<agid> / reserved_cost:<agid> <- NOT WRITTEN AT ALL any more.
 *  - lastseen:<agid> -> agents.last_seen_at.
 *
 * ── What changed here, and why the old shape was the bug ────────────────────
 *
 * This used to `SET` the spend counters from the RPC total. The RPC is
 * deliberately LAGGED — it only folds rows older than `lagSeconds`, so a call
 * that settled inside that window is not in the number it returns — and an
 * unconditional SET therefore ERASED every settlement made in the lag window.
 * On a daily cron that is up to 24 hours of spend handed back as capacity, on a
 * schedule, silently.
 *
 * It also rebuilt `reserved:` from a SCAN of per-request markers. SCAN is not a
 * snapshot: it can miss a key that exists throughout the scan, and the read and
 * the write are separated by a round trip, so a reservation taken concurrently
 * was simply overwritten. That write is gone entirely — reservations move only
 * through the atomic hold transitions now, which is the only way they can be
 * correct under concurrency.
 *
 * (It also had a quieter bug that the rewrite deletes: the marker sweep ran
 * INSIDE the loop over agents the RPC returned, so an agent with no RPC row —
 * one with no settled calls yet — was never swept at all.)
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
    passportSourceSignals: [],
    openHolds: 0,
    reservedDrift: 0,
  };

  // 1. Authoritative spend, computed DB-side and incrementally. Returns the new
  //    running total per budgeted agent — no agent_logs rows are shipped to the edge.
  const { data: totals } = await db.rpc("reconcile_agent_spend", { p_lag_seconds: opts.lagSeconds });
  const budgetedAgents: string[] = [];
  for (const row of (totals ?? []) as SpendRow[]) {
    const agentId = row.agent_id;
    budgetedAgents.push(agentId);
    // A MONOTONE RAISE, and the `max` is done server-side inside one script.
    //
    // Doing it from here — read, compare, write — would race a concurrent settle
    // and could LOWER the counter between the two round trips, which is the
    // original defect wearing a different hat. As a floor it can only ever
    // recover a settlement whose Redis write was lost; it can never create
    // capacity, whatever the lag window hides.
    await raiseSpentFloor(
      {
        agentId,
        tokens: Number(row.spent_tokens) || 0,
        microcents: Number(row.spent_microcents) || 0,
      },
      r
    );
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

  // Housekeeping REPORTING, inside the same non-fatal guard as the sweeps below
  // and for the same reason: a read that only produces a number must never be
  // able to fail the half of this function that moves money. The counts stay at
  // zero if it throws, which is honest — nothing was observed.
  try {
    for (const agentId of budgetedAgents) {
      const open = await countOpenHolds(agentId, r);
      result.openHolds += open;
      // Reservations move only through the atomic transitions, so this should be
      // exactly zero. It is read rather than corrected: a mismatch means an
      // invariant broke, and quietly rewriting the counter would hide it — which
      // is precisely what the old scan-and-SET did.
      if (open === 0) {
        const reserved = await readReserved(agentId, r);
        if (reserved.tokens !== 0 || reserved.microcents !== 0) result.reservedDrift++;
      }
    }
  } catch {
    // Deliberately silent. See above.
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

  // Observation summary only. A Redis failure here cannot make the
  // money-critical reconcile fail, and these signals never mutate agent state.
  try {
    const signalKeys = (await scanKeys(r, `${PASSPORT_SOURCE_SIGNAL_KEY_PREFIX}*`))
      .slice(0, PASSPORT_SOURCE_AGENT_LIMIT);
    const byAgent = await Promise.all(signalKeys.map(async (key) => {
      const agentId = key.slice(PASSPORT_SOURCE_SIGNAL_KEY_PREFIX.length);
      if (!agentId) return [];
      const signals = await readPassportSourceSignals(r, agentId);
      return signals.map((signal) => ({ agentId, ...signal }));
    }));
    result.passportSourceSignals = byAgent.flat().sort(
      (left, right) => Date.parse(right.observedAt) - Date.parse(left.observedAt)
    );
  } catch {
    // This detector is explicitly fail-open. The next reconcile retries.
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
  const horizon = new Date(Date.now() + PASSPORT_EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000).toISOString();
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
