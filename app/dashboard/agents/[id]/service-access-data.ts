// What the agent page shows about one agent's service access (any-API, 0074).
//
// Its own read, never folded into the page's main agent select: a database
// without 0074 refuses a select naming `service_rules` (42703), and that must
// cost this one panel, not the whole agent page.
import type { SupabaseClient } from "@supabase/supabase-js";
import { SERVICE_CATALOG, type ServiceId } from "@/lib/services/catalog";
import { parseServiceRules } from "@/lib/services/rules";

export type AgentServiceAccess =
  | {
      state: "ok";
      /** As stored and valid; null when the agent has no rules for this service. */
      allow: { method: string; path: string; ask: boolean }[];
      /** Null when the rules name no cap (the gateway's default applies). */
      maxRequestsPerHour: number | null;
      configured: boolean;
      /** Whether the workspace holds a token for this service at all. */
      tokenStored: boolean | null;
    }
  | { state: "malformed"; tokenStored: boolean | null }
  | { state: "unavailable" };

export async function readAgentServiceAccess(
  db: SupabaseClient,
  userId: string,
  agentId: string,
  service: ServiceId
): Promise<AgentServiceAccess> {
  const [rulesRead, tokenRead] = await Promise.all([
    db.from("agents").select("service_rules").eq("id", agentId).eq("user_id", userId).maybeSingle(),
    db
      .from("provider_credentials")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("provider", SERVICE_CATALOG[service].credentialProvider),
  ]);
  if (rulesRead.error || !rulesRead.data) return { state: "unavailable" };
  const tokenStored = tokenRead.error ? null : (tokenRead.count ?? 0) > 0;

  const raw = (rulesRead.data as { service_rules?: unknown }).service_rules ?? null;
  const parsed = parseServiceRules(raw, service);
  if (parsed.kind === "malformed") return { state: "malformed", tokenStored };
  if (parsed.kind === "none") {
    return { state: "ok", allow: [], maxRequestsPerHour: null, configured: false, tokenStored };
  }
  const entry = (raw as Record<string, { max_requests_per_hour?: unknown }>)[service];
  return {
    state: "ok",
    allow: parsed.rules.allow.map((rule) => ({ method: rule.method, path: rule.path, ask: rule.ask })),
    maxRequestsPerHour: typeof entry?.max_requests_per_hour === "number" ? entry.max_requests_per_hour : null,
    configured: true,
    tokenStored,
  };
}
