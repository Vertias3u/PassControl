// Canonical fleet mutations — the SINGLE implementation of the security/money-
// touching agent operations, used by BOTH the dashboard server actions and the
// public control-plane API so behavior is identical across surfaces.
//
// Every function takes a Supabase client + the acting userId and scopes every
// write by `user_id` (with the user client RLS also enforces it; with the
// service-role client this `.eq("user_id", …)` IS the tenant boundary). Returns a
// discriminated result — no throwing for expected outcomes — so each caller maps
// it to its own response (HTTP status / dashboard error).
import type { SupabaseClient } from "@supabase/supabase-js";
import { armTenantKill } from "@/lib/state/killswitch";
import { suspendAgent, unsuspendAgent, purgeAgentCaches } from "@/lib/state/redis";
import { validateAgentInput, validateAgentUpdate } from "@/lib/validate";
import { PROVIDERS } from "@/lib/providers";

const cachePurgeProviders = () => [...PROVIDERS];

export type FleetResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message?: string };

/** Create an agent for a tenant (validates input; passport_pubkey must be unique). */
export async function createAgent(
  db: SupabaseClient,
  userId: string,
  input: unknown
): Promise<FleetResult<{ id: string; name: string }>> {
  let clean;
  try {
    clean = validateAgentInput(input as any);
  } catch (e) {
    return { ok: false, status: 422, code: "invalid_request", message: (e as Error).message };
  }
  const { data, error } = await db
    .from("agents")
    .insert({
      user_id: userId,
      name: clean.name,
      passport_pubkey: clean.passportPubkey,
      allowed_scopes: clean.scopes,
      budget_tokens: clean.budget_tokens,
      budget_cents: clean.budget_cents,
    })
    .select("id")
    .single();
  if (error) {
    // 23505 = unique_violation (passport already registered).
    if ((error as { code?: string }).code === "23505") {
      return { ok: false, status: 409, code: "agent_exists", message: "That passport is already registered." };
    }
    return { ok: false, status: 500, code: "query_failed" };
  }
  return { ok: true, value: { id: data.id as string, name: clean.name } };
}

/** Update an agent's name / scopes / budgets (partial; tenant-scoped). */
export async function updateAgent(
  db: SupabaseClient,
  userId: string,
  agentId: string,
  patch: unknown
): Promise<FleetResult<{ id: string }>> {
  let clean;
  try {
    clean = validateAgentUpdate(patch as any);
  } catch (e) {
    return { ok: false, status: 422, code: "invalid_request", message: (e as Error).message };
  }
  if (Object.keys(clean).length === 0) {
    return { ok: false, status: 400, code: "empty_update", message: "No updatable fields provided." };
  }
  const { data, error } = await db
    .from("agents")
    .update(clean)
    .eq("user_id", userId)
    .eq("id", agentId)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, status: 500, code: "query_failed" };
  if (!data) return { ok: false, status: 404, code: "not_found" };
  return { ok: true, value: { id: agentId } };
}

/** Suspend or resume an agent. Only active agents can be suspended, and only
 * suspended agents can resume: a revoked agent is terminal and can never be
 * reactivated through this path. */
export async function setAgentSuspended(
  db: SupabaseClient,
  userId: string,
  agentId: string,
  suspended: boolean
): Promise<FleetResult<{ id: string }>> {
  const { data, error } = await db
    .from("agents")
    .update({ status: suspended ? "suspended" : "active" })
    .eq("user_id", userId)
    .eq("id", agentId)
    .eq("status", suspended ? "active" : "suspended")
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, status: 500, code: "query_failed" };
  if (!data) return { ok: false, status: 404, code: "not_found" };

  if (suspended) {
    await suspendAgent(agentId);
    await purgeAgentCaches(agentId, cachePurgeProviders());
  } else {
    await unsuspendAgent(agentId);
  }
  return { ok: true, value: { id: agentId } };
}

/** Revoke an agent (terminal): status=revoked + suspend + purge. Keeps history. */
export async function revokeAgent(
  db: SupabaseClient,
  userId: string,
  agentId: string
): Promise<FleetResult<{ id: string }>> {
  const { data, error } = await db
    .from("agents")
    .update({ status: "revoked" })
    .eq("user_id", userId)
    .eq("id", agentId)
    .neq("status", "revoked")
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, status: 500, code: "query_failed" };
  if (!data) return { ok: false, status: 404, code: "not_found" };

  await suspendAgent(agentId);
  await purgeAgentCaches(agentId, cachePurgeProviders());
  return { ok: true, value: { id: agentId } };
}

/** Arm/disarm the per-tenant master kill. It is deliberately independent of
 * per-agent suspension: disarming a tenant must never reactivate an agent that
 * was separately suspended or revoked. */
export async function setTenantKill(
  db: SupabaseClient,
  userId: string,
  on: boolean
): Promise<FleetResult<{ affected: number }>> {
  await armTenantKill(userId, on);
  const { data: agents } = await db.from("agents").select("id").eq("user_id", userId);
  return { ok: true, value: { affected: (agents ?? []).length } };
}
