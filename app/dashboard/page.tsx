// Control Tower — server component. Loads owned agents + recent audit via the
// user-scoped (RLS) client and composes the dashboard.
import { userClient } from "@/lib/supabase/server";
import { readKillState } from "@/lib/state/killswitch";
import { GlobalKillSwitchBar } from "@/components/GlobalKillSwitchBar";
import { FleetOverviewCards } from "@/components/FleetOverviewCards";
import { AgentFleetTable } from "@/components/AgentFleetTable";
import { AuditLogTable } from "@/components/AuditLogTable";
import { AdminAuditTable } from "@/components/AdminAuditTable";
import { ApiKeysManager } from "@/components/ApiKeysManager";
import { MfaManager } from "@/components/MfaManager";
import { getMfaStatus } from "@/app/dashboard/mfa-actions";
import { needsMfaStepUp } from "@/lib/mfa";
import { redirect } from "next/navigation";
import { SpendChart } from "@/components/SpendChart";
import { PassportIssuanceModal } from "@/components/PassportIssuanceModal";
import { ProviderKeysManager } from "@/components/ProviderKeysManager";
import { signOut } from "@/app/actions/auth";
import { VertiasLogo, VertiasWordmark } from "@/components/VertiasLogo";

export const dynamic = "force-dynamic";

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

  const [{ data: agents }, { data: logs }, { data: adminAudit }, kill] = await Promise.all([
    db.from("agents").select("*").order("created_at", { ascending: false }),
    db.from("agent_logs").select("*").order("created_at", { ascending: false }).limit(100),
    db
      .from("admin_audit")
      .select("id, created_at, action, target_type, target_id, metadata")
      .order("created_at", { ascending: false })
      .limit(100),
    readKillState(user.id),
  ]);

  // API keys — metadata only; key_hash is never selected.
  const { data: apiKeys } = await db
    .from("api_keys")
    .select("id, name, key_prefix, scope, last_used_at, revoked_at, created_at")
    .order("created_at", { ascending: false });

  const mfaStatus = await getMfaStatus();

  const agentList = agents ?? [];
  const blockedCalls = (logs ?? []).filter((l) => l.status.startsWith("blocked")).length;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2">
            <VertiasLogo size={22} />
            <VertiasWordmark size={16} />
            <span className="text-sm text-muted-foreground">/ Control Tower</span>
          </div>
          <div className="flex items-center gap-3">
            <PassportIssuanceModal />
            <form action={signOut}>
              <button
                type="submit"
                className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-secondary/80"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-6 py-8">
        <GlobalKillSwitchBar initialArmed={kill.userKill} />

        <FleetOverviewCards
          activeAgents={agentList.filter((a) => a.status === "active").length}
          totalAgents={agentList.length}
          spentMicrocents={agentList.reduce((s, a) => s + (a.spent_microcents ?? 0), 0)}
          blockedCalls={blockedCalls}
        />

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-bold">Spend (live)</h2>
          <SpendChart userId={user.id} initialLogs={logs ?? []} />
        </section>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-bold">Security · two-factor auth</h2>
          <MfaManager status={mfaStatus} />
        </section>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-bold">Provider keys</h2>
          <ProviderKeysManager />
        </section>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-1 text-lg font-bold">API keys</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Developer keys for the control-plane API (<code>/api/control/v1</code>). Scope
            <code> read</code> or <code>write</code>; shown once, hashed at rest, revocable.
          </p>
          <div className="overflow-x-auto">
            <ApiKeysManager keys={apiKeys ?? []} />
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-bold">Fleet</h2>
          <div className="overflow-x-auto">
            <AgentFleetTable agents={agentList} />
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-bold">Audit log</h2>
          <div className="overflow-x-auto">
            <AuditLogTable logs={logs ?? []} />
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-1 text-lg font-bold">Admin activity</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Operator actions on this account — passport issuance, key changes, suspensions, and
            kill-switch toggles.
          </p>
          <div className="overflow-x-auto">
            <AdminAuditTable rows={adminAudit ?? []} />
          </div>
        </section>
      </main>
    </div>
  );
}
