// K1 — the workspace export carries the periodic limit, and a database that has
// not applied 0073 still exports (its agents have no periodic limit to lose).
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { loadWorkspaceExport } from "@/lib/workspace-export";

function fakeDb(opts: { has0073: boolean }) {
  const agentSelects: string[] = [];
  const builder = (table: string) => {
    let columns = "";
    const b: any = {
      select: (cols: string) => {
        columns = cols;
        if (table === "agents") agentSelects.push(cols);
        return b;
      },
      eq: () => b,
      order: () => b,
      range: async () => {
        if (table === "agents" && columns.includes("budget_period") && !opts.has0073) {
          return { data: null, error: { code: "42703", message: "column agents.budget_period does not exist" } };
        }
        if (table !== "agents") return { data: [], error: null };
        const row: Record<string, unknown> = { id: "a1", name: "bot" };
        if (columns.includes("budget_period")) Object.assign(row, { budget_period: "day", budget_period_cents: 2500 });
        return { data: [row], error: null };
      },
      maybeSingle: async () => ({ data: null, error: null }),
    };
    return b;
  };
  return { client: { from: (t: string) => builder(t) } as never, agentSelects };
}

describe("workspace export and the periodic limit", () => {
  it("exports the pair when the database has it", async () => {
    const { client, agentSelects } = fakeDb({ has0073: true });
    const out = await loadWorkspaceExport(client, "u1");
    expect(out.workspace.agents[0]).toMatchObject({ budget_period: "day", budget_period_cents: 2500 });
    expect(agentSelects).toHaveLength(1);
  });

  it("still exports from a database without 0073, instead of failing the whole file", async () => {
    const { client, agentSelects } = fakeDb({ has0073: false });
    const out = await loadWorkspaceExport(client, "u1");
    expect(out.workspace.agents).toHaveLength(1);
    expect(agentSelects).toHaveLength(2);
    expect(agentSelects[1]).not.toContain("budget_period");
  });
});
