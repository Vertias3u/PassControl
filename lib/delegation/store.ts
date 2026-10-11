// Bet D: the exchange route's durable reads and writes (0081; plans/delegation-design.md
// §9, §13). Postgres is the record; lib/state/delegation.ts is the proxy's hot-path copy.
//
// Both functions THROW on any failure, and the exchange route refuses on a throw: an
// unreadable revocation for a delegation is an unreadable credential (P2.3), and a
// first-exchange record that cannot be written must not mint a visa whose ledger was
// never created.
import type { serviceClient } from "@/lib/supabase";

type Db = ReturnType<typeof serviceClient>;

export interface DelegationRecord {
  /** agents.delegations_valid_after, in seconds; null when never set. */
  watermarkSeconds: number | null;
  /** The jtis among those asked about that the owner revoked. */
  revoked: string[];
}

/** The authoritative revocation state for these links of this agent. */
export async function readDelegationRecord(db: Db, agentId: string, jtis: readonly string[]): Promise<DelegationRecord> {
  const [agent, revocations] = await Promise.all([
    db.from("agents").select("delegations_valid_after").eq("id", agentId).maybeSingle(),
    db.from("delegation_revocations").select("jti").eq("agent_id", agentId).in("jti", [...jtis]),
  ]);
  if (agent.error || revocations.error || !agent.data || !Array.isArray(revocations.data)) {
    throw new Error("delegation record unreadable");
  }
  const raw = (agent.data as { delegations_valid_after?: unknown }).delegations_valid_after;
  let watermarkSeconds: number | null = null;
  if (raw != null) {
    const ms = Date.parse(String(raw));
    if (!Number.isFinite(ms)) throw new Error("delegation watermark unreadable");
    watermarkSeconds = Math.floor(ms / 1000);
  }
  return {
    watermarkSeconds,
    revoked: (revocations.data as { jti?: unknown }[]).map((r) => String(r.jti)),
  };
}

export interface ExchangeRow {
  userId: string;
  agentId: string;
  jti: string;
  depth: number;
  parentJti: string | null;
  workerKey: string;
  capMicrocents: number;
  scope: unknown;
  iat: number;
  exp: number;
}

/**
 * Record each link's first exchange. Returns the jtis whose row THIS call created:
 * only those may have a spend ledger created (lib/state/holds.ts). A link already
 * recorded is left exactly as it was.
 */
export async function recordFirstExchanges(db: Db, rows: readonly ExchangeRow[]): Promise<string[]> {
  const { data, error } = await db
    .from("delegation_exchanges")
    .upsert(
      rows.map((r) => ({
        user_id: r.userId,
        agent_id: r.agentId,
        jti: r.jti,
        depth: r.depth,
        parent_jti: r.parentJti,
        worker_key: r.workerKey,
        cap_microcents: r.capMicrocents,
        scope: r.scope,
        issued_at: new Date(r.iat * 1000).toISOString(),
        expires_at: new Date(r.exp * 1000).toISOString(),
      })),
      { onConflict: "agent_id,jti", ignoreDuplicates: true }
    )
    .select("jti");
  if (error || !Array.isArray(data)) throw new Error("delegation exchange record failed");
  return (data as { jti?: unknown }[]).map((r) => String(r.jti));
}

/** True when the record kills any of these links. */
export function delegationRecordRevokes(record: DelegationRecord, links: readonly { jti: string; iat: number }[]): boolean {
  if (links.some((l) => record.revoked.includes(l.jti))) return true;
  return record.watermarkSeconds !== null && links.some((l) => l.iat <= record.watermarkSeconds!);
}
