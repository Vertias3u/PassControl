// The kill switches' durable record (0083): one row per ARMED stop, in Postgres.
//
// Redis stays the copy the gateway reads on every call (killswitch.ts); this is
// what that copy is rebuilt from when Redis loses its data. Service role, so the
// tenant boundary is the `user_id` filter written here by hand: RLS does not
// apply to this client, and a delete without it would clear every tenant's stop
// of the same kind.
import { serviceClient } from "../supabase";

export type KillRecord =
  | { kind: "tenant" }
  | { kind: "service"; service: string }
  | { kind: "session"; agentId: string; sessionId: string };

// The same shapes 0083's check constraint enforces, so a row read back can
// always be turned into the key it stands for.
const SERVICE = /^[a-z][a-z0-9_-]{0,31}$/;
const SESSION = /^[A-Za-z0-9._:-]{1,128}$/;
const TABLE = "kill_switch_records";

type Row = { kind: string; service: string | null; agent_id: string | null; session_id: string | null };

function fromRow(row: Row): KillRecord | null {
  if (row.kind === "tenant") return { kind: "tenant" };
  if (row.kind === "service" && row.service && SERVICE.test(row.service)) {
    return { kind: "service", service: row.service };
  }
  if (row.kind === "session" && row.agent_id && row.session_id && SESSION.test(row.session_id)) {
    return { kind: "session", agentId: row.agent_id, sessionId: row.session_id };
  }
  return null;
}

/**
 * Every stop armed for this tenant. THROWS when the read fails: "could not read
 * the record" must reach the caller's fail posture, never pass as "nothing armed".
 */
export async function loadKillRecords(userId: string): Promise<KillRecord[]> {
  const { data, error } = await serviceClient()
    .from(TABLE)
    .select("kind, service, agent_id, session_id")
    .eq("user_id", userId);
  if (error || !Array.isArray(data)) throw new Error("kill_record_read_failed");
  return (data as Row[]).map(fromRow).filter((r): r is KillRecord => r !== null);
}

/**
 * Record an armed stop. `true` when it is recorded, including when it already
 * was (a unique violation: arming twice). `false` on any failure, never a throw:
 * the stop is already in force in Redis by then, and the caller reports that it
 * is not saved rather than losing the audit row to an exception.
 */
export async function saveKillRecord(userId: string, stop: KillRecord): Promise<boolean> {
  try {
    const { error } = await serviceClient()
      .from(TABLE)
      .insert({
        user_id: userId,
        kind: stop.kind,
        service: stop.kind === "service" ? stop.service : null,
        agent_id: stop.kind === "session" ? stop.agentId : null,
        session_id: stop.kind === "session" ? stop.sessionId : null,
      });
    return !error || (error as { code?: string }).code === "23505";
  } catch {
    return false;
  }
}

/** Clear a stop's record. `false` on a failure, never a throw (see saveKillRecord). */
export async function deleteKillRecord(userId: string, stop: KillRecord): Promise<boolean> {
  try {
    let query = serviceClient().from(TABLE).delete().eq("user_id", userId).eq("kind", stop.kind);
    if (stop.kind === "service") query = query.eq("service", stop.service);
    if (stop.kind === "session") query = query.eq("agent_id", stop.agentId).eq("session_id", stop.sessionId);
    const { error } = await query;
    return !error;
  } catch {
    return false;
  }
}
