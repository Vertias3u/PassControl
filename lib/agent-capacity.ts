// "Would 0076 let this account create one more agent right now?", asked BEFORE
// a flow that has to do something else first.
//
// The key-import on-ramp stores the provider key, then creates the agent. At
// the agent cap that order left a real provider secret in Vault attached to
// nothing. Asking first refuses the import while nothing has been stored and
// the handoff is still unspent.
//
// This MIRRORS the trigger in db/migrations/0076_account_object_limits.sql: the
// same limits, through the same `account_object_limit` function, and the same
// predicates (live = status <> 'revoked'; daily = created in the last 24 hours).
// It is a courtesy, not a control. The trigger stays the only enforcement, a
// race past this check is caught there, and the caller cleans up after it. So
// a lookup that fails answers "no refusal" and lets the trigger decide.
import type { AccountLimitRefusal } from "@/lib/account-limits";

type CountResult = PromiseLike<{ count: number | null; error: unknown }>;
interface CountQuery extends CountResult {
  eq(column: string, value: string): CountQuery;
  neq(column: string, value: string): CountQuery;
  gt(column: string, value: string): CountQuery;
}
export interface AgentCapacityDb {
  rpc(name: "account_object_limit", args: { p_user_id: string; p_column: string }): PromiseLike<{ data: unknown; error: unknown }>;
  from(table: "agents" | "agent_access_keys"): {
    select(columns: string, options: { count: "exact"; head: true }): CountQuery;
  };
}

async function limit(db: AgentCapacityDb, userId: string, column: string): Promise<number | null> {
  const { data, error } = await db.rpc("account_object_limit", { p_user_id: userId, p_column: column });
  if (error) throw new Error("limit_unreadable");
  return typeof data === "number" ? data : null;
}

async function count(query: CountResult): Promise<number> {
  const { count: value, error } = await query;
  if (error || typeof value !== "number") throw new Error("count_unreadable");
  return value;
}

export async function agentCreationRefusal(
  db: AgentCapacityDb,
  userId: string,
  options: { withKey: boolean }
): Promise<AccountLimitRefusal | null> {
  try {
    const [maxAgents, maxDaily] = await Promise.all([
      limit(db, userId, "max_agents"),
      limit(db, userId, "max_creations_per_day"),
    ]);
    const head = { count: "exact", head: true } as const;
    if (maxAgents !== null) {
      const live = await count(
        db.from("agents").select("id", head).eq("user_id", userId).neq("status", "revoked")
      );
      if (live >= maxAgents) return { kind: "agents", window: "live", limit: maxAgents };
    }
    if (maxDaily !== null) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const agents = await count(
        db.from("agents").select("id", head).eq("user_id", userId).gt("created_at", since)
      );
      if (agents >= maxDaily) return { kind: "agents", window: "daily", limit: maxDaily };
      if (options.withKey) {
        const keys = await count(
          db.from("agent_access_keys").select("id", head).eq("user_id", userId).gt("created_at", since)
        );
        if (keys >= maxDaily) return { kind: "agent_keys", window: "daily", limit: maxDaily };
      }
    }
    return null;
  } catch {
    return null;
  }
}
