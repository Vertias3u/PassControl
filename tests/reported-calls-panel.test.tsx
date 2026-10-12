// The agent page's "Reported by Claude Code" section (subscription mode, Phase 1b;
// migration 0084): the model calls Claude Code reported from a Pro/Max login.
//
// What must never happen on this panel: a reported call reading as one the gateway
// proxied or holds a receipt for, its API-equivalent cost reading as money spent, or
// an unknown cost reading as $0.00. And a database before 0084 must not break the
// agent page.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("server-only", () => ({}));

const { ReportedCallsPanel, ToolDecisionsPanel, formatApiEquivalent } = await import("@/components/ReportedCallsPanel");
const { readReportedCalls, readToolDecisions } = await import("@/app/dashboard/agents/[id]/reported-data");

const AGENT = "11111111-1111-4111-8111-111111111111";

const row = (over: Record<string, unknown> = {}) => ({
  event_key: "evt_0123456789abcdef",
  kind: "model_call",
  auth_method: "passport",
  client_session: "4f6c1d2e-0000-4000-8000-000000000001",
  client_agent: null,
  model: "claude-haiku-5-5",
  occurred_at: "2026-10-11T19:00:00.000Z",
  received_at: "2026-10-11T19:00:02.000Z",
  input_tokens: 120,
  output_tokens: 40,
  reported_cost_usd_micros: 3_927,
  duration_ms: 1_097,
  status_code: null,
  ...over,
});

describe("formatApiEquivalent", () => {
  it("prints dollars from millionths, and an unknown as a dash, never $0", () => {
    expect(formatApiEquivalent(3_927)).toBe("$0.0039");
    expect(formatApiEquivalent(1_234_567)).toBe("$1.2346");
    expect(formatApiEquivalent(0)).toBe("$0.0000");
    expect(formatApiEquivalent(null)).toBe("—");
  });
});

describe("ReportedCallsPanel", () => {
  it("says what these rows are: reported by the client, not proxied, no receipt, cost not spent", () => {
    const html = renderToStaticMarkup(<ReportedCallsPanel read={{ state: "ok", rows: [row()] }} />);
    expect(html).toContain("Reported by Claude Code");
    expect(html).toMatch(/not proxied/i);
    expect(html).toMatch(/no receipt/i);
    expect(html).toMatch(/API-equivalent/);
    expect(html).toMatch(/never charged|not charged/i);
    expect(html).toContain('data-state="ok"');
    expect(html).toContain("claude-haiku-5-5");
    expect(html).toContain("$0.0039");
    // Never the receipt-bearing words.
    expect(html).not.toMatch(/\bverified\b|\bsigned\b|\bboarded\b/i);
  });

  it("totals what it shows as API-equivalent, and says how many had no cost", () => {
    const html = renderToStaticMarkup(
      <ReportedCallsPanel
        read={{
          state: "ok",
          rows: [row(), row({ event_key: "evt_1", reported_cost_usd_micros: 1_000_000 }), row({ event_key: "evt_2", reported_cost_usd_micros: null })],
        }}
      />
    );
    expect(html).toContain("3 calls");
    expect(html).toContain("$1.0039 API-equivalent");
    expect(html).toContain("1 with no reported cost");
  });

  it("shows an error as an error, with its status, and its cost as a dash", () => {
    const html = renderToStaticMarkup(
      <ReportedCallsPanel read={{ state: "ok", rows: [row({ kind: "model_error", status_code: 529, reported_cost_usd_micros: null })] }} />
    );
    expect(html).toContain('data-kind="model_error"');
    expect(html).toContain("529");
    expect(html).not.toContain("$0.0000");
  });

  it("names a sub-agent and the credential class that uploaded the row", () => {
    const html = renderToStaticMarkup(
      <ReportedCallsPanel read={{ state: "ok", rows: [row({ client_agent: "general-purpose", auth_method: "direct_key" })] }} />
    );
    expect(html).toContain("general-purpose");
    expect(html).toMatch(/Direct Agent Key/);
  });

  it("renders nothing when there is nothing reported, or the records are not available", () => {
    expect(renderToStaticMarkup(<ReportedCallsPanel read={{ state: "ok", rows: [] }} />)).toBe("");
    expect(renderToStaticMarkup(<ReportedCallsPanel read={{ state: "unavailable" }} />)).toBe("");
  });
});

describe("readReportedCalls", () => {
  function db(result: { data: unknown; error: unknown }) {
    const filters: [string, unknown][] = [];
    const calls: string[] = [];
    const chain = {
      select: (cols: string) => (calls.push(`select:${cols}`), chain),
      eq: (column: string, value: unknown) => (filters.push([column, value]), chain),
      in: (column: string, values: unknown) => (filters.push([column, values]), chain),
      order: (column: string) => (calls.push(`order:${column}`), chain),
      limit: (n: number) => (calls.push(`limit:${n}`), Promise.resolve(result)),
    };
    return { client: { from: (table: string) => (calls.push(`from:${table}`), chain) }, filters, calls };
  }

  it("reads this agent's newest reported calls from their own table", async () => {
    const d = db({ data: [row()], error: null });
    const read = await readReportedCalls(d.client as never, AGENT);
    expect(read).toEqual({ state: "ok", rows: [row()] });
    expect(d.calls[0]).toBe("from:client_reported_calls");
    // Only the calls: the tool rules' decisions have their own section.
    expect(d.filters).toEqual([["agent_id", AGENT], ["kind", ["model_call", "model_error"]]]);
    expect(d.calls).toContain("order:received_at");
  });

  it("reads this agent's newest tool decisions apart from its calls", async () => {
    const d = db({ data: [], error: null });
    expect(await readToolDecisions(d.client as never, AGENT)).toEqual({ state: "ok", rows: [] });
    expect(d.filters).toEqual([["agent_id", AGENT], ["kind", ["tool_decision"]]]);
    expect(d.calls.find((c) => c.startsWith("select:"))).toMatch(/tool_name.*decision.*rule_index/);
    expect(await readToolDecisions(db({ data: null, error: { code: "42703" } }).client as never, AGENT)).toEqual({ state: "unavailable" });
  });

  it("answers unavailable, not an error, on a database before 0084", async () => {
    for (const error of [{ code: "42P01", message: "relation does not exist" }, { code: "PGRST205", message: "schema cache" }]) {
      expect(await readReportedCalls(db({ data: null, error }).client as never, AGENT)).toEqual({ state: "unavailable" });
    }
  });

  it("answers unavailable when the read throws", async () => {
    const client = { from: () => { throw new Error("boom"); } };
    expect(await readReportedCalls(client as never, AGENT)).toEqual({ state: "unavailable" });
  });
});

// Phase 2: what the agent's tool rules decided at Claude Code's PreToolUse hook.
describe("ToolDecisionsPanel", () => {
  const decision = (over: Record<string, unknown> = {}) => ({
    event_key: "evt_tool000000000001",
    client_session: "4f6c1d2e-0000-4000-8000-000000000001",
    client_agent: null,
    occurred_at: "2026-10-12T09:00:00.000Z",
    received_at: "2026-10-12T09:00:03.000Z",
    tool_name: "Bash",
    decision: "owner_approved",
    rule_index: 0,
    duration_ms: 41_000,
    auth_method: "passport",
    ...over,
  });

  it("names each decision in words, with its rule and how long the owner took", () => {
    const html = renderToStaticMarkup(
      <ToolDecisionsPanel
        read={{
          state: "ok",
          rows: [
            decision(),
            decision({ event_key: "e2", decision: "deny", rule_index: 2, duration_ms: 0 }),
            decision({ event_key: "e3", decision: "owner_timeout", tool_name: "mcp__github__create_issue" }),
            decision({ event_key: "e4", decision: "rules_invalid", rule_index: null }),
          ],
        }}
      />
    );
    expect(html).toContain('id="agent-tool-decisions"');
    expect(html).toContain("Owner said yes");
    expect(html).toContain("Refused by a rule");
    expect(html).toContain("Owner did not answer");
    expect(html).toContain("Rules could not be read");
    expect(html).toContain("rule 3");
    expect(html).toContain("41.0 s");
    expect(html).toContain("mcp__github__create_issue");
    expect(html).toMatch(/never the command/i);
    expect(html).toContain('data-decision="deny"');
  });

  it("renders nothing when there are no decisions, or they are not available", () => {
    expect(renderToStaticMarkup(<ToolDecisionsPanel read={{ state: "ok", rows: [] }} />)).toBe("");
    expect(renderToStaticMarkup(<ToolDecisionsPanel read={{ state: "unavailable" }} />)).toBe("");
  });
});

