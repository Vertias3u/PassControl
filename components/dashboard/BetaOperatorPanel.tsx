"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import type { BetaOperatorRow } from "@/lib/beta-operator";
import {
  declineBetaApplication,
  sendBetaFeedbackRequest,
  sendBetaInvite,
  sendBetaNudge,
  withdrawBetaApplication,
  type BetaOperatorActionState,
} from "@/app/dashboard/beta/actions";

function ActionForm({
  row,
  action,
  label,
  confirmation,
}: {
  row: BetaOperatorRow;
  action: (_state: BetaOperatorActionState, form: FormData) => Promise<BetaOperatorActionState>;
  label: string;
  confirmation?: "DECLINE" | "WITHDRAW";
}) {
  const [state, formAction] = useActionState(action, undefined);
  return (
    <form action={formAction} className="pc-beta-action">
      <input type="hidden" name="application_id" value={row.id} />
      {confirmation ? <input name="confirmation" aria-label={`Type ${confirmation} to confirm`} placeholder={confirmation} /> : null}
      <ActionButton label={label} />
      {state ? <small data-state={state.ok ? "success" : "error"}>{state.message}</small> : null}
    </form>
  );
}

function ActionButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return <button type="submit" className="ghost" disabled={pending}>{pending ? "Working…" : label}</button>;
}

function Stage({ row }: { row: BetaOperatorRow }) {
  const steps = [
    ["invite", Boolean(row.invitedAt)],
    ["signup", row.signedUp],
    ["provider", row.providerReady],
    ["agent", row.agentReady],
    ["attempt", row.attemptedCall],
    ["success", row.successfulCall],
  ] as const;
  return <div className="pc-beta-funnel" aria-label="Activation funnel">{steps.map(([label, done]) => <span key={label} data-state={done ? "done" : "waiting"}>{label}</span>)}</div>;
}

export function BetaOperatorPanel({ rows }: { rows: BetaOperatorRow[] }) {
  const totals = {
    applied: rows.length,
    invited: rows.filter((row) => row.invitedAt).length,
    signedUp: rows.filter((row) => row.signedUp).length,
    successful: rows.filter((row) => row.successfulCall).length,
  };
  return (
    <div className="pc-beta-operator">
      <div className="pc-metric-grid">
        {Object.entries(totals).map(([label, value]) => <div className="pc-metric-card" key={label}><div><p className="pc-metric-card__label">{label}</p><strong className="pc-metric-card__value">{value}</strong></div></div>)}
      </div>
      {rows.length === 0 ? <div className="pc-table-empty">No beta applications yet.</div> : rows.map((row) => (
        <article className="pc-beta-applicant" key={row.id} data-application-status={row.status}>
          <header>
            <div><strong>{row.email}</strong><small>{row.integration} · {row.provider} · {row.monthlyCallBucket} calls/month</small></div>
            <span>{row.status}</span>
          </header>
          <p>{row.useCase}</p>
          <Stage row={row} />
          <dl>
            <div><dt>Applied</dt><dd>{new Date(row.appliedAt).toLocaleString()}</dd></div>
            <div><dt>Last call</dt><dd>{row.lastCallAt ? new Date(row.lastCallAt).toLocaleString() : "None"}</dd></div>
            <div><dt>Feedback</dt><dd>{row.feedbackReceived ? "Received" : "Not received"}</dd></div>
            <div><dt>Setup nudge</dt><dd>{row.nudgeSent ? "Sent" : row.nudgePending ? "Delivery state unresolved" : "Not sent"}</dd></div>
            <div><dt>Feedback request</dt><dd>{row.feedbackRequestSent ? "Sent" : row.feedbackRequestPending ? "Delivery state unresolved" : "Not sent"}</dd></div>
          </dl>
          <div className="pc-beta-applicant__actions">
            {!row.signedUp && !["declined", "withdrawn"].includes(row.status) ? <ActionForm row={row} action={sendBetaInvite} label={row.invitedAt ? "Reissue invite" : "Send invite"} /> : null}
            {row.signedUp && !row.attemptedCall && !row.nudgeSent && !row.nudgePending ? <ActionForm row={row} action={sendBetaNudge} label="Send one setup nudge" /> : null}
            {row.successfulCall && !row.feedbackRequestSent && !row.feedbackRequestPending && !row.feedbackReceived ? <ActionForm row={row} action={sendBetaFeedbackRequest} label="Request feedback once" /> : null}
            {!row.signedUp && !["declined", "withdrawn"].includes(row.status) ? <ActionForm row={row} action={declineBetaApplication} label="Decline" confirmation="DECLINE" /> : null}
            {!row.signedUp && !["declined", "withdrawn"].includes(row.status) ? <ActionForm row={row} action={withdrawBetaApplication} label="Record withdrawal" confirmation="WITHDRAW" /> : null}
          </div>
        </article>
      ))}
    </div>
  );
}
