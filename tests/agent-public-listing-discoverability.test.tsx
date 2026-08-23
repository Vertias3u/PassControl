import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AgentFleetTable } from "@/components/AgentFleetTable";

const agent = (overrides: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "research-internal",
  passport_pubkey: "pcp_1234567890abcdef",
  status: "active",
  budget_tokens: 10_000,
  budget_cents: 500,
  spent_tokens: 250,
  spent_microcents: 1_000_000,
  last_seen_at: null,
  expires_at: null,
  allowed_scopes: [],
  published: false,
  public_label: null,
  ...overrides,
});

const render = (row: ReturnType<typeof agent>) =>
  renderToStaticMarkup(<AgentFleetTable agents={[row]} visaTtlSeconds={300} />);

const occurrences = (value: string, fragment: string) => value.split(fragment).length - 1;

describe("public agent listing discoverability in the fleet", () => {
  it("shows the published label and links directly to the disclosure control", () => {
    const out = render(agent({ published: true, public_label: "Research Agent" }));

    expect(out).toContain("Selected for public profile as Research Agent");
    expect(
      occurrences(
        out,
        'href="/dashboard/agents/11111111-1111-4111-8111-111111111111#agent-public"'
      )
    ).toBe(2);
    expect(occurrences(out, "Manage public listing")).toBe(2);
  });

  it("makes an unlisted passport agent actionable instead of hiding the feature", () => {
    const out = render(agent());

    expect(out).toContain("Not publicly listed");
    expect(occurrences(out, "Set up public listing")).toBe(2);
  });

  it("explains why a Direct Agent Key-only agent cannot be listed", () => {
    const out = render(agent({ passport_pubkey: null }));

    expect(out).toContain("Public listing requires a passport");
    expect(occurrences(out, "Add passport to list")).toBe(2);
    expect(
      occurrences(
        out,
        'href="/dashboard/agents/11111111-1111-4111-8111-111111111111#agent-identity"'
      )
    ).toBe(2);
  });
});
