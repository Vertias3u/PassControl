import { redirect } from "next/navigation";
import { userClient } from "@/lib/supabase/server";
import { needsMfaStepUp } from "@/lib/mfa";
import { readKillState } from "@/lib/state/killswitch";
import { shadowRevision } from "@/lib/policy-shadow";
import { operatorEmails } from "@/lib/operator-allowlist";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { ControlGraph } from "@/components/dashboard/ControlGraph";
import {
  buildControlGraph,
  type ControlGraphAgentRow,
  type ControlGraphGrantRow,
} from "@/lib/control-graph";
import type { DepartureRow } from "@/lib/departures";

export const dynamic = "force-dynamic";
export const metadata = { title: "Control graph" };

const AGENT_LIMIT = 75;
const LOG_LIMIT = 40;

export default async function ControlGraphPage() {
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  if (await needsMfaStepUp(db)) redirect("/login/verify");

  const now = new Date().toISOString();
  const [agentsResult, credentialsResult, grantsResult, logsResult, kill] = await Promise.all([
    db
      .from("agents")
      .select("id, name, passport_pubkey, status, allowed_scopes, budget_tokens, budget_cents, spent_tokens, spent_microcents, policy, policy_shadow, fallbacks")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(AGENT_LIMIT),
    db
      .from("provider_credentials")
      .select("provider")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(20),
    db
      .from("break_glass_grants")
      .select("id, agent_id, scopes, expires_at, revoked_at")
      .eq("user_id", user.id)
      .is("revoked_at", null)
      .gt("expires_at", now)
      .order("expires_at", { ascending: true })
      .limit(75),
    db
      .from("agent_logs")
      .select("id, agent_id, user_id, created_at, passport_id, jti, auth_method, agent_access_key_id, credential_use_id, provider, model, input_tokens, output_tokens, cost_microcents, status, latency_ms, receipt, policy_shadow_would")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(LOG_LIMIT),
    readKillState(user.id),
  ]);

  const unavailable = Boolean(
    agentsResult.error || credentialsResult.error || grantsResult.error || logsResult.error
  );
  const agents = (agentsResult.data ?? []) as ControlGraphAgentRow[];
  const logs = (logsResult.data ?? []) as DepartureRow[];
  const snapshot = buildControlGraph({
    agents,
    providerCredentials: (credentialsResult.data ?? []).map((row) => String(row.provider)),
    grants: (grantsResult.data ?? []) as ControlGraphGrantRow[],
    logs,
    killArmed: kill.userKill || kill.platformKill,
    denylistedAgentIds: kill.denylist,
  });
  const callContext = {
    shadowRevisions: Object.fromEntries(
      (agentsResult.data ?? []).map((agent) => [agent.id, shadowRevision(agent.policy_shadow ?? null)])
    ),
  };

  return (
    <DashboardShell
      userId={user.id}
      showBetaOperator={operatorEmails().has(user.email?.trim().toLowerCase() ?? "")}
      active="graph"
      eyebrow="Live capability topology"
      title="Control graph"
      description="Current capability and newly recorded calls. The graph never reconstructs history with today's policy."
      contentClassName="pc-control-graph-page"
    >
      {unavailable ? (
        <section className="pc-control-graph-unavailable" role="status">
          <strong>Control graph unavailable</strong>
          <span>One or more read-only topology sources could not be loaded. No empty-state claim is being made.</span>
        </section>
      ) : (
        <ControlGraph userId={user.id} initialSnapshot={snapshot} callContext={callContext} />
      )}
    </DashboardShell>
  );
}
