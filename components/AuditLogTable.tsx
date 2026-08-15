"use client";
import { useState } from "react";
import { StatusPill, type StatusType } from "./StatusPill";
import type { DepartureRow } from "@/lib/departures";
import { CallDetailDrawer, type CallContext } from "@/components/dashboard/CallDetailDrawer";
import { useDashboardTime } from "@/components/dashboard/DashboardTime";

export type AuditLogRow = DepartureRow;

export function AuditLogTable({ logs, callContext }: { logs: AuditLogRow[]; callContext: CallContext }) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<AuditLogRow | null>(null);
  const { format, zoneLabel } = useDashboardTime();
  const shown = logs.filter((l) =>
    !filter
      ? true
      : [l.passport_id ?? "", l.jti ?? "", l.agent_access_key_id ?? "", l.credential_use_id ?? "", l.status ?? "", l.model ?? ""].some((f) =>
          f.toLowerCase().includes(filter.toLowerCase())
        )
  );

  return (
    <div className="grid">
      <input
        placeholder="Filter by identity / request / status / model…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {shown.length === 0 ? (
        <div className="pc-table-empty" data-state="empty">
          <span>{logs.length === 0 ? "No governed calls recorded yet." : "No calls match this filter."}</span>
          {filter ? (
            <button type="button" className="ghost" onClick={() => setFilter("")}>
              Clear filter
            </button>
          ) : null}
        </div>
      ) : <table>
        <thead>
          <tr>
            <th>Time · {zoneLabel}</th>
            <th>Identity</th>
            <th>Request</th>
            <th>Model</th>
            <th>Tokens</th>
            <th>Cost</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((l) => (
            <tr
              key={l.id}
              className="pc-call-row"
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
              <td className="mono" title={l.passport_id ?? undefined}>
                {l.passport_id
                  ? `${l.passport_id.slice(0, 12)}…`
                  : l.auth_method === "direct_key"
                    ? `KEY ${l.agent_access_key_id?.slice(0, 8) ?? "recorded"}`
                    : "—"}
              </td>
              <td className="mono" title={l.jti ?? undefined}>
                {(l.jti ?? l.credential_use_id ?? "—").slice(0, 8)}
              </td>
              <td>{l.model ?? "—"}</td>
              <td>
                {(l.input_tokens ?? 0) + (l.output_tokens ?? 0)}
              </td>
              <td>{l.cost_microcents != null ? `$${(l.cost_microcents / 1e8).toFixed(6)}` : "—"}</td>
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
      />
    </div>
  );
}
