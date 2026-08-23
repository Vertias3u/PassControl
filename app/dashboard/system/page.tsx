import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { SystemHealthRefresh } from "@/components/dashboard/SystemHealthRefresh";
import { SystemHealthRestricted } from "@/components/dashboard/SystemHealthRestricted";
import { SystemHealthSnapshotView } from "@/components/dashboard/SystemHealthSnapshot";
import { getSystemHealthSnapshot } from "@/lib/system-health";
import { systemOperatorGate } from "@/lib/system-health/operator";
import { betaOperatorEmails } from "@/lib/beta-launch";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;
export const metadata = { title: "System health" };

export default async function SystemHealthPage() {
  const gate = await systemOperatorGate();

  // Redirect only where the destination can actually resolve the refusal:
  // /login for no session, /login/verify for a session that can still step up.
  // Every other refusal is explained in place. Bouncing them to /dashboard was
  // silent — an authorized-looking operator lost the page with no way to learn
  // whether they were unauthorized or the instance was never configured.
  if (!gate.ok) {
    if (gate.reason === "unauthenticated") redirect("/login");
    if (gate.reason === "step_up_required") redirect("/login/verify");
    if (!gate.user) redirect("/dashboard");
    return (
      <DashboardShell
        userId={gate.user.id}
        active="system"
        showBetaOperator={betaOperatorEmails().has(gate.user.email?.trim().toLowerCase() ?? "")}
        eyebrow="Restricted instance diagnostic"
        title="System health"
        description="This surface is limited to the operators a deployment names."
      >
        <SystemHealthRestricted reason={gate.reason} />
      </DashboardShell>
    );
  }

  const snapshot = await getSystemHealthSnapshot();
  return (
    <DashboardShell
      userId={gate.user.id}
      active="system"
      showBetaOperator={betaOperatorEmails().has(gate.user.email?.trim().toLowerCase() ?? "")}
      eyebrow="Restricted instance diagnostic"
      title="System health"
      description="A safe, point-in-time view of local application wiring and dependencies."
      actions={<SystemHealthRefresh />}
    >
      <SystemHealthSnapshotView snapshot={snapshot} />
    </DashboardShell>
  );
}
