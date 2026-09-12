// Control Tower — server component. Loads owned agents + recent audit via the
// user-scoped (RLS) client and composes the dashboard.
import { userClient } from "@/lib/supabase/server";
import { readKillState } from "@/lib/state/killswitch";
import { GlobalKillSwitchBar } from "@/components/GlobalKillSwitchBar";
import { FleetOverviewCards } from "@/components/FleetOverviewCards";
import { AgentFleetTable } from "@/components/AgentFleetTable";
import { visaTtlSeconds } from "@/lib/auth/visa";
import { DeparturesBoard } from "@/components/DeparturesBoard";
import { needsMfaStepUp } from "@/lib/mfa";
import { redirect } from "next/navigation";
import { SpendChart } from "@/components/SpendChart";
import { SpendReconciliation } from "@/components/SpendReconciliation";
import { PassportIssuanceModal } from "@/components/PassportIssuanceModal";
import { DirectAgentConnect } from "@/components/DirectAgentConnect";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { SectionHeader } from "@/components/dashboard/SectionHeader";
import { ActivityWorkspace } from "@/components/dashboard/ActivityWorkspace";
import { FleetAttentionQueue } from "@/components/dashboard/FleetAttentionQueue";
import {
  buildFleetAttention,
  summariseFleetAttention,
  withLastSeenFromLogs,
} from "@/lib/dashboard-attention";
import { partitionByClass } from "@/lib/call-class";
import { shadowRevision } from "@/lib/policy-shadow";
import { OperationsPanel } from "@/components/dashboard/OperationsPanel";
import { FirstCallActivation } from "@/components/dashboard/FirstCallActivation";
import { latestControlExerciseAt, onboardingStateHidden } from "@/lib/first-call-activation";
import { buildCloudSupportBundle, type CloudOperationsSignals } from "@/lib/cloud-operations";
import { loadInstanceSigner, instanceIssuer } from "@/lib/crypto/instanceKey";
import { isSentryConfigured } from "@/lib/observability";
import { isProvider } from "@/lib/providers";
import { operatorEmails } from "@/lib/operator-allowlist";
import { redis } from "@/lib/state/redis";
import {
  readDeclaredKeyStorageMany,
  toDeclaredKeyStorageView,
  type DeclaredKeyStorageView,
} from "@/lib/passport-key-storage";
import { readKeyCustodyExpectation } from "@/lib/key-custody-expectation";
import { serviceClient } from "@/lib/supabase";
import { buildSpendReconciliation } from "@/lib/spend-reconciliation";
// The shipped CLI is plain ESM and intentionally has no TypeScript declaration.
// @ts-expect-error Import the preset source of truth on the server only.
import { SIDECAR_PRESETS } from "@/cli/presets.mjs";

export const dynamic = "force-dynamic";

const ATTENTION_SCAN_DAYS = 30;
const ATTENTION_SCAN_LIMIT = 2_000;

/**
 * Declared key custody for every passport agent on the page.
 *
 * Fails to `{}` rather than to an error: nothing on this dashboard should go
 * down because an agent's self-report could not be read, and the view already
 * knows how to say "nothing declared" honestly. `last_seen_at` here is the
 * log-resolved value, so a claim left behind by later activity is detectable —
 * the fleet cell does not render that, but the view carries it either way.
 */
async function buildKeyCustodyViews(
  agents: { id: string; passport_pubkey: string | null; last_seen_at: string | null }[]
): Promise<Record<string, DeclaredKeyStorageView>> {
  const passportAgents = agents.filter((agent) => agent.passport_pubkey);
  if (!passportAgents.length) return {};
  let declarations: Awaited<ReturnType<typeof readDeclaredKeyStorageMany>> = {};
  try {
    declarations = await readDeclaredKeyStorageMany(
      redis(),
      passportAgents.map((agent) => agent.id)
    );
  } catch {
    // An unconfigured or unreachable Redis. Every agent then reads as
    // undeclared, which is true: this instance has not heard a claim.
  }
  return Object.fromEntries(
    passportAgents.map((agent) => [
      agent.id,
      toDeclaredKeyStorageView(declarations[agent.id] ?? null, agent.last_seen_at),
    ])
  );
}

export default async function ControlTowerPage() {
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();

  if (!user) {
    return (
      <main className="mx-auto mt-[12vh] max-w-md rounded-lg border border-border bg-card p-6">
        <h1 className="text-xl font-bold">PassControl</h1>
        <p className="text-muted-foreground">Sign in to access your Agent Control Tower.</p>
      </main>
    );
  }

  // MFA gate: a logged-in user with an enrolled factor must complete the TOTP
  // step-up (aal2) before the Control Tower. Non-MFA users pass straight through.
  if (await needsMfaStepUp(db)) redirect("/login/verify");

  const renderedAt = new Date();
  const attentionCutoff = new Date(renderedAt.getTime() - ATTENTION_SCAN_DAYS * 86_400_000).toISOString();
  const [
    { data: agents, error: agentsError },
    { data: logs, error: logsError },
    { data: adminAudit },
    kill,
    providerKeys,
    quota,
    { data: onboardingState },
    keyCustodyExpectation,
  ] =
    await Promise.all([
    db.from("agents").select("*").order("created_at", { ascending: false }),
    db
      .from("agent_logs")
      .select("id, agent_id, user_id, created_at, passport_id, jti, auth_method, agent_access_key_id, credential_use_id, provider, model, input_tokens, output_tokens, cost_microcents, enforced_tokens, enforced_microcents, status, latency_ms, receipt, policy_shadow_would")
      .gte("created_at", attentionCutoff)
      .order("created_at", { ascending: false })
      .limit(ATTENTION_SCAN_LIMIT),
    db
      .from("admin_audit")
      .select("id, created_at, action, target_type, target_id, metadata")
      .order("created_at", { ascending: false })
      .limit(100),
    readKillState(user.id),
    // The activation path needs the provider name so a tenant that stored an
    // Anthropic key does not receive an OpenAI-first agent form. This remains
    // one bounded metadata-only read; no Vault ids or credential values cross
    // into the dashboard. Joined into the same
    // Promise.all rather than awaited after it — the two serial round trips
    // that used to follow (api_keys, then getMfaStatus) were pure TTFB for
    // panels that now live on /dashboard/settings.
    db
      .from("provider_credentials")
      .select("provider", { count: "exact" })
      .order("created_at", { ascending: false })
      .limit(6),
    Promise.resolve(null),
    db
      .from("onboarding_state")
      .select("dismissed_at, completed_at")
      .eq("user_id", user.id)
      .maybeSingle(),
    // Its own query, and its own read function: on an instance that has not
    // applied 0051 the column does not exist, and PostgREST fails the whole
    // request for an unknown column. Kept out of any shared select so the blast
    // radius of an unapplied migration is this one line of the fleet table.
    readKeyCustodyExpectation(db, user.id),
  ]);

  const agentList = agents ?? [];
  // ONE read, fanned out to seven consumers — so its failure has to travel with
  // it. `logs ?? []` used to hand every one of them an empty array that reads
  // exactly like a quiet workspace, while the operations appendix on this same
  // page correctly said the read was unavailable. The page gave both answers at
  // once and the confident one won: 0 refused calls, an empty departures board,
  // no recent spend, no call history, and no recent failures in the support
  // bundle — during the exact fault that makes audit evidence least reliable.
  //
  // A required `logsAvailable` prop on every consumer, not an optional one: a
  // default would let the next surface to read these rows re-introduce the same
  // claim by not thinking about it.
  //
  // Deliberately NOT a retry or a fallback query. An unreadable log is an
  // operational fact and the operator needs to see it, not a second attempt
  // that turns a database fault into a slower page.
  const logsAvailable = !logsError;
  const attentionLogRows = logs ?? [];
  // Resolved against the log scan for the FLEET TABLE only.
  //
  // `agents.last_seen_at` alone lags by up to a day (the nightly reconcile flush)
  // and was never written at all for a Direct Agent Key agent, so the table read
  // "never" beside an operator queue that named the exact minute — same fact,
  // two answers, one viewport. Both now go through `withLastSeenFromLogs`.
  //
  // Deliberately NOT applied to `agentList` wholesale: the support bundle below
  // reports the raw column, and a NULL there is diagnostic evidence that the
  // reconcile flush is not running. Filling it in for a screen is presentation;
  // filling it in inside a bundle an operator hands to support would hide the
  // very failure the bundle exists to surface.
  const fleetAgents = withLastSeenFromLogs(agentList, attentionLogRows, renderedAt);
  // ONE extra Redis round trip, and it cannot join the Promise.all above because
  // it needs the agent ids that query returns. One `mget` for the whole page
  // rather than a `get` per row — this file already counts its round trips, and
  // the fleet table is the surface people scan fastest.
  //
  // Passport agents only: a Direct Agent Key has no passport private key, so
  // asking where it keeps one would turn a question nobody asked into an
  // unanswered one. Those rows are told apart in the table by passport_pubkey.
  const [keyCustody, spendReconciliation] = await Promise.all([
    buildKeyCustodyViews(fleetAgents),
    // `serviceClient` uncalled on purpose: the builder constructs it inside its
    // own failure domain, so an absent service-role env reads as unavailable
    // instead of throwing this page away. See lib/spend-reconciliation.ts.
    buildSpendReconciliation(serviceClient, user.id, agentList),
  ]);
  const displayLogs = attentionLogRows.slice(0, 100);
  const attentionQueue = buildFleetAttention(agentList, attentionLogRows);
  const blockedCalls = displayLogs.filter((l) => l.status.startsWith("blocked")).length;
  // Split for presentation only. The query above is unchanged and still fetches
  // every row — nothing is filtered out of the fetch, so the window does not
  // silently shrink, and the departures board below still receives all of it.
  // What changes is only what the headline counts call "agent activity".
  const { housekeeping: housekeepingLogs, inference: inferenceLogs } = partitionByClass(displayLogs);
  const callContext = {
    shadowRevisions: Object.fromEntries(
      agentList.map((agent) => [agent.id, shadowRevision(agent.policy_shadow ?? null)])
    ),
  };
  // A count of null (the query errored) is treated as "set up": showing a
  // getting-started card because a count failed is the more annoying wrong guess.
  const needsFirstKey = (providerKeys.count ?? 1) === 0;
  // Read off the admin_audit rows already fetched above — the activation guide's
  // last step must not cost a fourth round trip for a rail most tenants have
  // dismissed. Bounded to the same newest-100 window; completion persistence
  // re-checks the full ordered history inside complete_onboarding().
  const controlExerciseAt = latestControlExerciseAt(adminAudit ?? []);
  const firstStoredProvider = providerKeys.data?.map((row) => row.provider).find(isProvider);
  const operationsSignals: CloudOperationsSignals = {
    providerCredentials: providerKeys.error
      ? "unavailable"
      : (providerKeys.count ?? 0) > 0
        ? "configured"
        : "missing",
    receiptSigning: loadInstanceSigner() && instanceIssuer() ? "configured" : "missing",
    observability: isSentryConfigured() ? "configured" : "missing",
    agentRegistry: agentsError ? "unavailable" : "available",
    activityLog: logsError ? "unavailable" : "available",
  };
  const supportBundle = buildCloudSupportBundle({
    generatedAt: renderedAt.toISOString(),
    quota,
    signals: operationsSignals,
    controls: { workspaceKillArmed: kill.userKill, platformKillArmed: kill.platformKill },
    agents: agentList,
    logs: displayLogs,
  });

  return (
    <DashboardShell
      userId={user.id}
      showBetaOperator={operatorEmails().has(user.email?.trim().toLowerCase() ?? "")}
      active="overview"
      title="Fleet overview"
      description="Identity, capability, spend, and every governed call in one operational view."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <DirectAgentConnect initialProvider={firstStoredProvider} />
          <PassportIssuanceModal userId={user.id} integrations={SIDECAR_PRESETS.map(String)} />
        </div>
      }
    >
        <section id="overview" aria-label="Fleet safety controls">
        <GlobalKillSwitchBar initialArmed={kill.userKill} />
        </section>

        <FirstCallActivation
          userId={user.id}
          providerConfigured={!needsFirstKey}
          controlExerciseAt={controlExerciseAt}
          initiallyHidden={onboardingStateHidden(onboardingState)}
          agents={agentList.map((agent) => ({
            id: agent.id,
            name: agent.name,
            status: agent.status,
            identityKind: agent.passport_pubkey ? "passport" as const : "direct_key" as const,
          }))}
          initialLogs={displayLogs.map((row) => ({
            id: row.id,
            agent_id: row.agent_id,
            provider: row.provider,
            model: row.model,
            status: row.status,
            receipt: row.receipt,
            auth_method: row.auth_method,
            created_at: row.created_at,
          }))}
          integrations={SIDECAR_PRESETS.map(String)}
          defaultProvider={firstStoredProvider}
          logsAvailable={logsAvailable}
        />

        <FleetOverviewCards
          activeAgents={agentList.filter((a) => a.status === "active").length}
          totalAgents={agentList.length}
          spentMicrocents={agentList.reduce((s, a) => s + (a.spent_microcents ?? 0), 0)}
          blockedCalls={blockedCalls}
          recentCalls={inferenceLogs.length}
          housekeepingCalls={housekeepingLogs.length}
          attention={summariseFleetAttention(attentionQueue)}
          logsAvailable={logsAvailable}
        />

        {/* Directly under the kill switch on purpose: arming it and watching the
            next departures come back refused is the whole product in one frame.
            Reuses the `logs` already fetched above — no second query. */}
        <section id="activity" className="pc-section scroll-mt-28">
          <SectionHeader
            eyebrow="Gateway now"
            title="Live calls"
            description="Newest governed calls first. This view is a live 40-row operational window, not complete history."
          />
          <div className="pc-section__body p-0!">
        <DeparturesBoard userId={user.id} initialRows={displayLogs} callContext={callContext} logsAvailable={logsAvailable} />
          </div>
        </section>

        <section id="spend" className="pc-section scroll-mt-28">
          <SectionHeader
            eyebrow="Recent usage"
            title="Spend and tokens"
            description="A live window of up to 200 loaded call records. The figure charged against each agent's cap comes from its own counter, and includes a conservative estimate for any call PassControl could not price."
          />
          <div className="pc-section__body">
          <SpendReconciliation value={spendReconciliation} />
          <SpendChart userId={user.id} initialLogs={displayLogs} logsAvailable={logsAvailable} />
          </div>
        </section>

        <section id="fleet" className="pc-section scroll-mt-28">
          <SectionHeader
            eyebrow="Agent registry"
            title="Fleet"
            description="Find an agent, understand its budget posture, or open its identity, capability, and public-listing controls."
          />
          <div className="pc-section__body p-0!">
            <FleetAttentionQueue items={attentionQueue} />
            <AgentFleetTable
              agents={fleetAgents}
              visaTtlSeconds={visaTtlSeconds()}
              keyCustody={keyCustody}
              keyCustodyExpectation={keyCustodyExpectation.expectation}
              logsAvailable={logsAvailable}
            />
          </div>
        </section>

        <section className="pc-section">
          <SectionHeader
            eyebrow="Forensic record"
            title="Activity history"
            description="Latest 100 call rows and operator actions. Filters apply only to rows currently loaded on this page."
          />
          <div className="pc-section__body">
            <ActivityWorkspace logs={displayLogs} adminRows={adminAudit ?? []} callContext={callContext} logsAvailable={logsAvailable} />
          </div>
        </section>

        <OperationsPanel quota={quota} signals={operationsSignals} supportBundle={supportBundle} />
    </DashboardShell>
  );
}
