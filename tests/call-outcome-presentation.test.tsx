// v1 playbook Session 06 — which worker did what, why it failed, and what can
// truthfully be concluded. Rendered, because the claims live in the words the
// DOM shows; unit cases only for the shared mappings and name filtering.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DepartureRow } from "@/lib/departures";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { DeparturesBoard } = await import("@/components/DeparturesBoard");
const { AuditLogTable } = await import("@/components/AuditLogTable");
const { CallDetailDrawer, nextActionsFor } = await import("@/components/dashboard/CallDetailDrawer");
const { StatusPill } = await import("@/components/StatusPill");
const { departureCounts, visibleDepartures } = await import("@/lib/departures");
const { CALL_OUTCOME, callOutcome, isDeliberateRefusal } = await import("@/lib/call-outcome");

const AGENT_A = "7a000000-0000-4000-8000-00000000000a";
const AGENT_B = "7a000000-0000-4000-8000-00000000000b";
const names = { [AGENT_A]: "Invoice worker", [AGENT_B]: "Support triage" };
const callContext = { shadowRevisions: {}, agentNames: names };

function row(over: Partial<DepartureRow> = {}): DepartureRow {
  return {
    id: "log-1",
    agent_id: AGENT_A,
    user_id: "u1",
    created_at: "2026-09-26T10:00:00.000Z",
    passport_id: null,
    jti: null,
    auth_method: "direct_key",
    agent_access_key_id: "11111111-2222-3333-4444-555555555555",
    credential_use_id: "c0ffee00-0000-4000-8000-000000000001",
    provider: "openai",
    model: "gpt-5-mini",
    input_tokens: 10,
    output_tokens: 20,
    cost_microcents: 100,
    status: "ok",
    latency_ms: 10,
    receipt: null,
    policy_shadow_would: null,
    ...over,
  };
}

/** An unsigned receipt-shaped string carrying a recorded upstream status. */
function receiptWithHttp(http: number): string {
  const seg = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${seg({ alg: "EdDSA" })}.${seg({ res: { http } })}.c2ln`;
}

describe("shared outcome vocabulary", () => {
  it("does not count PassControl failing to read its own state as a deliberate refusal", () => {
    expect(isDeliberateRefusal(callOutcome("blocked_budget_state").category)).toBe(false);
    expect(isDeliberateRefusal(callOutcome("dispatch_unavailable").category)).toBe(false);
    expect(isDeliberateRefusal(callOutcome("blocked_scope").category)).toBe(true);
    expect(isDeliberateRefusal(callOutcome("blocked_killed").category)).toBe(true);
    const counts = departureCounts([
      row({ id: "1", status: "blocked_scope" }),
      row({ id: "2", status: "blocked_budget_state" }),
      row({ id: "3", status: "upstream_error" }),
    ]);
    expect(counts.refused).toBe(1);
  });

  it("keeps provider failure, PassControl-side failure and a refusal in different categories", () => {
    expect(callOutcome("upstream_error").category).toBe("provider_failure");
    expect(callOutcome("credential_state_unavailable").category).toBe("passcontrol_side");
    expect(callOutcome("blocked_scope").category).toBe("refused_access");
    expect(callOutcome("no_provider_key").category).toBe("setup_incomplete");
    expect(callOutcome("usage_unknown").category).toBe("usage_unconfirmed");
  });

  it("names an unknown status verbatim instead of borrowing a known one", () => {
    const html = renderToStaticMarkup(<StatusPill status={"future_status" as never} />);
    expect(html).toContain("Unrecognised status: future_status");
    expect(html).not.toMatch(/Provider error/);
  });

  it("the pill and the agent page use the same words as the board's drawer", () => {
    for (const [status, { label }] of Object.entries(CALL_OUTCOME)) {
      expect(renderToStaticMarkup(<StatusPill status={status as never} />)).toContain(label);
    }
  });
});

describe("worker names on the call surfaces", () => {
  const rows = [
    row({ id: "a", agent_id: AGENT_A, status: "blocked_scope" }),
    row({ id: "b", agent_id: AGENT_B, status: "ok" }),
  ];

  it("filters by the displayed worker name", () => {
    const view = { filter: "all" as const, query: "invoice", showHousekeeping: true };
    expect(visibleDepartures(rows, view, names).map((r) => r.id)).toEqual(["a"]);
    // Without the names map the name is not searchable — which is the bug.
    expect(visibleDepartures(rows, view).map((r) => r.id)).toEqual([]);
  });

  it("shows the worker first on the board, and a Direct Agent Key refusal is not a visa", () => {
    const html = renderToStaticMarkup(
      <DeparturesBoard userId="u1" initialRows={rows} callContext={callContext} logsAvailable />
    );
    expect(html).toContain("Invoice worker");
    expect(html).toContain("Support triage");
    expect(html).toContain("Direct Agent Key 11111111");
    expect(html).toContain("NOT ALLOWED");
    expect(html).not.toContain("NO VISA");
    expect(html).toContain('data-outcome-category="refused_access"');
    expect(html).toContain('data-outcome-category="forwarded"');
  });

  it("says PROVIDER ERROR, not DIVERTED, for a call the provider refused", () => {
    const html = renderToStaticMarkup(
      <DeparturesBoard
        userId="u1"
        initialRows={[row({ status: "upstream_error", receipt: receiptWithHttp(401), input_tokens: 0, output_tokens: 0, cost_microcents: 0 })]}
        callContext={callContext}
        logsAvailable
      />
    );
    expect(html).toContain("PROVIDER ERROR");
    expect(html).not.toContain("DIVERTED");
    expect(html).toContain('data-outcome-category="provider_failure"');
  });

  it("names the worker in the history table and does not print a refusal's zeros as tokens", () => {
    const html = renderToStaticMarkup(<AuditLogTable logs={rows} callContext={callContext} logsAvailable />);
    expect(html).toContain("Invoice worker");
    expect(html).toContain("Outside allowed access");
    const refused = html.slice(html.indexOf('data-outcome-category="refused_access"'));
    expect(refused.slice(0, refused.indexOf("</tr>"))).not.toMatch(/<td>0<\/td>/);
  });
});

describe("the call drawer sends the operator to the right next place", () => {
  const drawer = (r: DepartureRow, agentName: string | null = "Invoice worker") =>
    renderToStaticMarkup(
      <CallDetailDrawer row={r} open onOpenChange={() => {}} currentShadowRevision={null} agentName={agentName} />
    );

  it("a provider 401, a scope refusal and a PassControl-side 503 lead to different actions", () => {
    const provider = nextActionsFor(row({ status: "upstream_error" }), 401).map((a) => a.href);
    const scope = nextActionsFor(row({ status: "blocked_scope" }), null).map((a) => a.href);
    const infra = nextActionsFor(row({ status: "blocked_budget_state" }), null).map((a) => a.href);
    expect(provider[0]).toBe("/dashboard/settings#provider-credentials");
    expect(scope[0]).toBe(`/dashboard/agents/${AGENT_A}#agent-access`);
    expect(infra[0]).toBe("/dashboard/system");
    expect(new Set([provider[0], scope[0], infra[0]]).size).toBe(3);
  });

  it("shows the outcome, the provider's answer and the worker before technical identifiers", () => {
    const html = drawer(row({ status: "upstream_error", receipt: receiptWithHttp(401) }));
    const verdict = html.indexOf("Provider error");
    expect(verdict).toBeGreaterThan(-1);
    expect(html.indexOf("Provider answered HTTP 401")).toBeGreaterThan(verdict);
    expect(html.indexOf("Invoice worker")).toBeLessThan(html.indexOf("Stored agent ID"));
    expect(html).toContain(`href="/dashboard/agents/${AGENT_A}"`);
    expect(html).toContain('data-next-action="Provider credentials"');
  });

  it("explains a Direct Agent Key scope refusal without a visa", () => {
    const html = drawer(row({ status: "blocked_scope" }));
    expect(html).toContain("Outside allowed access");
    expect(html).toMatch(/allowed access, read when the request arrived/);
    expect(html).not.toMatch(/visa/i);
  });

  it("offers today's controls as a present-time tool, not a replay", () => {
    const html = drawer(row({ status: "blocked_policy" }));
    expect(html).toContain('data-next-action="Test current controls"');
    expect(html).toMatch(/does not replay this call/);
  });

  it("points a stored receipt at the receipt verifier, and does not call a missing one evidence", () => {
    const withReceipt = drawer(row({ receipt: receiptWithHttp(200) }));
    expect(withReceipt).toContain('href="/verify/receipt"');
    expect(withReceipt).toMatch(/not a complete history/);
    const without = drawer(row({ receipt: null }));
    expect(without).toMatch(/not evidence either way/);
  });

  it("does not invent a name for an agent that is no longer in the workspace", () => {
    const html = drawer(row(), null);
    expect(html).toContain("Agent no longer in this workspace");
    expect(html).toContain(AGENT_A);
  });
});

