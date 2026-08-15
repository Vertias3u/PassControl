// Current per-agent fallback list, read the way policy is read.
//
// Modelled on lib/state/policy.ts: Redis cache, 60s TTL, tenant-scoped select on
// a miss. Kept out of visas for the same reason policy is — an operator's change
// takes effect within the cache window instead of waiting out a live visa's TTL.
//
// One deliberate difference from policy. readCurrentAgentPolicy returns a
// sentinel on an unreadable row so the shared evaluator can FAIL CLOSED: policy
// is a restriction, and an unreadable restriction must not silently permit. A
// fallback list is the opposite kind of thing — an enhancement — so every
// failure here returns [], which means "no failover", which is exactly what the
// gateway did before this feature existed. Degrade to the old path, never fail
// a call because an optional list could not be read.
//
// This read happens only after an upstream attempt has already failed, so it is
// never on the approved-call path.
import { waitUntil } from "@vercel/functions";
import type { SupabaseClient } from "@supabase/supabase-js";

import { parseFallbacks, type FallbackEntry } from "../providers/fallbacks";
import { getCachedAgentFallbacks, setCachedAgentFallbacks } from "./redis";

const FALLBACKS_CACHE_TTL_S = 60;

type FallbacksDatabase = Pick<SupabaseClient, "from">;

export async function readCurrentAgentFallbacks(
  db: FallbacksDatabase,
  userId: string,
  agentId: string
): Promise<FallbackEntry[]> {
  try {
    const cached = await getCachedAgentFallbacks(userId, agentId);
    if (cached !== null) {
      try {
        return parseFallbacks(JSON.parse(cached));
      } catch {
        return [];
      }
    }
  } catch {
    // A cache read failure falls through to the tenant-scoped source of truth.
  }

  try {
    const { data, error } = await db
      .from("agents")
      .select("fallbacks")
      .eq("user_id", userId) // tenant boundary — service_role bypasses RLS
      .eq("id", agentId)
      .maybeSingle();

    // A deployment that has not run migration 0018 has no such column. That is
    // an agent with no failover configured, not an error worth surfacing.
    if (error || !data || !("fallbacks" in data)) return [];

    const raw = data.fallbacks ?? null;
    // Cache the empty result too: an agent with no fallbacks is the common case
    // and should not cost a database read on every failed upstream call.
    waitUntil(
      setCachedAgentFallbacks(userId, agentId, JSON.stringify(raw), FALLBACKS_CACHE_TTL_S)
    );
    return parseFallbacks(raw);
  } catch {
    return [];
  }
}
