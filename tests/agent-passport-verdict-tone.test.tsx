import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentPassport } from "@/components/AgentPassport";
import { StatusPill, type StatusType } from "@/components/StatusPill";
import { buildAgentPassportView } from "@/app/dashboard/agents/[id]/passport-data";
import { CALL_OUTCOME } from "@/lib/call-outcome";

vi.mock("@/components/ScopeEditor", () => ({ ScopeEditor: () => null }));
vi.mock("@/components/FallbackEditor", () => ({ FallbackEditor: () => null }));
vi.mock("@/components/CapabilityHistory", () => ({ CapabilityHistory: () => null }));
vi.mock("@/components/DirectAgentIdentity", () => ({ DirectAgentIdentity: () => null }));

function verdictRow(status: string): string {
  const passport = buildAgentPassportView({
    id: "a0000000-0000-4000-8000-000000000001", name: "Verdict sample",
    passport_pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", status: "active",
    budget_tokens: 100, budget_cents: 100, spent_tokens: 0,
    spent_microcents: 0, allowed_scopes: [],
    created_at: "2026-10-01T00:00:00Z", last_seen_at: null,
  }, [{
    id: "recorded-verdict", provider: "openai", model: "gpt-4.1-mini", status,
    auth_method: "passport", created_at: "2026-10-22T12:00:00Z",
  }]);
  const html = renderToStaticMarkup(<AgentPassport passport={passport} visaTtlSeconds={300} />);
  const row = html.match(/<li\b[^>]*data-outcome-category="[^"]+"[\s\S]*?<\/li>/)?.[0];
  expect(row).toBeDefined();
  return row!;
}

describe("agent passport recorded verdict tones", () => {
  it.each(["blocked_scope", "blocked_budget_pause"])("renders %s calmly in the actual passport row", (status) => {
    const row = verdictRow(status);
    expect(row).toContain("color:var(--pc-calm)");
    expect(row).toContain("background:rgba(var(--pc-calm-rgb), 0.15)");
    expect(row).not.toMatch(/text-danger|bg-danger|border-danger|#ef4444/);
    expect(row).toContain(CALL_OUTCOME[status as keyof typeof CALL_OUTCOME].label);
  });

  it.each(["blocked_killed", "upstream_error"])("keeps the %s incident in danger", (status) => {
    expect(verdictRow(status)).toContain("color:#ef4444");
  });

  it("matches the overview pill's tone for every recorded call status", () => {
    for (const status of Object.keys(CALL_OUTCOME)) {
      const overview = renderToStaticMarkup(<StatusPill status={status as StatusType} />);
      const style = overview.match(/style="[^"]+"/)?.[0];
      expect(style).toBeDefined();
      expect(verdictRow(status), status).toContain(style!);
    }
  });

  it("keeps an unfamiliar recorded status explicit", () => {
    const row = verdictRow("future_status");
    expect(row).toContain("Unknown · future_status");
    expect(row).not.toContain("Provider error");
  });
});
