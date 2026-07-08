"use client";
import { Fragment, type FormEvent, useState, useTransition } from "react";
import { setAgentSuspended, updateAgentBudgets } from "@/app/dashboard/actions";
import {
  formatCentsAsUsdDisplay,
  formatCentsAsUsdInput,
  parseTokenBudgetInput,
  parseUsdBudgetToCents,
} from "@/lib/budget-input";
import { StatusPill, type StatusType } from "./StatusPill";

interface Agent {
  id: string;
  name: string;
  passport_pubkey: string;
  status: string;
  budget_tokens: number | null;
  budget_cents: number | null;
  spent_tokens: number;
  spent_microcents: number;
  last_seen_at: string | null;
}

export function AgentFleetTable({ agents }: { agents: Agent[] }) {
  const [pending, start] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);
  if (!agents.length) return <p className="muted">No agents yet. Issue a passport to begin.</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>Agent</th>
          <th>Status</th>
          <th>Spend</th>
          <th>Token budget</th>
          <th>Cost budget (USD)</th>
          <th>Last seen</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {agents.map((a) => {
          const suspended = a.status !== "active";
          return (
            <Fragment key={a.id}>
              <tr>
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
                <td>{formatCentsAsUsdDisplay(a.budget_cents)}</td>
                <td className="muted">
                  {a.last_seen_at ? new Date(a.last_seen_at).toLocaleString() : "—"}
                </td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    <button className="ghost" onClick={() => setEditingId(editingId === a.id ? null : a.id)}>
                      Budgets
                    </button>
                    <button
                      className="ghost"
                      disabled={pending || a.status === "revoked"}
                      onClick={() => start(() => setAgentSuspended(a.id, !suspended))}
                    >
                      {suspended ? "Reactivate" : "Suspend"}
                    </button>
                  </div>
                </td>
              </tr>
              {editingId === a.id ? (
                <tr>
                  <td colSpan={7}>
                    <BudgetEditor agent={a} onClose={() => setEditingId(null)} />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function BudgetEditor({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [tokenBudget, setTokenBudget] = useState(agent.budget_tokens == null ? "" : String(agent.budget_tokens));
  const [costBudgetUsd, setCostBudgetUsd] = useState(formatCentsAsUsdInput(agent.budget_cents));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await updateAgentBudgets(agent.id, {
        budget_tokens: parseTokenBudgetInput(tokenBudget),
        budget_cents: parseUsdBudgetToCents(costBudgetUsd),
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="grid gap-3 rounded-md border border-border bg-secondary/40 p-3">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="grid gap-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Token budget</span>
          <input
            value={tokenBudget}
            onChange={(e) => setTokenBudget(e.target.value)}
            inputMode="numeric"
            placeholder="Unlimited"
          />
          <span className="text-xs text-muted-foreground">Blank clears to unlimited.</span>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Cost budget (USD)</span>
          <input
            value={costBudgetUsd}
            onChange={(e) => setCostBudgetUsd(e.target.value)}
            inputMode="decimal"
            placeholder="Unlimited"
          />
          <span className="text-xs text-muted-foreground">Stored as integer cents. Blank clears to unlimited.</span>
        </label>
      </div>
      {error ? <p className="m-0 text-sm" style={{ color: "var(--danger)" }}>{error}</p> : null}
      <div className="flex justify-end gap-2">
        <button type="button" className="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="submit" disabled={busy}>
          {busy ? "Saving..." : "Save budgets"}
        </button>
      </div>
    </form>
  );
}
