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
}

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
  const result: ReconcileResult = { agents: 0, lastSeenFlushed: 0 };

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

  return result;
}
