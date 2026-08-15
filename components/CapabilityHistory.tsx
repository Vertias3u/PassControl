// What has been done to this passport, newest first.
//
// The Control Tower could always answer "what can this agent do now". It could
// never answer "who widened it, when, and from what" — which is the question
// asked after something has already gone wrong, and the one an auditor asks
// first.
//
// The design constraint is entirely about honesty. Rows written before the
// editors recorded from/to carry the field name and nothing else, so this panel
// renders them as changed-but-unrecorded rather than diffing against the
// current value. A gap it admits to is worth more than a diff it guessed, and
// on this panel specifically, a guess would be indistinguishable from evidence.
import type { CapabilityChange } from "@/lib/audit-history";
import { useDashboardTime } from "@/components/dashboard/DashboardTime";

export function CapabilityHistory({ history }: { history: readonly CapabilityChange[] }) {
  const { format } = useDashboardTime();
  const when = (at: string | null): string =>
    at && Number.isFinite(Date.parse(at)) ? format(at) : "date not recorded";
  if (history.length === 0) {
    return (
      <p
        className="m-0 rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground"
        data-state="empty"
      >
        Nothing recorded yet. Changes to this passport&rsquo;s scope, fallbacks, budgets and
        status are written here as they happen.
      </p>
    );
  }

  return (
    <ol className="m-0 grid list-none gap-3 p-0">
      {history.map((change) => (
        <li
          key={change.id}
          className="grid gap-1 rounded-lg border border-border bg-secondary/40 p-4"
          data-state={
            change.recorded ? "recorded" : change.snapshot === "unreadable" ? "damaged" : "unrecorded"
          }
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-semibold text-foreground">{change.summary}</span>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              {when(change.at)}
            </span>
          </div>

          {change.detail && change.detail.length > 0 ? (
            <ul className="m-0 grid list-none gap-1 p-0">
              {change.detail.map((line, index) => (
                <li
                  key={index}
                  className="m-0 break-words font-mono text-xs leading-5 text-muted-foreground"
                >
                  {line}
                </li>
              ))}
            </ul>
          ) : null}

          {/* Said out loud, not implied by an absent diff. An empty row is
              ambiguous; this is not.

              The two gaps are NOT the same fact and must not read the same. A
              row that predates the record never had a previous value written
              down. A row whose stored value cannot be read did have one, and it
              is gone — that is a loss in an append-only trail, and it is worth
              investigating rather than shrugging at. Rendering both with the
              "predates the record" sentence is how truncated snapshots passed
              for old rows. */}
          {change.recorded ? null : change.snapshot === "unreadable" ? (
            <p className="m-0 text-xs leading-5 text-muted-foreground">
              A value was recorded for this change, but what is stored cannot be read — it was cut
              short, omitted or written in a shape this page does not understand. It is shown
              rather than hidden; the raw row is still in the audit trail.
            </p>
          ) : (
            <p className="m-0 text-xs leading-5 text-muted-foreground">
              This change predates the record of previous values, so what it changed from is not
              known. It is shown rather than hidden.
            </p>
          )}

          <p className="m-0 text-xs uppercase tracking-[0.14em] text-muted-foreground">
            {change.via === "api" ? "via the control API" : "from the Control Tower"}
          </p>
        </li>
      ))}
    </ol>
  );
}
