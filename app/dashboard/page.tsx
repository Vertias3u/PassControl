// Control Tower — server component. Loads owned agents + recent audit via the
// user-scoped (RLS) client and composes the dashboard.
import { userClient } from "@/lib/supabase/server";
import { readKillState } from "@/lib/state/killswitch";
import { GlobalKillSwitchBar } from "@/components/GlobalKillSwitchBar";
import { FleetOverviewCards } from "@/components/FleetOverviewCards";
import { AgentFleetTable } from "@/components/AgentFleetTable";
import { visaTtlSeconds } from "@/lib/auth/visa";
import { DeparturesBoard } from "@/components/DeparturesBoard";
import { AuditLogTable } from "@/components/AuditLogTable";
import { AdminAuditTable } from "@/components/AdminAuditTable";
import { needsMfaStepUp } from "@/lib/mfa";
import { redirect } from "next/navigation";
import { SpendChart } from "@/components/SpendChart";
import { PassportIssuanceModal } from "@/components/PassportIssuanceModal";
import { KeyImportOnramp } from "@/components/KeyImportOnramp";
import Link from "next/link";
import { signOut } from "@/app/actions/auth";
import { VertiasLogo, VertiasWordmark } from "@/components/VertiasLogo";
// The shipped CLI is plain ESM and intentionally has no TypeScript declaration.
// @ts-expect-error Import the preset source of truth on the server only.
import { SIDECAR_PRESETS } from "@/cli/presets.mjs";

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

  const [{ data: agents }, { data: logs }, { data: adminAudit }, kill, providerKeys] =
    await Promise.all([
    db.from("agents").select("*").order("created_at", { ascending: false }),
    db.from("agent_logs").select("*").order("created_at", { ascending: false }).limit(100),
    db
      .from("admin_audit")
      .select("id, created_at, action, target_type, target_id, metadata")
      .order("created_at", { ascending: false })
      .limit(100),
    readKillState(user.id),
    // Head-only count: the on-ramp is a first-run affordance and needs to know
    // whether first run is over, not what the keys are. Joined into the same
    // Promise.all rather than awaited after it — the two serial round trips
    // that used to follow (api_keys, then getMfaStatus) were pure TTFB for
    // panels that now live on /dashboard/settings.
    db.from("provider_credentials").select("id", { count: "exact", head: true }),
  ]);

  const agentList = agents ?? [];
  const blockedCalls = (logs ?? []).filter((l) => l.status.startsWith("blocked")).length;
  // A count of null (the query errored) is treated as "set up": showing a
  // getting-started card because a count failed is the more annoying wrong guess.
  const needsFirstKey = (providerKeys.count ?? 1) === 0;

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
            <Link
              href="/dashboard/settings"
              className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold text-foreground no-underline hover:bg-secondary/80"
            >
              Settings
            </Link>
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

        {/* Directly under the kill switch on purpose: arming it and watching the
            next departures come back refused is the whole product in one frame.
            Reuses the `logs` already fetched above — no second query. */}
        <DeparturesBoard userId={user.id} initialRows={logs ?? []} />

        <FleetOverviewCards
          activeAgents={agentList.filter((a) => a.status === "active").length}
          totalAgents={agentList.length}
          spentMicrocents={agentList.reduce((s, a) => s + (a.spent_microcents ?? 0), 0)}
          blockedCalls={blockedCalls}
        />

        {needsFirstKey ? (
          <section className="rounded-lg border border-primary/40 bg-card p-6">
            <KeyImportOnramp integrations={SIDECAR_PRESETS.map(String)} />
          </section>
        ) : null}

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-bold">Spend (live)</h2>
          <SpendChart userId={user.id} initialLogs={logs ?? []} />
        </section>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-bold">Fleet</h2>
          <div className="overflow-x-auto">
            <AgentFleetTable agents={agentList} visaTtlSeconds={visaTtlSeconds()} />
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
