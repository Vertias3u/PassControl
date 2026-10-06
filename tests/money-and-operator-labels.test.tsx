// v1 playbook Session 06, requirements 4–6 — money labels, operator actions,
// provider credentials and setup failures. Rendered: the defects are words.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DepartureRow } from "@/lib/departures";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/app/dashboard/actions-client", () => ({
  setAgentSuspended: vi.fn(),
  observeAgentControl: vi.fn(),
  updateAgentBudgets: vi.fn(),
  updateAgentScopes: vi.fn(),
  addProviderKey: vi.fn(),
  rotateProviderKey: vi.fn(),
  setActiveProviderKey: vi.fn(),
  deleteProviderKey: vi.fn(),
  setProviderEndpoint: vi.fn(),
}));

const { SpendChart } = await import("@/components/SpendChart");
const { AgentFleetTable } = await import("@/components/AgentFleetTable");
const { AdminAuditTable } = await import("@/components/AdminAuditTable");
const { AgentSetupPanel } = await import("@/components/AgentSetupPanel");
const { ProviderKeysManager } = await import("@/components/ProviderKeysManager");
const { OperationsPanel } = await import("@/components/dashboard/OperationsPanel");

const AGENT = "7a000000-0000-4000-8000-00000000000a";

function log(over: Partial<DepartureRow> = {}): DepartureRow & { created_at: string } {
  return {
    id: "l",
    agent_id: AGENT,
    user_id: "u1",
    passport_id: null,
    jti: null,
    auth_method: "direct_key",
    agent_access_key_id: "k",
    credential_use_id: "c",
    provider: "openai",
    model: "gpt-5-mini",
    input_tokens: 100,
    output_tokens: 50,
    cost_microcents: 1_000_000,
    status: "ok",
    receipt: null,
    policy_shadow_would: null,
    ...over,
    created_at: over.created_at ?? "2026-09-26T10:00:00.000Z",
  };
}

describe("spend totals say what they are", () => {
  it("keeps unconfirmed usage out of the reported total and says so", () => {
    const html = renderToStaticMarkup(
      <SpendChart
        userId="u1"
        logsAvailable
        initialLogs={[
          log({ id: "a" }),
          log({ id: "b", status: "usage_unknown", input_tokens: 999, output_tokens: 0, cost_microcents: 7_000_000 }),
        ]}
      />
    );
    expect(html).toContain("Reported tokens in loaded window");
    expect(html).toContain(">150<");
    expect(html).not.toContain("1,149");
    expect(html).toContain("excludes 1 with usage unconfirmed");
    expect(html).toMatch(/List-price estimate, not an invoice/);
  });
});

describe("caps are cumulative and the monthly allowance is separate", () => {
  const agent = {
    id: AGENT,
    name: "Invoice worker",
    status: "active",
    passport_pubkey: null,
    budget_tokens: 10_000,
    budget_cents: 500,
    spent_tokens: 2_000,
    spent_microcents: 100_000_000,
    allowed_scopes: [{ provider: "openai", models: ["gpt-5-mini"] }],
    created_at: "2026-09-01T00:00:00.000Z",
    last_seen_at: null,
  };

  it("labels the fleet meters as cumulative caps, not limits or a balance", () => {
    const html = renderToStaticMarkup(
      <AgentFleetTable agents={[agent as never]} agentsAvailable visaTtlSeconds={300} logsAvailable />
    );
    expect(html).toContain("Token cap (cumulative)");
    expect(html).toContain("Cost cap (cumulative)");
    expect(html).toContain("2,000 charged");
    expect(html).toContain("10,000 cap");
    expect(html).not.toMatch(/remaining|left to spend|available balance/i);
  });

});

describe("operator actions exercised by activation and stopping read plainly", () => {
  const rows = [
    { id: "1", created_at: "2026-09-26T10:00:00Z", action: "agent.direct_key.revoke", target_type: "agent", target_id: AGENT, metadata: { name: "laptop", suffix: "AbCd1234" } },
    { id: "2", created_at: "2026-09-26T10:01:00Z", action: "agent.update", target_type: "agent", target_id: AGENT, metadata: { fields: "allowed_scopes", via: "dashboard" } },
    { id: "3", created_at: "2026-09-26T10:02:00Z", action: "agent.update", target_type: "agent", target_id: AGENT, metadata: { fields: "budget_tokens,budget_cents", budgets_live: true } },
    { id: "4", created_at: "2026-09-26T10:03:00Z", action: "agent.suspend", target_type: "agent", target_id: AGENT, metadata: { suspended: true } },
  ];

  it("labels key revocation, access and cap changes, and names the agent", () => {
    const html = renderToStaticMarkup(<AdminAuditTable rows={rows} agentNames={{ [AGENT]: "Invoice worker" }} />);
    expect(html).toContain("Installation key revoked");
    expect(html).toContain("Allowed access changed");
    expect(html).toContain("Cumulative caps changed");
    expect(html).toContain("Agent suspended");
    expect(html).toContain("Invoice worker (agent 7a000000…)");
    expect(html).not.toContain(">agent.update<");
  });
});

describe("provider credentials: stored is not tested", () => {
  it("says a stored credential has not been tested, and a custom endpoint's cost is unknown, not free", () => {
    const html = renderToStaticMarkup(
      <ProviderKeysManager
        credentials={[
          { id: "c1", provider: "anthropic", label: "main", is_active: true, created_at: "2026-09-20T00:00:00Z" } as never,
        ]}
      />
    );
    expect(html).toContain('data-credential-check="stored-not-tested"');
    expect(html).toMatch(/stored, not tested by\s+PassControl/);
    const source = readFileSync("components/ProviderKeysManager.tsx", "utf8");
    expect(source).toMatch(/unknown, not free/);
  });
});

describe("setup tells the three look-alike failures apart", () => {
  it("sends a PassControl 401, a provider 401, a scope 403 and an auth 503 to different places", () => {
    const html = renderToStaticMarkup(
      <AgentSetupPanel
        agentId={AGENT}
        agentName="Invoice worker"
        status="active"
        scopes={[{ provider: "openai", models: ["gpt-5-mini"] }]}
        keys={[{ id: "k1", name: "laptop", suffix: "AbCd1234", expiresAt: null, revokedAt: null }]}
      />
    );
    const item = (code: string) => {
      const start = html.indexOf(`data-failure="${code}"`);
      return html.slice(start, html.indexOf("</li>", start));
    };
    expect(item("invalid_credential")).toContain('href="#direct-agent-keys"');
    expect(item("invalid_credential")).toMatch(/No call record is\s+written/);
    expect(item("provider_401")).toContain('href="/dashboard/settings#provider-credentials"');
    expect(item("blocked_scope")).toContain('href="#agent-access"');
    expect(item("authentication_unavailable")).toContain('href="/dashboard/system"');
  });
});
