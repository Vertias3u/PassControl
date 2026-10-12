import { SectionHeader } from "@/components/dashboard/SectionHeader";

// Subscription mode, Phase 1b (migration 0084): the model calls Claude Code REPORTED
// from a Pro/Max login. The gateway never saw them, so nothing here is proof: no
// receipt, not proxied, and the cost is what the call would have cost on the API,
// never money spent or charged to a budget. The words on this panel say so, and stay
// clear of the ones that mean a proxied, signed call.

export type ReportedCallRow = {
  event_key: string;
  kind: "model_call" | "model_error" | string;
  auth_method: "passport" | "direct_key" | string;
  client_session: string | null;
  client_agent: string | null;
  model: string | null;
  occurred_at: string | null;
  received_at: string;
  input_tokens: number | null;
  output_tokens: number | null;
  reported_cost_usd_micros: number | null;
  duration_ms: number | null;
  status_code: number | null;
};

export type ReportedCallsRead = { state: "ok"; rows: ReportedCallRow[] } | { state: "unavailable" };

// Phase 2: what the agent's tool rules decided at Claude Code's PreToolUse hook.
export type ToolDecisionRow = {
  event_key: string;
  auth_method: "passport" | "direct_key" | string;
  client_session: string | null;
  client_agent: string | null;
  occurred_at: string | null;
  received_at: string;
  tool_name: string | null;
  decision: string | null;
  rule_index: number | null;
  duration_ms: number | null;
};

export type ToolDecisionsRead = { state: "ok"; rows: ToolDecisionRow[] } | { state: "unavailable" };

const DECISION_LABELS: Record<string, { text: string; tone: "ok" | "warn" | "muted" }> = {
  deny: { text: "Refused by a rule", tone: "warn" },
  ask: { text: "Asked in the terminal", tone: "muted" },
  owner_approved: { text: "Owner said yes", tone: "ok" },
  owner_denied: { text: "Owner said no", tone: "warn" },
  owner_timeout: { text: "Owner did not answer", tone: "warn" },
  owner_unavailable: { text: "Could not ask the owner", tone: "warn" },
  rules_invalid: { text: "Rules could not be read", tone: "warn" },
};
const TONE_CLASS = {
  ok: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  muted: "text-muted-foreground",
};

/** Millionths of a dollar as dollars to four places; an unknown is a dash, never $0. */
export function formatApiEquivalent(micros: number | null): string {
  if (micros === null || !Number.isFinite(micros)) return "—";
  return `$${(micros / 1_000_000).toFixed(4)}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const count = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US"));

function when(row: { occurred_at: string | null; received_at: string }): string {
  const at = row.occurred_at ?? row.received_at;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function ReportedCallsPanel({ read }: { read: ReportedCallsRead }) {
  // Nothing to show on an agent that never ran on a subscription, or on a database
  // before 0084: the section is an addition, not a gap to explain.
  if (read.state !== "ok" || read.rows.length === 0) return null;
  const rows = read.rows;
  const priced = rows.filter((r) => r.reported_cost_usd_micros !== null);
  const unpriced = rows.length - priced.length;
  const total = priced.reduce((sum, r) => sum + (r.reported_cost_usd_micros ?? 0), 0);
  const viaDirectKey = rows.some((r) => r.auth_method === "direct_key");

  return (
    <section id="agent-reported" data-state="ok" className="pc-section scroll-mt-40">
      <SectionHeader
        eyebrow="Subscription calls"
        title="Reported by Claude Code"
        description={
          <>
            Calls Claude Code reported from a Claude Pro or Max login. They were not proxied, and PassControl
            holds no receipt for them: this is the client&apos;s own account. The cost is API-equivalent,
            what each call would have cost on the API. It is never charged to a budget, because the plan is a
            flat fee. Kept for 90 days.
          </>
        }
      />
      <div className="pc-section__body grid gap-3">
        <p className="text-sm text-muted-foreground" data-testid="reported-summary">
          Newest {plural(rows.length, "call")} ·{" "}
          {priced.length > 0 ? `${formatApiEquivalent(total)} API-equivalent` : "no reported cost"}
          {priced.length > 0 && unpriced > 0 ? ` · ${unpriced} with no reported cost` : ""}
          {viaDirectKey ? " · some uploaded with a Direct Agent Key" : ""}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">Model</th>
                <th className="py-2 pr-4 font-medium">Session</th>
                <th className="py-2 pr-4 font-medium">Tokens in / out</th>
                <th className="py-2 pr-4 font-medium">API-equivalent</th>
                <th className="py-2 pr-4 font-medium">Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.event_key} data-kind={row.kind} className="border-t border-border align-top">
                  <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground">{when(row)}</td>
                  <td className="py-2 pr-4">
                    <code className="text-xs">{row.model ?? "—"}</code>
                    {row.kind === "model_error" ? (
                      <span className="ml-2 text-amber-600 dark:text-amber-400">
                        error{row.status_code !== null ? ` ${row.status_code}` : ""}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4">
                    {row.client_session ? <code className="text-xs" title={row.client_session}>{row.client_session.slice(0, 8)}</code> : "—"}
                    {row.client_agent ? <span className="ml-2 text-xs text-muted-foreground">sub-agent {row.client_agent}</span> : null}
                    {row.auth_method === "direct_key" ? (
                      <span className="ml-2 text-xs text-muted-foreground">via Direct Agent Key</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {count(row.input_tokens)} / {count(row.output_tokens)}
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap">{formatApiEquivalent(row.reported_cost_usd_micros)}</td>
                  <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground">
                    {row.duration_ms === null ? "—" : `${(row.duration_ms / 1000).toFixed(1)} s`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function ToolDecisionsPanel({ read }: { read: ToolDecisionsRead }) {
  if (read.state !== "ok" || read.rows.length === 0) return null;
  return (
    <section id="agent-tool-decisions" data-state="ok" className="pc-section scroll-mt-40">
      <SectionHeader
        eyebrow="Subscription tools"
        title="Tool rules at work"
        description={
          <>
            What this agent&apos;s tool rules decided in Claude Code on a Claude Pro or Max login, as its sidecar
            reported it. Only the tool&apos;s name and the decision: never the command, file or address it was
            about. Kept for 90 days.
          </>
        }
      />
      <div className="pc-section__body overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="py-2 pr-4 font-medium">When</th>
              <th className="py-2 pr-4 font-medium">Tool</th>
              <th className="py-2 pr-4 font-medium">Decision</th>
              <th className="py-2 pr-4 font-medium">Session</th>
              <th className="py-2 pr-4 font-medium">Waited</th>
            </tr>
          </thead>
          <tbody>
            {read.rows.map((row) => {
              const label = DECISION_LABELS[row.decision ?? ""] ?? { text: row.decision ?? "—", tone: "muted" as const };
              return (
                <tr key={row.event_key} data-decision={row.decision ?? ""} className="border-t border-border align-top">
                  <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground">{when(row)}</td>
                  <td className="py-2 pr-4">
                    <code className="text-xs">{row.tool_name ?? "—"}</code>
                  </td>
                  <td className="py-2 pr-4">
                    <span className={TONE_CLASS[label.tone]}>{label.text}</span>
                    {row.rule_index !== null ? <span className="ml-2 text-xs text-muted-foreground">rule {row.rule_index + 1}</span> : null}
                  </td>
                  <td className="py-2 pr-4">
                    {row.client_session ? <code className="text-xs" title={row.client_session}>{row.client_session.slice(0, 8)}</code> : "—"}
                    {row.client_agent ? <span className="ml-2 text-xs text-muted-foreground">sub-agent {row.client_agent}</span> : null}
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground">
                    {row.duration_ms ? `${(row.duration_ms / 1000).toFixed(1)} s` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
