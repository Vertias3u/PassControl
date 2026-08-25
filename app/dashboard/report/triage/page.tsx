import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { SectionHeader } from "@/components/dashboard/SectionHeader";
import { ProblemReportTriage } from "@/components/dashboard/ProblemReportTriage";
import { betaOperatorGate } from "@/lib/beta-operator";
import { serviceClient } from "@/lib/supabase";
import { loadProblemReportRows } from "@/lib/problem-reports";

export const dynamic = "force-dynamic";
export const metadata = { title: "Problem reports" };

/**
 * Reuses betaOperatorGate rather than inventing a third allowlist: that gate
 * already means "the person who reads what beta testers send", and it requires
 * a verified TOTP factor on top of the session. The env var is
 * PASSCONTROL_BETA_OPERATOR_EMAILS — a DIFFERENT list from the system-health
 * one, so an operator who can read /dashboard/system is not automatically here.
 */
export default async function ProblemReportTriagePage() {
  const gate = await betaOperatorGate();
  if (!gate.ok) {
    if (gate.reason === "mfa_required") redirect("/login/verify");
    redirect("/dashboard");
  }

  const reports = await loadProblemReportRows(serviceClient()).catch(() => []);

  return (
    <DashboardShell
      userId={gate.user.id}
      active="report"
      showBetaOperator
      eyebrow="Private operator surface"
      title="Problem reports"
      description="What people filed, which build they filed it against, and whether anyone has looked."
    >
      <section className="pc-section">
        <SectionHeader
          eyebrow="Triage"
          title="Newest first"
          description="Reporter addresses are masked. Marking a report writes an audit row under your id, not theirs."
        />
        <div className="pc-section__body">
          <ProblemReportTriage reports={reports} />
        </div>
      </section>
    </DashboardShell>
  );
}
