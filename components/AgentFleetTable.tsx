"use client";
import { type FormEvent, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Search, ArrowUpRight, SlidersHorizontal } from "lucide-react";
import { setAgentSuspended, updateAgentBudgets } from "@/app/dashboard/actions";
import { ScopeEditor } from "./ScopeEditor";
import { toScopeRows } from "@/lib/scope-rows";
import {
  formatCentsAsUsdDisplay,
  formatCentsAsUsdInput,
  parseTokenBudgetInput,
  parseUsdBudgetToCents,
} from "@/lib/budget-input";
import { StatusPill, type StatusType } from "./StatusPill";
import { BUDGET_ATTENTION_RATIO, budgetRiskRatio } from "@/lib/dashboard-attention";
import { useDashboardTime } from "@/components/dashboard/DashboardTime";

interface Agent {
  id: string;
  name: string;
  passport_pubkey: string | null;
  status: string;
  budget_tokens: number | null;
  budget_cents: number | null;
  spent_tokens: number;
  spent_microcents: number;
  last_seen_at: string | null;
  expires_at?: string | null;
  allowed_scopes: unknown;
  published?: boolean;
  public_label?: string | null;
}

type EditorKind = "budgets" | "scopes";

function publicListingSummary(agent: Agent): string {
  if (!agent.passport_pubkey) return "Public listing requires a passport";
  if (!agent.published) return "Not publicly listed";
  return agent.public_label
    ? `Selected for public profile as ${agent.public_label}`
    : "Selected for public profile";
}

function publicListingAction(agent: Agent): string {
  if (!agent.passport_pubkey) return "Add passport to list";
  return agent.published ? "Manage public listing" : "Set up public listing";
}

function publicListingHref(agent: Agent): string {
  return `/dashboard/agents/${agent.id}#${agent.passport_pubkey ? "agent-public" : "agent-identity"}`;
}

export function AgentFleetTable({
  agents,
  visaTtlSeconds,
}: {
  agents: Agent[];
  // Server-side env value; this is a client component. See ScopeEditor.
  visaTtlSeconds: number;
}) {
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<{ id: string; kind: EditorKind } | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "suspended" | "revoked" | "attention">("all");
  const [sort, setSort] = useState<"name" | "activity" | "spend" | "risk">("activity");
  const { format } = useDashboardTime();
  const toggle = (id: string, kind: EditorKind) =>
    setEditing((prev) => (prev?.id === id && prev.kind === kind ? null : { id, kind }));

  const risk = (agent: Agent) => budgetRiskRatio(agent);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return agents
      .filter((agent) => {
        if (needle && ![agent.name, agent.passport_pubkey ?? "direct agent key"].some((value) => value.toLowerCase().includes(needle))) {
          return false;
        }
        if (status === "attention") return agent.status !== "active" || risk(agent) >= BUDGET_ATTENTION_RATIO;
        return status === "all" || agent.status === status;
      })
      .sort((a, b) => {
        if (sort === "name") return a.name.localeCompare(b.name);
        if (sort === "spend") return b.spent_microcents - a.spent_microcents;
        if (sort === "risk") return risk(b) - risk(a);
        return Date.parse(b.last_seen_at ?? "") - Date.parse(a.last_seen_at ?? "");
      });
  }, [agents, query, sort, status]);

  const editedAgent = editing ? agents.find((agent) => agent.id === editing.id) ?? null : null;

  if (!agents.length) {
    return (
      <div className="pc-fleet-empty" data-state="empty">
        <span>No agents yet.</span>
        <p>Connect an agent with a Direct Agent Key or issue a signing passport.</p>
      </div>
    );
  }

  return (
    <div className="pc-fleet-workspace">
      <div className="pc-fleet-controls">
        <label className="pc-search-field">
          <Search aria-hidden="true" />
          <span className="sr-only">Search the loaded fleet</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Agent name, passport ID, or direct identity…"
          />
        </label>
        <label>
          <SlidersHorizontal aria-hidden="true" />
          <span className="sr-only">Filter agent status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option value="all">All states</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
            <option value="revoked">Revoked</option>
            <option value="attention">Needs attention</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Sort agents</span>
          <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
            <option value="activity">Recent activity</option>
            <option value="name">Name</option>
            <option value="spend">Highest spend</option>
            <option value="risk">Budget risk</option>
          </select>
        </label>
        <span className="pc-fleet-controls__count">{shown.length} of {agents.length} loaded</span>
      </div>

      {shown.length === 0 ? (
        <div className="pc-table-empty" data-state="empty">
          <span>No loaded agents match this view.</span>
          <button type="button" className="ghost" onClick={() => { setQuery(""); setStatus("all"); }}>
            Clear filters
          </button>
        </div>
      ) : null}

      {shown.length ? <div className="pc-fleet-table-wrap"><table className="pc-fleet-table">
      <thead>
        <tr>
          <th>Agent</th>
          <th>Status</th>
          <th>Token budget</th>
          <th>Cost budget</th>
          <th>Last seen</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {shown.map((a) => {
          const suspended = a.status === "suspended";
          return (
              <tr key={a.id} data-state={a.status}>
                <td>
                  <Link href={`/dashboard/agents/${a.id}`} className="pc-agent-name">
                    {a.name}
                  </Link>
                  <div className="pc-passport-suffix" title={a.passport_pubkey ?? "Direct Agent Key identity"}>
                    {a.passport_pubkey ? `${a.passport_pubkey.slice(0, 16)}…` : "Direct Agent Key"}
                  </div>
                  <div className="pc-passport-suffix">{publicListingSummary(a)}</div>
                </td>
                <td>
                  <StatusPill status={a.status as StatusType} />
                </td>
                <td><BudgetMeter value={a.spent_tokens} limit={a.budget_tokens} label="tokens" /></td>
                <td>
                  <BudgetMeter
                    value={a.spent_microcents / 1_000_000}
                    limit={a.budget_cents}
                    label="cost"
                    format={(value) => formatCentsAsUsdDisplay(Math.round(value))}
                  />
                </td>
                {/* The cell is a RELATIVE duration ("3h ago", "never"), which has
                    no time zone — "never · Europe/Sofia" was the giveaway. The
                    zone belongs to the absolute time, which is in the title, and
                    `format` already appends it (`timeZoneName: "short"`) — so
                    nothing is added here. Appending `zoneLabel` as well shipped
                    "06:42:12 EEST · Europe/Sofia" to production for one deploy. */}
                <td className="pc-last-seen" title={a.last_seen_at ? format(a.last_seen_at) : undefined}>
                  {relativeTime(a.last_seen_at)}
                </td>
                <td>
                  <div className="pc-fleet-actions">
                    <Link
                      href={`/dashboard/agents/${a.id}`}
                      className="pc-open-agent"
                      aria-label={`View agent workspace for ${a.name}`}
                    >
                      Open
                      <ArrowUpRight aria-hidden="true" />
                    </Link>
                    <details className="pc-row-menu">
                      <summary aria-label={`Actions for ${a.name}`}>Actions</summary>
                      <div>
                        <button onClick={() => toggle(a.id, "budgets")}>Edit budgets</button>
                        <button disabled={a.status === "revoked"} onClick={() => toggle(a.id, "scopes")}>
                          Edit scopes
                        </button>
                        <Link className="pc-open-agent" href={publicListingHref(a)}>{publicListingAction(a)}</Link>
                        <button
                          disabled={pending || a.status === "revoked"}
                          onClick={() => start(() => setAgentSuspended(a.id, !suspended))}
                        >
                          {suspended ? "Reactivate agent" : "Suspend agent"}
                        </button>
                      </div>
                    </details>
                  </div>
                </td>
              </tr>
          );
        })}
      </tbody>
      </table></div> : null}

      {shown.length ? (
        <ul className="pc-fleet-cards">
          {shown.map((agent) => {
            const suspended = agent.status === "suspended";
            return (
              <li key={agent.id}>
                <div className="pc-fleet-card__header">
                  <div>
                    <Link href={`/dashboard/agents/${agent.id}`}>{agent.name}</Link>
                    <span>
                      {agent.passport_pubkey ? `${agent.passport_pubkey.slice(0, 14)}…` : "Direct Agent Key"}
                      <br />
                      {publicListingSummary(agent)}
                    </span>
                  </div>
                  <StatusPill status={agent.status as StatusType} />
                </div>
                <div className="pc-fleet-card__budgets">
                  <BudgetMeter value={agent.spent_tokens} limit={agent.budget_tokens} label="tokens" />
                  <BudgetMeter
                    value={agent.spent_microcents / 1_000_000}
                    limit={agent.budget_cents}
                    label="cost"
                    format={(value) => formatCentsAsUsdDisplay(Math.round(value))}
                  />
                </div>
                <p title={agent.last_seen_at ? format(agent.last_seen_at) : undefined}>Last activity: {relativeTime(agent.last_seen_at)}</p>
                <div className="pc-fleet-card__actions">
                  <Link href={`/dashboard/agents/${agent.id}`} className="pc-open-agent">
                    Open agent <ArrowUpRight aria-hidden="true" />
                  </Link>
                  <button className="ghost" onClick={() => toggle(agent.id, "budgets")}>Budgets</button>
                  <button className="ghost" disabled={agent.status === "revoked"} onClick={() => toggle(agent.id, "scopes")}>Scopes</button>
                  <Link className="pc-open-agent" href={publicListingHref(agent)}>{publicListingAction(agent)}</Link>
                  <button
                    className="ghost"
                    disabled={pending || agent.status === "revoked"}
                    onClick={() => start(() => setAgentSuspended(agent.id, !suspended))}
                  >
                    {suspended ? "Reactivate" : "Suspend"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}

      {editedAgent && editing ? (
        <div className="pc-fleet-editor" aria-label={`Edit ${editing.kind} for ${editedAgent.name}`}>
          <div className="pc-fleet-editor__heading">
            <div>
              <span>{editing.kind === "budgets" ? "Budget controls" : "Capability grant"}</span>
              <strong>{editedAgent.name}</strong>
            </div>
            <button type="button" className="ghost" onClick={() => setEditing(null)}>Close</button>
          </div>
          {editing.kind === "budgets" ? (
            <BudgetEditor agent={editedAgent} onClose={() => setEditing(null)} />
          ) : (
            <ScopeEditor
              agentId={editedAgent.id}
              scopes={toScopeRows(editedAgent.allowed_scopes)}
              ttlSeconds={visaTtlSeconds}
              onClose={() => setEditing(null)}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

function relativeTime(value: string | null): string {
  if (!value) return "never";
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed)) return "unknown";
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function BudgetMeter({
  value,
  limit,
  label,
  format = (amount) => Math.round(amount).toLocaleString(),
}: {
  value: number;
  limit: number | null;
  label: string;
  format?: (value: number) => string;
}) {
  const ratio = limit != null && limit > 0 ? Math.max(0, value / limit) : 0;
  const percent = Math.min(100, ratio * 100);
  const tone = ratio >= 1 ? "danger" : ratio >= BUDGET_ATTENTION_RATIO ? "warning" : "normal";
  return (
    <div className="pc-budget-meter" data-tone={tone}>
      <div>
        <span>{format(value)} used</span>
        <span>{limit == null ? "unlimited" : `${format(limit)} limit`}</span>
      </div>
      <div className="pc-budget-meter__track" aria-label={`${label}: ${format(value)} used${limit == null ? ", unlimited" : ` of ${format(limit)}`}`}>
        <span style={{ width: `${limit == null ? 0 : percent}%` }} />
      </div>
    </div>
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
