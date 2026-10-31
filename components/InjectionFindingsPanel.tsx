import { SectionHeader } from "@/components/dashboard/SectionHeader";
import { InjectionTaintControl, type InjectionTaintView } from "@/components/InjectionTaintControl";
import { familyLabel } from "@/lib/injection-labels";

// The injection guard's records (plans/injection-guard.md Phase 1; migration 0089): tool
// output inside this agent's model calls that carried a tell injected instructions carry.
// Monitor mode refuses nothing, so nothing on this panel may read as a refusal, and a
// tell is a hint, not proof. The block's text was never stored, so there is none to show.
// In hold mode (Phase 2) a strong finding does hold the agent's risky actions, so the
// panel shows the hold and stops saying "recorded only".

export type InjectionFindingRow = {
  id: string;
  created_at: string;
  source: string;
  path: string;
  families: string[];
  severity: "high" | "low" | string;
  detector: string;
  provider: string | null;
  model: string | null;
  /** 0090: where the block was seen, and the tool that returned it (sidecar rows only). */
  surface?: "proxy" | "sidecar" | string;
  tool_name?: string | null;
};

export type InjectionFindingsRead = { state: "ok"; rows: InjectionFindingRow[] } | { state: "unavailable" };


const SOURCE_LABELS: Record<string, string> = {
  tool_result: "Tool result",
  document: "Document",
  search_result: "Search result",
  web_fetch_tool_result: "Web fetch result",
  web_search_tool_result: "Web search result",
  mcp_tool_result: "MCP tool result",
  tool: "Tool message",
  function: "Function message",
  function_call_output: "Function output",
  custom_tool_call_output: "Tool output",
  mcp_call: "MCP call output",
  file_search_call: "File search result",
};

export { familyLabel };

const sourceLabel = (source: string) => SOURCE_LABELS[source] ?? source;

// How old rows go. Cloud sweeps every agent daily; a self-hosted install prunes an
// agent's rows the next time the guard records something for it.
export function findingsRetentionSentence(): string {
  return "Findings older than 30 days are removed the next time the guard records one for this agent.";
}

function when(at: string): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

const FOUND =
  "Tool output inside this agent's calls (a fetched page, a file, a search result) that carried the tells injected " +
  "instructions usually carry.";
const MONITOR = "Recorded only: nothing was refused and nothing in the call changed.";
const HOLD =
  "A strong one makes this agent's service writes wait for you for 30 minutes, and Claude Code's risky tools too " +
  "wherever PassControl's tool hook is installed; nothing it reads is refused.";
const CAVEATS =
  "A tell is a hint, not proof, and a careful attack may have none. Each block is listed once, however often the " +
  "conversation re-sent it, and its text was never stored.";

export function InjectionFindingsPanel({
  read,
  enabled,
  hold,
}: {
  read: InjectionFindingsRead;
  enabled: boolean;
  /** Present in hold mode only. */
  hold?: { agentId: string; taint: InjectionTaintView };
}) {
  const rows = read.state === "ok" ? read.rows : [];
  // An agent without the guard and without old rows has nothing to show: the section is
  // an addition, not a gap to explain.
  if (!enabled && rows.length === 0) return null;
  const state = read.state === "unavailable" ? "unavailable" : rows.length === 0 ? "empty" : "ok";

  return (
    <section id="agent-injection" data-state={state} className="pc-section scroll-mt-40">
      <SectionHeader
        eyebrow="Injection guard"
        title="Injected instructions"
        description={
          <>
            {FOUND} {hold ? HOLD : MONITOR} {CAVEATS} {findingsRetentionSentence()}
          </>
        }
      />
      <div className="pc-section__body grid gap-3">
        {hold ? <InjectionTaintControl agentId={hold.agentId} taint={hold.taint} /> : null}
        {state === "unavailable" ? (
          <p className="text-sm text-muted-foreground">
            The records are not available yet: this database has not been migrated to 0089.
          </p>
        ) : state === "empty" ? (
          <p className="text-sm text-muted-foreground">Nothing found yet in this agent&apos;s tool output.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-2 pr-4 font-medium">When</th>
                  <th className="py-2 pr-4 font-medium">Where</th>
                  <th className="py-2 pr-4 font-medium">Tells</th>
                  <th className="py-2 pr-4 font-medium">Strength</th>
                  <th className="py-2 pr-4 font-medium">Call</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} data-severity={row.severity} className="border-t border-border align-top">
                    <td className="py-2 pr-4 whitespace-nowrap text-muted-foreground">{when(row.created_at)}</td>
                    <td className="py-2 pr-4">
                      {sourceLabel(row.source)}
                      {row.surface === "sidecar" ? (
                        <span className="block text-xs text-muted-foreground">
                          {row.tool_name ? `${row.tool_name}, ` : ""}on the agent&apos;s machine (sidecar)
                        </span>
                      ) : null}
                      <code className="block text-xs text-muted-foreground">{row.path}</code>
                    </td>
                    <td className="py-2 pr-4">
                      <ul className="m-0 list-none p-0">
                        {row.families.map((family) => (
                          <li key={family} data-family={family}>
                            {familyLabel(family)}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      {row.severity === "high" ? (
                        <span className="text-amber-600 dark:text-amber-400">Strong</span>
                      ) : (
                        <span className="text-muted-foreground">Weak</span>
                      )}
                      <span className="block text-xs text-muted-foreground">{row.detector}</span>
                    </td>
                    <td className="py-2 pr-4">
                      <code className="text-xs">{row.model ?? "—"}</code>
                      {row.provider ? <span className="block text-xs text-muted-foreground">{row.provider}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
