"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { setProblemReportStatus } from "@/app/dashboard/report/triage/actions";
import type { ProblemReportRow } from "@/lib/problem-reports";

const KIND_LABEL: Record<string, string> = {
  bug: "Broken",
  confusing: "Confusing",
  feature: "Missing",
  security: "Security",
};

function StatusButton({ id, status, label }: { id: string; status: string; label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" name="status" value={status} disabled={pending} formNoValidate>
      <input type="hidden" name="id" value={id} />
      {label}
    </button>
  );
}

/**
 * Operator triage. Every field here came out of ProblemReportRow's explicit
 * list, which is the only reason it is safe to render: the message is tenant
 * text and the diagnostics are an allowlist-built artifact, and neither is ever
 * interpolated into markup or a URL.
 *
 * Two things are absent on purpose: raw-HTML injection, and any href built from
 * report content. A `javascript:` URI pasted into a report body would otherwise
 * become a live link on an operator's authenticated page. Both absences are
 * asserted in tests/problem-report-triage.test.ts, which greps this file — so
 * do not name the React escape hatch here even to say it is unused.
 */
export function ProblemReportTriage({ reports }: { reports: readonly ProblemReportRow[] }) {
  const [state, action] = useActionState(setProblemReportStatus, undefined);

  if (reports.length === 0) {
    return (
      <p className="pc-inline-notice" role="status" data-state="empty">
        No reports yet.
      </p>
    );
  }

  return (
    <div className="pc-report-triage">
      {state ? (
        <p className={`pc-inline-notice ${state.ok ? "is-success" : "is-danger"}`} role={state.ok ? "status" : "alert"}>
          {state.message}
        </p>
      ) : null}
      {reports.map((report) => (
        <article key={report.id} data-status={report.status} data-kind={report.kind}>
          <header>
            <span>{KIND_LABEL[report.kind] ?? report.kind}</span>
            <strong>{report.reporter}</strong>
            <time dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleString()}</time>
          </header>

          <p className="whitespace-pre-wrap">{report.message}</p>

          <dl>
            <div>
              <dt>Status</dt>
              <dd>{report.status}</dd>
            </div>
            <div>
              <dt>Build</dt>
              <dd>{report.appVersion ?? "not recorded"}</dd>
            </div>
            <div>
              <dt>Schema</dt>
              <dd>{report.schemaHead ?? "not recorded"}</dd>
            </div>
            <div>
              <dt>Diagnostics</dt>
              <dd>{report.diagnosticsAttached ? "attached" : "not attached"}</dd>
            </div>
          </dl>

          <form action={action}>
            <StatusButton id={report.id} status="acknowledged" label="Mark seen" />
            <StatusButton id={report.id} status="resolved" label="Mark resolved" />
            <StatusButton id={report.id} status="open" label="Reopen" />
          </form>
        </article>
      ))}
    </div>
  );
}
