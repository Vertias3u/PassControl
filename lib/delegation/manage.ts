// Bet D: the owner revokes a worker's delegation (plans/delegation-design.md §9).
//
// Postgres is written first and is the record: the exchange route reads it before every
// visa, so a revocation recorded there stops a worker within one visa lifetime (5 minutes)
// whatever happens next. The Redis copy (lib/state/delegation.ts) is what makes the PROXY
// refuse at once; if that write fails the revocation still stands, and the result says
// it was not immediate.
//
// Every query names the owner by hand: the service-role client bypasses RLS.
import type { serviceClient } from "@/lib/supabase";
import { raiseDelegationWatermark, revokeDelegation } from "@/lib/state/delegation";

type Db = ReturnType<typeof serviceClient>;
const JTI = /^[A-Za-z0-9_-]{16,64}$/;

type Failure = { ok: false; status: number; code: string };

export interface DelegationListing {
  jti: string;
  depth: number;
  parent_jti: string | null;
  worker_key: string;
  cap_microcents: number;
  scope: unknown;
  issued_at: string;
  expires_at: string;
  first_exchanged_at: string;
  revoked: boolean;
}

async function ownedAgent(db: Db, userId: string, agentId: string, columns = "id"): Promise<Record<string, unknown> | null | "error"> {
  const { data, error } = await db.from("agents").select(columns).eq("id", agentId).eq("user_id", userId).maybeSingle();
  if (error) return "error";
  return (data as Record<string, unknown> | null) ?? null;
}

export async function listDelegations(
  db: Db,
  userId: string,
  agentId: string
): Promise<{ ok: true; delegations: DelegationListing[] } | Failure> {
  const agent = await ownedAgent(db, userId, agentId, "id, delegations_valid_after");
  if (agent === "error") return { ok: false, status: 500, code: "lookup_failed" };
  if (!agent) return { ok: false, status: 404, code: "agent_not_found" };
  const [exchanges, revocations] = await Promise.all([
    db
      .from("delegation_exchanges")
      .select("jti, depth, parent_jti, worker_key, cap_microcents, scope, issued_at, expires_at, first_exchanged_at")
      .eq("agent_id", agentId)
      .eq("user_id", userId)
      .order("first_exchanged_at", { ascending: false })
      .limit(200),
    db.from("delegation_revocations").select("jti").eq("agent_id", agentId).eq("user_id", userId),
  ]);
  if (exchanges.error || revocations.error || !Array.isArray(exchanges.data) || !Array.isArray(revocations.data)) {
    return { ok: false, status: 500, code: "lookup_failed" };
  }
  const revoked = new Set((revocations.data as { jti: string }[]).map((r) => r.jti));
  const watermark = agent.delegations_valid_after == null ? null : Date.parse(String(agent.delegations_valid_after));
  return {
    ok: true,
    delegations: (exchanges.data as Omit<DelegationListing, "revoked">[]).map((d) => ({
      ...d,
      revoked: revoked.has(d.jti) || (watermark !== null && Date.parse(d.issued_at) <= watermark),
    })),
  };
}

/**
 * Every key a delegation rooted in this agent can verify under right now: the current
 * passport, and a rotated-out one still inside its grace window. A revocation records
 * them at that moment, because the public list publishes it under them (P2.4).
 */
function coveredPassports(agent: Record<string, unknown>): string[] {
  return [agent.passport_pubkey, agent.previous_passport_pubkey].filter(
    (k, i, all): k is string => typeof k === "string" && k.length > 0 && all.indexOf(k) === i
  );
}

const PASSPORT_COLUMNS = "id, passport_pubkey, previous_passport_pubkey";

export async function revokeAgentDelegation(
  db: Db,
  userId: string,
  agentId: string,
  jti: string
): Promise<{ ok: true; immediate: boolean; passports: string[] } | Failure> {
  // Any well-formed jti, seen or not: an owner who learns of a leaked token before
  // its worker ever exchanged it can kill it in advance. A delegator picks its own
  // jti, so a jti names nothing by itself; the passports below are what scope it.
  if (!JTI.test(jti)) return { ok: false, status: 400, code: "invalid_jti" };
  const agent = await ownedAgent(db, userId, agentId, PASSPORT_COLUMNS);
  if (agent === "error") return { ok: false, status: 500, code: "lookup_failed" };
  if (!agent) return { ok: false, status: 404, code: "agent_not_found" };
  const passports = coveredPassports(agent);
  const { error } = await db
    .from("delegation_revocations")
    .upsert({ user_id: userId, agent_id: agentId, jti }, { onConflict: "agent_id,jti", ignoreDuplicates: true });
  if (error) return { ok: false, status: 500, code: "revoke_failed" };
  try {
    await revokeDelegation(agentId, jti);
    return { ok: true, immediate: true, passports };
  } catch {
    return { ok: true, immediate: false, passports };
  }
}

/**
 * The audit metadata for a revocation, shared by the control API and the dashboard so
 * the public revocation list (lib/revocation-list.ts, P2.4) reads one shape. Both kinds
 * record the passport ids they covered AT THAT MOMENT: the list publishes each from this
 * row, a jti is only meaningful under its root passport, and reading the agent's keys
 * later would let a rotation rewrite an entry that was already published.
 */
export function delegationRevokeMetadata(
  input:
    | { all: true; validAfter: string; passports: string[]; immediate: boolean; via: string; keyId?: string }
    | { all: false; jti: string; passports: string[]; immediate: boolean; via: string; keyId?: string }
): Record<string, unknown> {
  const tail = { immediate: input.immediate, via: input.via, ...(input.keyId ? { key_id: input.keyId } : {}) };
  return input.all
    ? { all: true, valid_after: input.validAfter, passports: input.passports, ...tail }
    : { all: false, jti: input.jti, passports: input.passports, ...tail };
}

export async function revokeAllAgentDelegations(
  db: Db,
  userId: string,
  agentId: string
): Promise<{ ok: true; immediate: boolean; validAfter: string; passports: string[] } | Failure> {
  const agent = await ownedAgent(db, userId, agentId, PASSPORT_COLUMNS);
  if (agent === "error") return { ok: false, status: 500, code: "lookup_failed" };
  if (!agent) return { ok: false, status: 404, code: "agent_not_found" };
  const passports = coveredPassports(agent);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const validAfter = new Date(nowSeconds * 1000).toISOString();
  // The column only moves forward (a trigger, 0081); a second call in the same second
  // is the same instant and changes nothing.
  const { data, error } = await db
    .from("agents")
    .update({ delegations_valid_after: validAfter })
    .eq("id", agentId)
    .eq("user_id", userId)
    .select("id");
  if (error || !Array.isArray(data) || data.length !== 1) return { ok: false, status: 500, code: "revoke_failed" };
  try {
    await raiseDelegationWatermark(agentId, nowSeconds);
    return { ok: true, immediate: true, validAfter, passports };
  } catch {
    return { ok: true, immediate: false, validAfter, passports };
  }
}
