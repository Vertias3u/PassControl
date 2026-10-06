// Session 07, step 10/12 — the scope editor told the operator of a Direct
// Agent Key-only agent that a change "takes effect on the agent's next visa"
// and that "the gateway checks the scope carried in the visa, not this
// record". Live, the change applied on that key's very next request: a Direct
// Agent Key is checked against the agent's CURRENT access every time (see
// scopeRefusalExplanation in lib/call-outcome.ts). Only a passport work-visa
// carries a snapshot. The timing copy must follow the credentials the agent
// actually has.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/dashboard/actions-client", () => ({ updateAgentScopes: vi.fn() }));

const { ScopeEditor } = await import("@/components/ScopeEditor");

const scopes = [{ provider: "anthropic", models: ["claude-haiku-4-5"] }];

function editor(hasPassport: boolean, rows = scopes) {
  return renderToStaticMarkup(
    <ScopeEditor agentId="a1" scopes={rows} ttlSeconds={300} hasPassport={hasPassport} onClose={() => {}} />
  );
}

describe("scope editor timing follows the agent's credentials", () => {
  it("does not describe a visa snapshot for an agent with no passport", () => {
    const html = editor(false);
    expect(html).not.toMatch(/next visa/);
    expect(html).not.toMatch(/carried in the visa/);
    expect(html).toMatch(/Direct Agent Key[^.]*next request/);
  });

  it("keeps the visa delay for an agent that has a passport, beside the immediate key rule", () => {
    const html = editor(true);
    expect(html).toMatch(/work-visa already issued keeps the old access/);
    expect(html).toMatch(/5 minutes/);
    expect(html).toMatch(/Direct Agent Key[^.]*next request/);
  });

  it("warns that the AGENT reaches nothing, not a passport it may not have", () => {
    const html = editor(false, []);
    // The editor seeds one empty row when there are no scopes; an empty row grants nothing.
    expect(html).toContain('data-state="reaches-nothing"');
    expect(html).not.toMatch(/this passport will reach nothing/);
    expect(html).toMatch(/this agent will reach nothing/);
  });
});
