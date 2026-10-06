import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentSectionNav, type AgentNavGroup } from "@/components/dashboard/AgentSectionNav";

// The agent page's section nav (owner, 2026-10-06; Emil Kowalski / apple-design):
// three fixed segments that never move, a pill that slides to the active one,
// and one sub-row with only that group's links. Every section id the page had
// stays reachable: refusal messages, the fleet table and the services page
// deep-link into them.

const GROUPS: AgentNavGroup[] = [
  { id: "identity", label: "Identity", links: [{ href: "#agent-operate", label: "Status" }, { href: "#agent-overview", label: "Overview" }] },
  { id: "access", label: "Access", links: [{ href: "#agent-policy", label: "Policy" }] },
  { id: "record", label: "Record", links: [{ href: "#agent-activity", label: "Activity" }] },
];

describe("AgentSectionNav", () => {
  const html = renderToStaticMarkup(<AgentSectionNav groups={GROUPS} />);

  it("renders exactly three segments as a tab list, Identity selected first", () => {
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>[\s\S]*?Identity/);
    expect(html).toContain('role="tablist"');
  });

  it("shows only the active group's links", () => {
    expect(html).toContain('href="#agent-operate"');
    expect(html).toContain('href="#agent-overview"');
    expect(html).not.toContain('href="#agent-policy"');
    expect(html).not.toContain('href="#agent-activity"');
  });

  it("keeps the sticky class the layout relies on", () => {
    expect(html).toContain('class="pc-agent-subnav"');
  });

  it("moves the highlight with clip-path, not by moving the segments", () => {
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toMatch(/\.pc-agent-nav__highlight\s*\{[^}]*clip-path/);
    expect(css).toMatch(/\.pc-agent-nav__highlight\s*\{[^}]*transition:\s*clip-path 200ms/);
  });
});

describe("the agent page's nav groups", () => {
  const page = readFileSync("app/dashboard/agents/[id]/page.tsx", "utf8");

  it("still links every section the page has", () => {
    for (const id of ["agent-operate", "agent-overview", "agent-identity", "agent-setup", "agent-policy", "agent-policy-lab", "agent-emergency", "agent-activity", "agent-trace"]) {
      expect(page, id).toContain(`"#${id}"`);
    }
    expect(page).toContain("`#${display.sectionId}`");
    expect(page).toContain('"Temporary access (break glass)"');
  });

  it("uses the three groups only", () => {
    expect(page).toContain("<AgentSectionNav");
    expect(page).not.toContain('className="pc-agent-subnav__group"');
  });
});
