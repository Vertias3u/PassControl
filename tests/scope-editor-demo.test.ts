import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("@/app/dashboard/actions", () => ({ updateAgentScopes: vi.fn() }));
vi.mock("@/components/ImpactPreview", () => ({ ImpactPreview: () => null }));
import { ScopeEditor } from "@/components/ScopeEditor";

it("renders the saved demo scope as the selected provider in a mixed agent", () => {
  // login now creates exactly this scope shape. The editor must display the
  // saved provider, rather than leaving the select with no matching option.
  vi.stubGlobal("React", React);
  try {
    const html = renderToStaticMarkup(React.createElement(ScopeEditor, {
      agentId: "test-agent",
      scopes: [
        { provider: "demo", models: ["*"] },
        { provider: "anthropic", models: ["claude-*"] },
      ],
      ttlSeconds: 60,
      onClose: () => {},
    }));
    const firstSelect = html.match(/<select\b[^>]*>([\s\S]*?)<\/select>/)?.[1];
    expect(firstSelect).toBeDefined();
    expect(firstSelect, "the first row must name its saved keyless provider")
      .toMatch(/<option\b(?=[^>]*value="demo")(?=[^>]*selected)[^>]*>/);
  } finally {
    vi.unstubAllGlobals();
  }
});
