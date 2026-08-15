"use client";

import { useId, useState } from "react";
import { Activity, Download, ShieldCheck } from "lucide-react";
import { AuditLogTable, type AuditLogRow } from "@/components/AuditLogTable";
import { AdminAuditTable, type AdminAuditRow } from "@/components/AdminAuditTable";
import type { CallContext } from "@/components/dashboard/CallDetailDrawer";

export function ActivityWorkspace({
  logs,
  adminRows,
  callContext,
}: {
  logs: AuditLogRow[];
  adminRows: AdminAuditRow[];
  callContext: CallContext;
}) {
  const [tab, setTab] = useState<"calls" | "operator">("calls");
  const baseId = useId();
  const callsId = `${baseId}-calls`;
  const operatorId = `${baseId}-operator`;

  const exportLoaded = () => {
    const rows = tab === "calls"
      ? logs.map((row) => ({
          created_at: row.created_at,
          passport_id: row.passport_id,
          jti: row.jti,
          auth_method: row.auth_method,
          agent_access_key_id: row.agent_access_key_id,
          credential_use_id: row.credential_use_id,
          provider: row.provider,
          model: row.model,
          input_tokens: row.input_tokens,
          output_tokens: row.output_tokens,
          cost_microcents: row.cost_microcents,
          status: row.status,
        }))
      : adminRows.map((row) => ({
          created_at: row.created_at,
          action: row.action,
          target_type: row.target_type,
          target_id: row.target_id,
          metadata: JSON.stringify(row.metadata ?? {}),
        }));
    const first = rows[0];
    if (!first) return;
    const columns = Object.keys(first);
    const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [columns.map(cell).join(","), ...rows.map((row) => columns.map((column) => cell((row as Record<string, unknown>)[column])).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `passcontrol-${tab === "calls" ? "governed-calls" : "operator-actions"}-loaded.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="pc-activity-toolbar">
      <div className="pc-tabs" role="tablist" aria-label="Activity type">
        <button
          type="button"
          role="tab"
          id={`${callsId}-tab`}
          aria-controls={callsId}
          aria-selected={tab === "calls"}
          onClick={() => setTab("calls")}
        >
          <Activity aria-hidden="true" />
          Governed calls
          <span>{logs.length}</span>
        </button>
        <button
          type="button"
          role="tab"
          id={`${operatorId}-tab`}
          aria-controls={operatorId}
          aria-selected={tab === "operator"}
          onClick={() => setTab("operator")}
        >
          <ShieldCheck aria-hidden="true" />
          Operator actions
          <span>{adminRows.length}</span>
        </button>
      </div>
        <button type="button" className="pc-activity-export" onClick={exportLoaded} disabled={tab === "calls" ? logs.length === 0 : adminRows.length === 0}>
          <Download aria-hidden="true" /> Export loaded rows
        </button>
      </div>

      <div className="pc-activity-panel">
        {tab === "calls" ? (
          <div id={callsId} role="tabpanel" aria-labelledby={`${callsId}-tab`}>
            <AuditLogTable logs={logs} callContext={callContext} />
          </div>
        ) : (
          <div id={operatorId} role="tabpanel" aria-labelledby={`${operatorId}-tab`}>
            <AdminAuditTable rows={adminRows} />
          </div>
        )}
      </div>
    </div>
  );
}
