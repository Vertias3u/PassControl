// Current per-agent policy read shared by the proxy and decision trace. Policy
// stays out of visas so owner changes take effect after at most the 60-second
// cache window. Traces may read the same cache but never populate it.
import { waitUntil } from "@vercel/functions";
import type { SupabaseClient } from "@supabase/supabase-js";
import { POLICY_UNREADABLE } from "../gate";
import { getCachedAgentPolicy, setCachedAgentPolicy } from "./redis";

const POLICY_CACHE_TTL_S = 60;

type PolicyDatabase = Pick<SupabaseClient, "from">;

export interface CurrentPolicyReadOptions {
  cacheOnMiss?: boolean;
}

export async function readCurrentAgentPolicy(
  db: PolicyDatabase,
  userId: string,
  agentId: string,
  options: CurrentPolicyReadOptions = {}
): Promise<unknown | typeof POLICY_UNREADABLE> {
  try {
    const cached = await getCachedAgentPolicy(userId, agentId);
    if (cached !== null) {
      try {
        return JSON.parse(cached);
      } catch {
        // A readable malformed cache value remains malformed policy, not an
        // infrastructure-read failure, so the shared evaluator fails closed.
        return cached;
      }
    }
  } catch {
    // A cache read failure falls through to the tenant-scoped source of truth.
  }

  const { data, error } = await db
    .from("agents")
    .select("policy")
    .eq("user_id", userId)
    .eq("id", agentId)
    .maybeSingle();

  if (error || !data || !("policy" in data)) return POLICY_UNREADABLE;

  const policy = data.policy ?? null;
  if (options.cacheOnMiss !== false) {
    waitUntil(
      setCachedAgentPolicy(userId, agentId, JSON.stringify(policy), POLICY_CACHE_TTL_S)
    );
  }
  return policy;
}
