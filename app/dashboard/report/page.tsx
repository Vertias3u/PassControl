/**
 * Report a problem — a route, not a modal in the shell.
 *
 * The reason is cost, not styling. DashboardShell renders on every dashboard
 * page; a modal living there would make every navigation pay for the agent and
 * log reads the diagnostics preview needs. As a route, only this page pays, and
 * the sidebar entry stays a plain <Link> with no client component in the shell.
 */
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { SectionHeader } from "@/components/dashboard/SectionHeader";
import { ProblemReportForm } from "@/components/dashboard/ProblemReportForm";
import { ProblemReportHistory } from "@/components/dashboard/ProblemReportHistory";
import { userClient } from "@/lib/supabase/server";
import { serviceClient } from "@/lib/supabase";
import { needsMfaStepUp } from "@/lib/mfa";
import { buildProblemDiagnostics } from "@/lib/problem-diagnostics";
import { operatorEmails } from "@/lib/operator-allowlist";
import { loadOwnProblemReports } from "@/lib/problem-reports";

export const dynamic = "force-dynamic";
export const metadata = { title: "Report a problem" };

export default async function ProblemReportPage() {
  const db = await userClient();
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) redirect("/login");
  if (await needsMfaStepUp(db)) redirect("/login/verify");

  const now = new Date();
  // Preview only. The submit action rebuilds this server-side and throws the
  // rendered copy away — see app/dashboard/report/actions.ts.
  const preview = await buildProblemDiagnostics(db, auth.user, now).catch(() => null);
  // problem_reports is unreachable to the browser role by design, so the
  // reporter's own history comes back through the service client with an
  // explicit tenant filter and a column list that omits the operator-restricted
  // build stamp.
  const own = await loadOwnProblemReports(serviceClient(), auth.user.id).catch(() => []);

  return (
    <DashboardShell
      userId={auth.user.id}
      showBetaOperator={operatorEmails().has(auth.user.email?.trim().toLowerCase() ?? "")}
      active="report"
      eyebrow="Support"
      title="Report a problem"
      description="Tell the operator what went wrong. Diagnostics are optional, and you can read them before they are sent."
    >
      <section className="pc-section">
        <SectionHeader
          eyebrow="One report, one thread"
          title="What happened?"
          description="Specific beats polite. What you did, what you expected, what happened instead."
        />
        <div className="pc-section__body">
          {preview === null ? (
            <p className="pc-inline-notice is-warning" role="status" data-state="preview-unavailable">
              Workspace diagnostics could not be collected just now, so there is nothing to preview.
              You can still send the report — that is the part that matters.
            </p>
          ) : null}
          <ProblemReportForm preview={preview} />
        </div>
      </section>

      {own.length > 0 ? (
        <section className="pc-section">
          <SectionHeader
            eyebrow="Filed by this workspace"
            title="Your reports"
            description="What you sent, and where it got to."
          />
          <div className="pc-section__body">
            <ProblemReportHistory reports={own} />
          </div>
        </section>
      ) : null}
    </DashboardShell>
  );
}
