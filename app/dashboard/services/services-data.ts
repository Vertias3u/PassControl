// What the Services page shows (any-API phase 2, slice D): per service, the
// token in use, the workspace's stop switch for it, which agents can reach it,
// and the last hour's calls.
//
// Each part is its own read and degrades on its own. A failed read is
// "unavailable", never "none" or zero: "no agent has GitHub access" and "we
// could not tell which agents have GitHub access" send an operator in opposite
// directions. Every read filters on user_id in code, so the page is correct
// whichever client it is handed.
import type { SupabaseClient } from "@supabase/supabase-js";
import { SERVICE_CATALOG, SERVICE_IDS, type ServiceId } from "@/lib/services/catalog";
import { parseServiceRules } from "@/lib/services/rules";

export type ServiceTokenState =
  | { state: "stored"; label: string | null; createdAt: string; count: number }
  | { state: "none" }
  | { state: "unavailable" };

export type ServiceAgentAccess =
  | { id: string; name: string; state: "rules"; rules: number; writes: number; cap: number | null }
  | { id: string; name: string; state: "malformed" };

export interface ServiceOverview {
  id: ServiceId;
  label: string;
  /** The workspace's per-service stop, as observed. null = could not read. */
  stopped: boolean | null;
  token: ServiceTokenState;
  agents:
    | { state: "ok"; total: number; withAccess: ServiceAgentAccess[] }
    | { state: "unavailable" };
  lastHour: { state: "ok"; calls: number; refused: number } | { state: "unavailable" };
}

// Far above any real fleet; bounded so the page cannot become an unbounded scan.
const AGENT_SCAN = 500;
const HOUR_MS = 60 * 60 * 1000;

export async function readServicesOverview(
  db: SupabaseClient,
  userId: string,
  options: { observeKill: (userId: string, service: ServiceId) => Promise<boolean | null>; now?: Date }
): Promise<ServiceOverview[]> {
  const since = new Date((options.now ?? new Date()).getTime() - HOUR_MS).toISOString();

  // Agents once for every service: their rules live in one column.
  const agentsRead = await Promise.resolve(
    db
      .from("agents")
      .select("id, name, status, service_rules")
      .eq("user_id", userId)
      .order("created_at", { ascending: true })
      .limit(AGENT_SCAN)
  ).then(
    (r) => r,
    () => ({ data: null, error: { code: "threw" } })
  );

  return Promise.all(
    SERVICE_IDS.map(async (service): Promise<ServiceOverview> => {
      const entry = SERVICE_CATALOG[service];
      const [stopped, tokens, calls, refused] = await Promise.all([
        options.observeKill(userId, service).catch(() => null),
        db
          .from("provider_credentials")
          .select("id, label, is_active, created_at")
          .eq("user_id", userId)
          .eq("provider", entry.credentialProvider)
          .order("created_at", { ascending: false }),
        db
          .from("agent_logs")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("provider", entry.credentialProvider)
          .gte("created_at", since),
        db
          .from("agent_logs")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("provider", entry.credentialProvider)
          .gte("created_at", since)
          .like("status", "blocked_%"),
      ]);

      let token: ServiceTokenState;
      if (tokens.error || !Array.isArray(tokens.data)) token = { state: "unavailable" };
      else if (tokens.data.length === 0) token = { state: "none" };
      else {
        const rows = tokens.data as { label: string | null; is_active?: boolean; created_at: string }[];
        // The one the gateway injects: active first, as get_provider_key picks.
        const inUse = rows.find((row) => row.is_active) ?? rows[rows.length - 1]!;
        token = { state: "stored", label: inUse.label ?? null, createdAt: inUse.created_at, count: rows.length };
      }

      let agents: ServiceOverview["agents"];
      if (agentsRead.error || !Array.isArray(agentsRead.data)) agents = { state: "unavailable" };
      else {
        const rows = agentsRead.data as { id: string; name: string; service_rules?: unknown }[];
        const withAccess: ServiceAgentAccess[] = [];
        for (const row of rows) {
          const parsed = parseServiceRules(row.service_rules ?? null, service);
          if (parsed.kind === "malformed") withAccess.push({ id: row.id, name: row.name, state: "malformed" });
          else if (parsed.kind === "rules" && parsed.rules.allow.length > 0) {
            const raw = (row.service_rules as Record<string, { max_requests_per_hour?: unknown }>)[service];
            withAccess.push({
              id: row.id,
              name: row.name,
              state: "rules",
              rules: parsed.rules.allow.length,
              writes: parsed.rules.allow.filter((rule) => entry.isWriteRule(rule)).length,
              cap: typeof raw?.max_requests_per_hour === "number" ? raw.max_requests_per_hour : null,
            });
          }
        }
        agents = { state: "ok", total: rows.length, withAccess };
      }

      const lastHour: ServiceOverview["lastHour"] =
        calls.error || refused.error || typeof calls.count !== "number" || typeof refused.count !== "number"
          ? { state: "unavailable" }
          : { state: "ok", calls: calls.count, refused: refused.count };

      return { id: service, label: entry.label, stopped, token, agents, lastHour };
    })
  );
}
