"use client";
// One agent's tool rules (subscription mode, Phase 2; migration 0085).
//
// On a Claude Pro/Max login, Claude Code's tools run on the user's machine and the
// gateway never sees them. Claude Code's PreToolUse hook asks the local sidecar first,
// and the sidecar answers from these rules: refuse a tool, hand it to Claude Code's own
// prompt, or hold it until the owner says yes (cli/tool-gate.mjs).
//
// Each rule is a tool and, for the tools that have one, a condition: a command for
// Bash, a path for the file tools, a domain for WebFetch. A saved rule is shown with
// its own condition and effect, so saving never quietly changes one. Saving goes
// through setAgentToolRules, which validates with the sidecar's own parser.
import { useState, useTransition } from "react";
import { CheckCircle2, Plus, Trash2 } from "lucide-react";
import { setAgentToolRules } from "@/app/dashboard/tool-rules-actions";
import type { ToolRulesRead } from "@/lib/tool-rules";

type Message = { ok: boolean; text: string } | null;
type Condition = "command" | "path" | "domain";
type Row = { tool: string; effect: string; condition: string };

const PATH_TOOLS = new Set(["Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "Glob", "Grep"]);
const SUGGESTED_TOOLS = ["Bash", "Read", "Edit", "Write", "WebFetch", "Glob", "Grep", "mcp__*"];
const DEFAULT_WAIT_S = 120;

const EFFECTS = [
  { value: "deny", label: "Refuse" },
  { value: "ask", label: "Ask in the terminal" },
  { value: "ask_owner", label: "Ask me first" },
] as const;

const CONDITION_FIELD: Record<Condition, { label: string; placeholder: string }> = {
  command: { label: "Command", placeholder: "git push*" },
  path: { label: "Path", placeholder: "/Users/me/.ssh/*" },
  domain: { label: "Domain", placeholder: "*.example.com" },
};

/** The condition a tool takes, or null for a tool that takes none. */
export function conditionFor(tool: string): Condition | null {
  if (tool === "Bash") return "command";
  if (PATH_TOOLS.has(tool)) return "path";
  if (tool === "WebFetch") return "domain";
  return null;
}

function rowsFrom(document: unknown): { rows: Row[]; waitS: number | null } {
  const doc = document && typeof document === "object" ? (document as Record<string, unknown>) : {};
  const rules = Array.isArray(doc.rules) ? doc.rules : [];
  return {
    rows: rules.map((rule) => {
      const r = (rule ?? {}) as Record<string, unknown>;
      const condition = [r.command, r.path, r.domain].find((v) => typeof v === "string");
      return { tool: String(r.tool ?? ""), effect: String(r.effect ?? "deny"), condition: (condition as string | undefined) ?? "" };
    }),
    waitS: typeof doc.approval_wait_s === "number" ? doc.approval_wait_s : null,
  };
}

export function AgentToolRules({
  agentId,
  read,
  alertDestination,
}: {
  agentId: string;
  read: ToolRulesRead;
  /** Where "Ask me first" questions are also sent: null when nowhere, undefined when unknown. */
  alertDestination?: "telegram" | "slack" | "discord" | null;
}) {
  const [initial] = useState(() => rowsFrom(read.state === "ok" ? read.document : null));
  const [rows, setRows] = useState<Row[]>(initial.rows);
  const [wait, setWait] = useState(initial.waitS === null ? "" : String(initial.waitS));
  const [msg, setMsg] = useState<Message>(null);
  const [pending, start] = useTransition();
  const edit = (index: number, change: Partial<Row>) =>
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...change } : row)));

  if (read.state === "unknown") {
    return (
      <p className="pc-inline-notice is-danger" role="alert" data-tool-rules="unknown">
        This agent&apos;s tool rules could not be read. Reload the page to try again.
      </p>
    );
  }

  const asksOwner = rows.some((row) => row.effect === "ask_owner");
  const save = () =>
    start(async () => {
      setMsg(null);
      const trimmedWait = wait.trim();
      const result = await setAgentToolRules(agentId, {
        rules: rows.map((row) => {
          const kind = conditionFor(row.tool.trim());
          return { tool: row.tool, effect: row.effect, ...(kind && row.condition.trim() ? { [kind]: row.condition } : {}) };
        }),
        approvalWaitS: trimmedWait === "" ? null : Number(trimmedWait),
      });
      setMsg(result.error ? { ok: false, text: result.error } : { ok: true, text: result.notice ?? "Saved." });
    });

  return (
    <div className="pc-settings-manager" data-tool-rules={read.state === "invalid" ? "invalid" : rows.length === 0 ? "none" : "ok"}>
      {read.state === "invalid" ? (
        <p className="pc-inline-notice is-danger" role="alert">
          The stored tool rules for this agent are not valid, so its sidecar refuses every tool in Claude Code.
          Saving below replaces them.
        </p>
      ) : null}

      <p className="text-sm text-muted-foreground">
        For Claude Code on a Claude Pro or Max login, through <code>passcontrol sidecar</code>. The sidecar
        checks each tool call against these rules before it runs: the strictest matching rule wins, and a tool
        no rule names is left to Claude Code&apos;s own permissions. They work inside Claude Code, through its
        hooks: a guard rail for your own sessions, not a wall against a client that skips them. Set up with{" "}
        <code>passcontrol configure claude-code --subscription --write</code>.
      </p>

      <ul className="pc-credential-list" aria-label="Tool rules">
        {rows.length === 0 ? (
          <li className="pc-credential-list__empty">No tool rules. Claude Code&apos;s own permissions decide.</li>
        ) : (
          rows.map((row, index) => {
            const kind = conditionFor(row.tool.trim());
            return (
              <li key={index} className="pc-credential" data-tool-rule={index} data-effect={row.effect}>
                <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2">
                  <label className="pc-field">
                    <span>Tool</span>
                    <input
                      value={row.tool}
                      list="pc-tool-names"
                      placeholder="Bash"
                      onChange={(e) => edit(index, { tool: e.target.value })}
                      autoComplete="off"
                      spellCheck={false}
                      data-field="tool"
                    />
                  </label>
                  {kind ? (
                    <label className="pc-field">
                      <span>{CONDITION_FIELD[kind].label}</span>
                      <input
                        value={row.condition}
                        placeholder={`${CONDITION_FIELD[kind].placeholder} (empty: every call)`}
                        onChange={(e) => edit(index, { condition: e.target.value })}
                        autoComplete="off"
                        spellCheck={false}
                        data-field="condition"
                      />
                    </label>
                  ) : (
                    <p className="text-xs text-muted-foreground">Every call to this tool.</p>
                  )}
                </div>
                <div className="pc-credential__actions">
                  <label className="pc-field">
                    <span>Then</span>
                    <select value={row.effect} onChange={(e) => edit(index, { effect: e.target.value })} data-field="effect">
                      {EFFECTS.map((effect) => (
                        <option key={effect.value} value={effect.value}>
                          {effect.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="ghost"
                    disabled={pending}
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                  >
                    <Trash2 aria-hidden="true" /> Remove
                  </button>
                </div>
              </li>
            );
          })
        )}
      </ul>
      <datalist id="pc-tool-names">
        {SUGGESTED_TOOLS.map((tool) => (
          <option key={tool} value={tool} />
        ))}
      </datalist>

      <button
        type="button"
        className="ghost justify-self-start"
        disabled={pending}
        onClick={() => setRows((current) => [...current, { tool: "Bash", effect: "deny", condition: "" }])}
        data-action="add-tool-rule"
      >
        <Plus aria-hidden="true" /> Add a rule
      </button>

      <p className="text-xs text-muted-foreground">
        <code>*</code> matches any run of characters. A Bash rule is checked against each command in a chain
        (<code>a &amp;&amp; b</code>, <code>a | b</code>, <code>a; b</code>), so <code>git push*</code> also catches{" "}
        <code>cd repo &amp;&amp; git push</code>. A path is absolute or starts with <code>*</code>. A domain{" "}
        <code>*.example.com</code> covers example.com and every subdomain. An MCP tool is named like{" "}
        <code>mcp__github__create_issue</code>, and <code>mcp__github__*</code> covers a whole server.
      </p>

      {asksOwner ? (
        <>
          <p className="pc-inline-notice" role="status" data-tool-ask-destination={alertDestination ?? "none"}>
            {alertDestination === "telegram"
              ? "Questions go to your Telegram with Approve and Deny buttons, and to the Approvals page. The tool waits, and runs only after your yes."
              : alertDestination === "slack" || alertDestination === "discord"
                ? `Questions go to your ${alertDestination === "slack" ? "Slack" : "Discord"} with a link to the Approvals page. The tool waits, and runs only after your yes.`
                : "Questions appear on the Approvals page; add Telegram under Settings, Alerts to answer with a tap. The tool waits, and runs only after your yes."}
          </p>
          <label className="pc-field">
            <span>Wait for my answer (seconds)</span>
            <input inputMode="numeric" value={wait} placeholder={String(DEFAULT_WAIT_S)} onChange={(e) => setWait(e.target.value)} />
            <small>
              Empty waits {DEFAULT_WAIT_S} s; at most 540. With no answer in time the tool is refused, never run. The
              question shows the tool&apos;s whole input: the command, the file path and any content being written,
              the address, or an MCP tool&apos;s arguments.
            </small>
          </label>
        </>
      ) : null}

      <div className="pc-settings-form__actions">
        <button type="button" disabled={pending} onClick={save} data-action="save-tool-rules">
          {pending ? "Saving…" : "Save tool rules"}
        </button>
      </div>

      {msg ? (
        <p className={msg.ok ? "pc-inline-notice is-success" : "pc-inline-notice is-danger"} role={msg.ok ? "status" : "alert"}>
          {msg.ok ? <CheckCircle2 aria-hidden="true" /> : null}
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}
