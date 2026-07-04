"use client";
import { useTransition } from "react";
import { setAgentSuspended } from "@/app/dashboard/actions";
import { StatusPill, type StatusType } from "./StatusPill";

interface Agent {
  id: string;
  name: string;
  passport_pubkey: string;
  status: string;
  budget_tokens: number | null;
  spent_tokens: number;
  spent_microcents: number;
  last_seen_at: string | null;
}

export function AgentFleetTable({ agents }: { agents: Agent[] }) {
  const [pending, start] = useTransition();
  if (!agents.length) return <p className="muted">No agents yet. Issue a passport to begin.</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>Agent</th>
          <th>Status</th>
          <th>Spend</th>
          <th>Budget</th>
          <th>Last seen</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {agents.map((a) => {
          const suspended = a.status !== "active";
          return (
            <tr key={a.id}>
              <td>
                <div>{a.name}</div>
                <div className="mono muted" title={a.passport_pubkey}>
                  {a.passport_pubkey.slice(0, 16)}…
                </div>
              </td>
              <td>
                <StatusPill status={a.status as StatusType} />
              </td>
              <td>
                {a.spent_tokens.toLocaleString()} tok · ${(a.spent_microcents / 1e8).toFixed(4)}
              </td>
              <td>{a.budget_tokens == null ? "∞" : a.budget_tokens.toLocaleString()}</td>
              <td className="muted">
                {a.last_seen_at ? new Date(a.last_seen_at).toLocaleString() : "—"}
              </td>
              <td>
                <button
                  className="ghost"
                  disabled={pending || a.status === "revoked"}
                  onClick={() => start(() => setAgentSuspended(a.id, !suspended))}
                >
                  {suspended ? "Reactivate" : "Suspend"}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
