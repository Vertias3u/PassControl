import type { OwnProblemReport } from "@/lib/problem-reports";

const KIND_LABEL: Record<string, string> = {
  bug: "Broken",
  confusing: "Confusing",
  feature: "Missing",
  security: "Security",
};

const STATUS_LABEL: Record<string, string> = {
  open: "Waiting on the operator",
  acknowledged: "Seen",
  resolved: "Resolved",
};

/**
 * What this workspace has filed. Deliberately no message body and no build
 * stamp: the body is the reporter's own words which they already have, and the
 * stamp is operator-restricted (see lib/problem-reports.ts). This renders the
 * one thing they cannot otherwise know — whether anyone has looked yet.
 */
export function ProblemReportHistory({ reports }: { reports: readonly OwnProblemReport[] }) {
  return (
    <ul className="pc-report-history">
      {reports.map((report) => (
        <li key={report.id} data-status={report.status} data-kind={report.kind}>
          <span>{KIND_LABEL[report.kind] ?? report.kind}</span>
          <strong>{STATUS_LABEL[report.status] ?? report.status}</strong>
          <time dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleDateString()}</time>
        </li>
      ))}
    </ul>
  );
}
