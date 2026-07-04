"use client";
import { useState } from "react";
import { StatusPill, type StatusType } from "./StatusPill";

interface Log {
  id: string;
  created_at: string;
  passport_id: string;
  jti: string;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_microcents: number | null;
  status: string;
}

export function AuditLogTable({ logs }: { logs: Log[] }) {
  const [filter, setFilter] = useState("");
  const shown = logs.filter((l) =>
    !filter
      ? true
      : [l.passport_id, l.jti, l.status, l.model ?? ""].some((f) =>
          f.toLowerCase().includes(filter.toLowerCase())
        )
  );

  return (
    <div className="grid">
      <input
        placeholder="Filter by passport_id / jti / status / model…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Passport</th>
            <th>JTI</th>
            <th>Model</th>
            <th>Tokens</th>
            <th>Cost</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((l) => (
            <tr key={l.id}>
              <td className="muted">{new Date(l.created_at).toLocaleTimeString()}</td>
              <td className="mono" title={l.passport_id}>
                {l.passport_id.slice(0, 12)}…
              </td>
              <td className="mono" title={l.jti}>
                {l.jti.slice(0, 8)}
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
      </table>
    </div>
  );
}
