"use client";
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Search, ArrowUpRight, SlidersHorizontal } from "lucide-react";
import { updateAgentBudgets } from "@/app/dashboard/actions";
import {
  AgentControlResult,
  applyIntent,
  intentFor,
  refreshIntent,
  type ControlResult,
} from "@/components/AgentSuspendControl";
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
import type { DeclaredKeyStorageView } from "@/lib/passport-key-storage";
import { expectationVerdict } from "@/lib/key-custody-expectation";
import { periodLimitSummary, usdFromMicrocents, type PeriodUsageView } from "@/lib/period-display";

interface Agent {
  id: string;
  name: string;
  passport_pubkey: string | null;
  status: string;
  budget_tokens: number | null;
  budget_cents: number | null;
  /** The periodic limit (K1). Absent on a database without 0073. */
  budget_period?: "day" | "month" | null;
  budget_period_cents?: number | null;
  spent_tokens: number;
  spent_microcents: number;
  last_seen_at: string | null;
  expires_at?: string | null;
  allowed_scopes: unknown;
  published?: boolean;
  public_label?: string | null;
}

type EditorKind = "budgets" | "scopes";

// ── Declared key custody, one row at a time ────────────────────────────────
//
// The column header carries "declared" so no cell has to repeat the caveat, and
// the panel on the agent page carries the long version. What is left here is a
// tier and, at most, ONE secondary line — a table is scanned, not read.
//
// Two states that must never blur together, and the fleet is where they would:
// an agent that has declared nothing (silence, which is not tier 0), and a
// Direct Agent Key, which has no passport private key to keep anywhere. The
// second is handled outside DeclaredKeyStorageView entirely, by passing no view
// at all, so the panel's contract is not widened to carry a row shape it never
// sees.
const CUSTODY_LABEL: Record<string, string> = {
  file: "Tier 0 · file",
  os: "Tier 1 · OS store",
};

function KeyCustody({
  view,
  expectation,
}: {
  view: DeclaredKeyStorageView | null;
  expectation: string | null;
}) {
  if (!view) {
    return (
      <span className="pc-passport-suffix" title="Direct Agent Key — there is no passport private key to keep anywhere">
        &mdash;
      </span>
    );
  }

  const label =
    view.state === "declared"
      ? CUSTODY_LABEL[view.store as string]
      : view.state === "unrecognised"
        ? "Unrecognised"
        : "Not declared";

  // The fallback wins the one secondary line when both apply. It is a live
  // misconfiguration on that machine — the agent is configured for tier 1 and
  // running on tier 0 — and the shortfall is merely its consequence.
  const shortfall = !view.fellBack && expectationVerdict(view, expectation) === "short";

  return (
    <>
      <span>{label}</span>
      {/* `display: block` inline rather than a new class: every other user of
          pc-passport-suffix is a <div> and gets it for free, and one of these
          sits inside a <p> in the card list where a <div> would be invalid.
          A new rule in globals.css would also have to survive the stale-.next
          trap for one line break. */}
      {view.fellBack ? (
        <span className="pc-passport-suffix" style={{ display: "block", color: "var(--warning)" }}>
          fell back from OS store
        </span>
      ) : shortfall ? (
        <span className="pc-passport-suffix" style={{ display: "block" }}>
          below the workspace expectation
        </span>
      ) : null}
    </>
  );
}

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
  keyCustody = {},
  keyCustodyExpectation = null,
  logsAvailable,
  agentsAvailable,
  periodUsage = {},
}: {
  agents: Agent[];
  /**
   * The gateway's own count for each periodic limit, keyed by agent id. A
   * missing entry for an agent that HAS a limit means the read failed, and the
   * row says so rather than showing $0.
   */
  periodUsage?: Record<string, PeriodUsageView>;
  /**
   * Whether the agent list was actually read. REQUIRED, like logsAvailable: an
   * empty array from a FAILED read is not "no agents", and during an incident
   * "No agents yet" is the most misleading thing this table could say.
   */
  agentsAvailable: boolean;
  // Server-side env value; this is a client component. See ScopeEditor.
  visaTtlSeconds: number;
  // Built server-side for PASSPORT agents only, so a missing entry means "this
  // agent has declared nothing" — a Direct Agent Key is never in here, and is
  // told apart by `passport_pubkey` at the call site below. A plain object, not
  // a Map: this is a client boundary and props cross it as Flight.
  keyCustody?: Record<string, DeclaredKeyStorageView>;
  // Stated by the operator, enforced by nothing. See lib/key-custody-expectation.
  keyCustodyExpectation?: string | null;
  /**
   * Whether the call scan behind `last_seen_at` ran. REQUIRED.
   *
   * `last_seen_at` is a maximum over two sources: the stored column and the
   * bounded log scan (`withLastSeenFromLogs`). "never" is a real answer and
   * lib/dashboard-attention.ts is right to refuse to invent it away — but it is
   * only a real answer when the scan that could have contradicted it actually
   * ran. Column NULL plus a failed scan is no evidence at all, and "never" is
   * then a claim about an agent nobody looked at.
   */
  logsAvailable: boolean;
}) {
  // Suspend/reactivate outcomes per agent — the shared contract in
  // AgentSuspendControl: desired state in, observed state out, and a lost
  // response is "could not confirm", never a silent no-op.
  const [controlResults, setControlResults] = useState<Record<string, ControlResult>>({});
  const runControl = async (agentId: string, intent: ReturnType<typeof intentFor>, read = false) => {
    setControlResults((current) => ({ ...current, [agentId]: { phase: "pending", intent } }));
    const result = read ? await refreshIntent(agentId, intent) : await applyIntent(agentId, intent);
    setControlResults((current) => ({ ...current, [agentId]: result }));
  };
  const controlBusy = (agentId: string) => controlResults[agentId]?.phase === "pending";
  // Newest observed status over the (briefly stale) server prop — see AgentSuspendControl.
  const effectiveStatus = (agentId: string, status: string) => {
    const result = controlResults[agentId];
    return result?.phase === "observed" && result.observation.database ? result.observation.database : status;
  };
  const [editing, setEditing] = useState<{ id: string; kind: EditorKind } | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "suspended" | "revoked" | "attention">("all");
  const [sort, setSort] = useState<"name" | "activity" | "spend" | "risk">("activity");
  const { format } = useDashboardTime();
  const toggle = (id: string, kind: EditorKind) =>
    setEditing((prev) => (prev?.id === id && prev.kind === kind ? null : { id, kind }));
  // Null for a Direct Agent Key: a row with no passport key has no custody
  // question, which is a different thing from an unanswered one.
  const custodyOf = (agent: Agent) => (agent.passport_pubkey ? keyCustody[agent.id] ?? null : null);

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

  if (!agentsAvailable) {
    return (
      <div className="pc-fleet-empty" data-state="unavailable" role="alert">
        <span>The agent list could not be read.</span>
        <p>This is not an empty fleet. Agents and their controls are unchanged.</p>
        <button type="button" className="ghost" onClick={() => window.location.reload()}>Retry</button>
      </div>
    );
  }

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
          <th>Token cap (cumulative)</th>
          <th>Cost cap (cumulative)</th>
          <th>Key custody (declared)</th>
          <th>Last seen</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {shown.map((a) => {
          const suspended = effectiveStatus(a.id, a.status) === "suspended";
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
                  <AgentControlResult
                    result={controlResults[a.id] ?? null}
                    agentName={a.name}
                    onRetry={() => { const r = controlResults[a.id]; if (r) void runControl(a.id, r.intent); }}
                    onRefresh={() => { const r = controlResults[a.id]; if (r) void runControl(a.id, r.intent, true); }}
                  />
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
                  <PeriodLimitLine agent={a} usage={periodUsage[a.id]} />
                </td>
                <td
                  className="pc-key-custody"
                  data-key-storage={custodyOf(a)?.dataState ?? "not-applicable"}
                >
                  <KeyCustody view={custodyOf(a)} expectation={keyCustodyExpectation} />
                </td>
                {/* The cell is a RELATIVE duration ("3h ago", "never"), which has
                    no time zone — "never · Europe/Sofia" was the giveaway. The
                    zone belongs to the absolute time, which is in the title, and
                    `format` already appends it (`timeZoneName: "short"`) — so
                    nothing is added here. Appending `zoneLabel` as well shipped
                    "06:42:12 EEST · Europe/Sofia" to production for one deploy. */}
                <td
                  className="pc-last-seen"
                  title={a.last_seen_at ? format(a.last_seen_at) : undefined}
                  data-state={logsAvailable || a.last_seen_at ? undefined : "unavailable"}
                >
                  {relativeTime(a.last_seen_at, logsAvailable)}
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
                    <RowMenu label={`Actions for ${a.name}`}>
                      <button onClick={() => toggle(a.id, "budgets")}>Edit budgets</button>
                      <button disabled={a.status === "revoked"} onClick={() => toggle(a.id, "scopes")}>
                        Edit scopes
                      </button>
                      <Link className="pc-open-agent" href={publicListingHref(a)}>{publicListingAction(a)}</Link>
                      <button
                        disabled={controlBusy(a.id) || a.status === "revoked"}
                        onClick={() => void runControl(a.id, intentFor(effectiveStatus(a.id, a.status)))}
                        data-control={suspended ? "reactivate" : "suspend"}
                      >
                        {suspended ? "Reactivate agent" : "Suspend agent"}
                      </button>
                    </RowMenu>
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
            const suspended = effectiveStatus(agent.id, agent.status) === "suspended";
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
                  <PeriodLimitLine agent={agent} usage={periodUsage[agent.id]} />
                </div>
                <p
                  className="pc-key-custody"
                  data-key-storage={custodyOf(agent)?.dataState ?? "not-applicable"}
                >
                  Key custody (declared):{" "}
                  <KeyCustody view={custodyOf(agent)} expectation={keyCustodyExpectation} />
                </p>
                <p title={agent.last_seen_at ? format(agent.last_seen_at) : undefined}>Last activity: {relativeTime(agent.last_seen_at, logsAvailable)}</p>
                <div className="pc-fleet-card__actions">
                  <Link href={`/dashboard/agents/${agent.id}`} className="pc-open-agent">
                    Open agent <ArrowUpRight aria-hidden="true" />
                  </Link>
                  <button className="ghost" onClick={() => toggle(agent.id, "budgets")}>Budgets</button>
                  <button className="ghost" disabled={agent.status === "revoked"} onClick={() => toggle(agent.id, "scopes")}>Scopes</button>
                  <Link className="pc-open-agent" href={publicListingHref(agent)}>{publicListingAction(agent)}</Link>
                  <button
                    className="ghost"
                    disabled={controlBusy(agent.id) || agent.status === "revoked"}
                    onClick={() => void runControl(agent.id, intentFor(effectiveStatus(agent.id, agent.status)))}
                    data-control={suspended ? "reactivate" : "suspend"}
                  >
                    {suspended ? "Reactivate" : "Suspend"}
                  </button>
                </div>
                <AgentControlResult
                  result={controlResults[agent.id] ?? null}
                  agentName={agent.name}
                  onRetry={() => { const r = controlResults[agent.id]; if (r) void runControl(agent.id, r.intent); }}
                  onRefresh={() => { const r = controlResults[agent.id]; if (r) void runControl(agent.id, r.intent, true); }}
                />
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
              hasPassport={Boolean(editedAgent.passport_pubkey)}
              onClose={() => setEditing(null)}
            />
          )}
        </div>
      ) : null}
    </div>
  );
}

const ROW_MENU_GAP = 6;

/**
 * Where the row menu's panel goes, in viewport coordinates.
 *
 * The panel used to be `position: absolute` under its button, and every Fleet
 * section is `overflow: hidden` (the rounded-corner clip) — below 1120px the
 * table wrap is a horizontal scroll box too. So on a short fleet, which is every
 * new workspace, the menu opened and only its top edge showed; the rest was cut
 * off by the section. Found in the 2026-09-14 Windows E2E. A fixed panel escapes
 * both boxes, which means placing it by hand: right-aligned under the button, or
 * above it when the viewport has more room there.
 */
export function placeRowMenu(
  anchor: { top: number; bottom: number; right: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number; placement: "below" | "above" } {
  const below = viewport.height - anchor.bottom - ROW_MENU_GAP;
  const above = anchor.top - ROW_MENU_GAP;
  const placement = below < panel.height && above > below ? "above" : "below";
  const top = placement === "above"
    ? Math.max(ROW_MENU_GAP, anchor.top - ROW_MENU_GAP - panel.height)
    : anchor.bottom + ROW_MENU_GAP;
  const left = Math.min(
    Math.max(ROW_MENU_GAP, anchor.right - panel.width),
    Math.max(ROW_MENU_GAP, viewport.width - panel.width - ROW_MENU_GAP),
  );
  return { top, left, placement };
}

function RowMenu({ label, children }: { label: string; children: ReactNode }) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const details = detailsRef.current;
    const panel = panelRef.current;
    if (!open || !details || !panel) return;
    const summary = details.querySelector("summary");
    if (!summary) return;
    const place = () => {
      const { top, left, placement } = placeRowMenu(
        summary.getBoundingClientRect(),
        { width: panel.offsetWidth, height: panel.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      panel.style.top = `${top}px`;
      panel.style.left = `${left}px`;
      details.dataset.placement = placement;
    };
    place();
    // Capture, so a scroll inside the table wrap moves the panel as well as a page scroll.
    window.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
      delete details.dataset.placement;
    };
  }, [open]);

  return (
    <details ref={detailsRef} className="pc-row-menu" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary aria-label={label}>Actions</summary>
      <div ref={panelRef}>{children}</div>
    </details>
  );
}

function relativeTime(value: string | null, scanned = true): string {
  if (!value) return scanned ? "never" : "unknown";
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
        <span>{format(value)} charged</span>
        <span>{limit == null ? "no cap" : `${format(limit)} cap`}</span>
      </div>
      <div className="pc-budget-meter__track" aria-label={`${label}: ${format(value)} charged${limit == null ? ", no cap" : ` of a ${format(limit)} cumulative cap`}`}>
        <span style={{ width: `${limit == null ? 0 : percent}%` }} />
      </div>
    </div>
  );
}

/**
 * The periodic limit (K1), under the cumulative cost meter. Nothing when the
 * agent has none. A meter only for a figure the gateway actually has — "not
 * measured yet" and "unavailable" are text, because a bar at zero is a claim.
 */
function PeriodLimitLine({ agent, usage }: { agent: Agent; usage: PeriodUsageView | undefined }) {
  if ((agent.budget_period !== "day" && agent.budget_period !== "month") || agent.budget_period_cents == null) {
    return null;
  }
  const summary = periodLimitSummary(agent.budget_period, agent.budget_period_cents, usage);
  return (
    <div className="mt-2" data-period-limit={agent.budget_period} data-period-state={summary.state}>
      {summary.countedCents !== null ? (
        <BudgetMeter
          value={summary.countedCents}
          limit={summary.capCents}
          label={agent.budget_period === "day" ? "today (UTC)" : "this month (UTC)"}
          format={(value) => usdFromMicrocents(Math.round(value * 1_000_000))}
        />
      ) : null}
      <span className="text-xs text-muted-foreground">{summary.text}</span>
    </div>
  );
}

function BudgetEditor({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [tokenBudget, setTokenBudget] = useState(agent.budget_tokens == null ? "" : String(agent.budget_tokens));
  const [costBudgetUsd, setCostBudgetUsd] = useState(formatCentsAsUsdInput(agent.budget_cents));
  const initialPeriod = agent.budget_period === "day" || agent.budget_period === "month" ? agent.budget_period : "";
  const initialPeriodUsd = formatCentsAsUsdInput(agent.budget_period_cents ?? null);
  const [period, setPeriod] = useState<"" | "day" | "month">(initialPeriod);
  const [periodUsd, setPeriodUsd] = useState(initialPeriodUsd);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Sent only when it changed, so editing the cumulative caps keeps working
      // on a database that has not applied 0073.
      const periodChanged = period !== initialPeriod || (period !== "" && periodUsd !== initialPeriodUsd);
      const periodCents = period === "" ? null : parseUsdBudgetToCents(periodUsd);
      if (period !== "" && periodCents === null) {
        throw new Error("Enter an amount for the daily or monthly limit, or choose no limit.");
      }
      await updateAgentBudgets(agent.id, {
        budget_tokens: parseTokenBudgetInput(tokenBudget),
        budget_cents: parseUsdBudgetToCents(costBudgetUsd),
        ...(periodChanged
          ? { budget_period: period === "" ? null : period, budget_period_cents: periodCents }
          : {}),
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
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Token cap (cumulative)</span>
          <input
            value={tokenBudget}
            onChange={(e) => setTokenBudget(e.target.value)}
            inputMode="numeric"
            placeholder="Unlimited"
          />
          <span className="text-xs text-muted-foreground">Blank clears the cap.</span>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Cost cap (USD, cumulative)</span>
          <input
            value={costBudgetUsd}
            onChange={(e) => setCostBudgetUsd(e.target.value)}
            inputMode="decimal"
            placeholder="Unlimited"
          />
          <span className="text-xs text-muted-foreground">Stored as integer cents. Blank clears the cap.</span>
        </label>
      </div>
      <p className="m-0 text-xs leading-5 text-muted-foreground" data-budget-period="cumulative">
        Caps are cumulative: they count every call charged to this agent since it was created and do not reset
        each month. The cost cap is enforced against PassControl&apos;s list-price calculation, not the provider&apos;s
        invoice.
      </p>
      <div className="grid gap-3 md:grid-cols-2" data-budget-period="periodic">
        <label className="grid gap-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Spend limit period</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value as "" | "day" | "month")}>
            <option value="">No daily or monthly limit</option>
            <option value="day">Per UTC day</option>
            <option value="month">Per UTC month</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Limit (USD per period)</span>
          <input
            value={periodUsd}
            onChange={(e) => setPeriodUsd(e.target.value)}
            inputMode="decimal"
            placeholder="25.00"
            disabled={period === ""}
          />
        </label>
      </div>
      <p className="m-0 text-xs leading-5 text-muted-foreground">
        A daily or monthly limit resets at midnight UTC or on the first of the month. A call counts toward the
        period in which it finishes, and spend earlier in the current period counts when you set one. A refused
        call gets <code>402 blocked_budget_period</code> with a <code>retry-after</code> to the next reset.
      </p>
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
