import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusPill, type StatusType } from "@/components/StatusPill";
import { CALL_OUTCOME } from "@/lib/call-outcome";

const render = (status: string) => renderToStaticMarkup(<StatusPill status={status as StatusType} />);

// These names report failed checks or an emergency control, not an ordinary
// policy decision. Keep them explicit so a new refusal must be covered below.
const exceptions = new Set(["blocked_killed", "blocked_budget_state", "blocked_delegation_unavailable"]);
const policyRefusals = Object.keys(CALL_OUTCOME).filter((status) => status.startsWith("blocked_") && !exceptions.has(status));

describe("status pill tones", () => {
  it.each(policyRefusals)("renders %s in the calm token colour", (status) => {
    const html = render(status);
    expect(html).toContain("color:var(--pc-calm)");
    expect(html).toContain("background:rgba(var(--pc-calm-rgb), 0.15)");
    expect(html).not.toMatch(/#(?:f59e0b|ef4444)/);
    expect(html).toContain(CALL_OUTCOME[status as keyof typeof CALL_OUTCOME].label);
  });

  it.each(["suspended", "revoked"])("renders the deliberate %s agent state calmly", (status) => {
    expect(render(status)).toContain("color:var(--pc-calm)");
  });

  it.each(["blocked_killed", "upstream_error"])("keeps the %s incident in danger", (status) => {
    expect(render(status)).toContain("color:#ef4444");
    expect(render(status)).not.toContain("var(--pc-calm)");
  });

  it.each(["blocked_budget_state", "blocked_delegation_unavailable", "usage_unknown", "provider_exhausted", "no_provider_key", "endpoint_unavailable", "endpoint_required", "credential_state_unavailable", "credential_changed", "dispatch_unavailable", "future_status"])("keeps %s needing attention in warning", (status) => {
    expect(render(status)).toContain("color:#f59e0b");
    expect(render(status)).not.toContain("var(--pc-calm)");
  });

  it.each(["active", "ok"])("keeps %s successful", (status) => {
    expect(render(status)).toContain("color:#10b981");
  });

  it("defines matching calm colour and RGB tokens outside hosted-only markers", () => {
    const css = readFileSync("app/globals.css", "utf8");
    const marker = "curate:";
    const shared = css.replace(new RegExp(String.raw`\/\* ${marker}private-start[\s\S]*?${marker}private-end[^*]*\*\/`, "g"), "");
    const root = shared.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(root).toMatch(/--pc-calm:\s*#8b93d9;/);
    expect(root).toMatch(/--pc-calm-rgb:\s*139,\s*147,\s*217;/);
  });
});
