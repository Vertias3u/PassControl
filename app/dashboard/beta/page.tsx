import { redirect } from "next/navigation";
import { BetaOperatorPanel } from "@/components/dashboard/BetaOperatorPanel";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { betaOperatorGate, loadBetaOperatorRows } from "@/lib/beta-operator";

export const dynamic = "force-dynamic";
export const metadata = { title: "Beta operations" };

export default async function BetaOperationsPage() {
  const gate = await betaOperatorGate();
  if (!gate.ok) {
    if (gate.reason === "mfa_required") redirect("/login/verify");
    redirect("/dashboard");
  }
  const rows = await loadBetaOperatorRows();
  return (
    <DashboardShell
      userId={gate.user.id}
      active="beta"
      showBetaOperator
      eyebrow="Private operator surface"
      title="Invite beta"
      description="Applications, personal invitations and the activation funnel. Every email action is explicit and owner-triggered."
    >
      <BetaOperatorPanel rows={rows} />
    </DashboardShell>
  );
}
