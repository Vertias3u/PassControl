// The agent page's tool rules editor (subscription mode, Phase 2; migration 0085).
//
// What must hold: a saved rule is shown with its own condition and effect, so a save
// never quietly changes one; the condition field is the one the tool takes (a command
// for Bash, a path for file tools, a domain for WebFetch, none for the rest); and the
// page says plainly what the rules are: a guard rail inside Claude Code, not a wall.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/dashboard/tool-rules-actions", () => ({ setAgentToolRules: vi.fn() }));

const { AgentToolRules, conditionFor } = await import("@/components/AgentToolRules");

const AGENT = "11111111-1111-4111-8111-111111111111";
const render = (props: Partial<Parameters<typeof AgentToolRules>[0]> = {}) =>
  renderToStaticMarkup(
    <AgentToolRules agentId={AGENT} read={{ state: "ok", document: null }} alertDestination="telegram" {...props} />
  );

describe("conditionFor", () => {
  it("names the condition each tool takes", () => {
    expect(conditionFor("Bash")).toBe("command");
    for (const tool of ["Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "Glob", "Grep"]) expect(conditionFor(tool)).toBe("path");
    expect(conditionFor("WebFetch")).toBe("domain");
    expect(conditionFor("mcp__github__create_issue")).toBeNull();
    expect(conditionFor("mcp__*")).toBeNull();
  });
});

describe("AgentToolRules", () => {
  it("shows each saved rule with its own condition and effect", () => {
    const html = render({
      read: {
        state: "ok",
        document: {
          rules: [
            { tool: "Bash", command: "git push*", effect: "ask_owner" },
            { tool: "WebFetch", domain: "*.example.com", effect: "deny" },
            { tool: "mcp__github__*", effect: "ask" },
          ],
          approval_wait_s: 180,
        },
      },
    });
    expect(html).toContain('value="git push*"');
    expect(html).toContain('value="*.example.com"');
    expect(html).toContain('value="mcp__github__*"');
    expect(html.match(/data-tool-rule="\d"/g)).toHaveLength(3);
    expect(html).toMatch(/data-tool-rule="0"[^>]*data-effect="ask_owner"/);
    expect(html).toMatch(/data-tool-rule="1"[^>]*data-effect="deny"/);
    expect(html).toContain('value="180"');
  });

  it("says what the rules are, and their honest limit", () => {
    const html = render();
    expect(html).toMatch(/Pro or Max/);
    expect(html).toMatch(/inside Claude Code/i);
    expect(html).toMatch(/configure claude-code --subscription --write/);
    expect(html).toContain('data-tool-rules="none"');
  });

  it("warns that unreadable rules refuse every tool, and that saving replaces them", () => {
    const html = render({ read: { state: "invalid" } });
    expect(html).toMatch(/every tool/i);
    expect(html).toContain('role="alert"');
  });

  it("does not offer an editor it cannot save from", () => {
    const html = render({ read: { state: "unknown" } });
    expect(html).toMatch(/could not be read/);
    expect(html).not.toContain('data-action="save-tool-rules"');
  });

  it("says where 'Ask me first' questions go", () => {
    const owner = { state: "ok" as const, document: { rules: [{ tool: "Bash", effect: "ask_owner" }] } };
    expect(render({ read: owner, alertDestination: "telegram" })).toMatch(/Telegram/);
    expect(render({ read: owner, alertDestination: null })).toMatch(/Approvals page/);
  });
});
