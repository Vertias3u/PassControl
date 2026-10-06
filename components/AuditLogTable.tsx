"use client";
import { useState } from "react";
import { StatusPill, type StatusType } from "./StatusPill";
import type { DepartureRow } from "@/lib/departures";
import { CallDetailDrawer, type CallContext } from "@/components/dashboard/CallDetailDrawer";
import { useDashboardTime } from "@/components/dashboard/DashboardTime";
import { callOutcome, reportedTokens, reportedTokensText, wasForwarded } from "@/lib/call-outcome";

export type AuditLogRow = DepartureRow;

export function AuditLogTable({
  logs,
  callContext,
  logsAvailable,
}: {
  logs: AuditLogRow[];
  callContext: CallContext;
  /** Whether the history behind this table was read. REQUIRED — see FleetOverviewCards. */
  logsAvailable: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<AuditLogRow | null>(null);
  const { format, zoneLabel } = useDashboardTime();
  const nameOf = (row: AuditLogRow) => (row.agent_id ? callContext.agentNames[row.agent_id] : undefined);
  const shown = logs.filter((l) =>
    !filter
      ? true
      : [
          nameOf(l) ?? "",
          l.agent_id ?? "",
          l.passport_id ?? "",
          l.jti ?? "",
          l.agent_access_key_id ?? "",
          l.credential_use_id ?? "",
          l.status ?? "",
          callOutcome(l.status).label,
          l.model ?? "",
        ].some((f) => f.toLowerCase().includes(filter.toLowerCase()))
  );

  return (
    <div className="grid">
      <input
        placeholder="Filter by agent name / request / outcome / model…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {shown.length === 0 ? (
        <div className="pc-table-empty" data-state={logsAvailable ? "empty" : "unavailable"}>
          <span>
            {!logsAvailable
              ? "The call history could not be read. This table is unavailable — it is not a record that nothing happened."
              : logs.length === 0
                ? "No governed calls recorded yet."
                : "No calls match this filter."}
          </span>
          {filter ? (
            <button type="button" className="ghost" onClick={() => setFilter("")}>
              Clear filter
            </button>
          ) : null}
        </div>
      ) : <table className="pc-audit-table">
        <thead>
          <tr>
            <th>Time · {zoneLabel}</th>
            <th>Agent</th>
            <th>Request</th>
            <th>Model</th>
            <th>Reported tokens</th>
            <th>Est. cost</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((l) => (
            <tr
              key={l.id}
              className="pc-call-row"
              data-outcome-category={callOutcome(l.status).category}
              data-call-state={selected?.id === l.id ? "selected" : "idle"}
              role="button"
              tabIndex={0}
              onClick={() => setSelected(l)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelected(l);
                }
              }}
            >
              <td className="muted">
                <time dateTime={l.created_at ?? undefined}>{format(l.created_at, "time")}</time>
              </td>
              <td title={l.passport_id ?? l.agent_access_key_id ?? undefined} data-agent-name={nameOf(l) ?? ""}>
                {nameOf(l) || (l.agent_id ? `Agent ${l.agent_id.slice(0, 8)}` : "—")}
                <small className="mono block muted">
                  {l.auth_method === "direct_key"
                    ? `Direct Agent Key ${l.agent_access_key_id?.slice(0, 8) ?? ""}`
                    : l.passport_id
                      ? `Passport ${l.passport_id.slice(0, 12)}…`
                      : ""}
                </small>
              </td>
              <td className="mono" title={l.jti ?? undefined}>
                {(l.jti ?? l.credential_use_id ?? "—").slice(0, 8)}
              </td>
              <td>{l.model ?? "—"}</td>
              <td>{reportedTokensText(reportedTokens(l))}</td>
              <td>
                {!wasForwarded(callOutcome(l.status).category)
                  ? "—"
                  : l.cost_microcents != null
                    ? `$${(l.cost_microcents / 1e8).toFixed(6)}`
                    : "no recorded cost"}
              </td>
              <td>
                <StatusPill status={l.status as StatusType} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>}
      <CallDetailDrawer
        row={selected}
        open={Boolean(selected)}
        onOpenChange={(open) => { if (!open) setSelected(null); }}
        currentShadowRevision={selected?.agent_id ? callContext.shadowRevisions[selected.agent_id] ?? null : null}
        agentName={selected?.agent_id ? callContext.agentNames[selected.agent_id] ?? null : null}
      />
    </div>
  );
}
