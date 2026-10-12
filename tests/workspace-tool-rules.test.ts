// An agent's Claude Code tool rules (`agents.tool_rules`, 0085) travel with the
// workspace and the account export, like its service rules: exported with the agent,
// validated by the sidecar's own parser on import, refused rather than dropped, and a
// database before 0085 still exports everything else.
import { describe, expect, it } from "vitest";
import { ACCOUNT_EXPORT_TABLES } from "@/lib/account-lifecycle";
import { loadWorkspaceExport } from "@/lib/workspace-export";
import { planAgentImports } from "@/lib/workspace-import";

const PUBKEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const RULES = {
  github: { allow: [{ method: "GET", path: "/repos/acme/*/issues" }], max_requests_per_hour: 50 },
};
const TOOL_RULES = { rules: [{ tool: "Bash", command: "git push*", effect: "ask_owner" }], approval_wait_s: 180 };

function agent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "triage-bot",
    passport_pubkey: PUBKEY,
    allowed_scopes: [{ provider: "anthropic", models: ["claude-*"] }],
    budget_tokens: 1000,
    budget_cents: null,
    policy: null,
    policy_shadow: null,
    fallbacks: [],
    status: "active",
    expires_at: null,
    ...over,
  };
}

/** A database missing the given columns answers a select naming any of them with 42703. */
function db(missing: string[], agentRow: Record<string, unknown>) {
  const agentSelects: string[] = [];
  const client = {
    from(table: string) {
      let columns = "";
      const chain: Record<string, unknown> = {
        select: (cols: string) => {
          columns = cols;
          if (table === "agents") agentSelects.push(cols);
          return chain;
        },
        eq: () => chain,
        order: () => chain,
        range: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (v: unknown) => void) => {
          const absent = missing.find((column) => columns.split(",").includes(column));
          if (absent) return resolve({ data: null, error: { code: "42703", message: `column ${absent} does not exist` } });
          if (table !== "agents") return resolve({ data: [], error: null });
          const row = Object.fromEntries(columns.split(",").filter((c) => c in agentRow).map((c) => [c, agentRow[c]]));
          return resolve({ data: [row], error: null });
        },
      };
      return chain;
    },
  };
  return { client: client as never, agentSelects };
}


const stored = {
  id: "a1",
  created_at: "2026-09-30T00:00:00Z",
  published: false,
  public_label: null,
  ...agent(),
  budget_period: "day",
  budget_period_cents: 2500,
  service_rules: RULES,
  tool_rules: TOOL_RULES,
};
const rowOf = (plan: ReturnType<typeof planAgentImports>) => (plan[0] as { row: Record<string, unknown> }).row;

describe("exporting an agent's tool rules", () => {
  it("carries tool_rules with the agent", async () => {
    const { client } = db([], stored);
    expect((await loadWorkspaceExport(client, "u1")).workspace.agents[0]).toMatchObject({ tool_rules: TOOL_RULES, service_rules: RULES });
  });

  it("keeps the service rules on a database that has 0074 but not 0085", async () => {
    const { client, agentSelects } = db(["tool_rules"], stored);
    const out = (await loadWorkspaceExport(client, "u1")).workspace.agents[0];
    expect(out).toMatchObject({ service_rules: RULES });
    expect(out).not.toHaveProperty("tool_rules");
    expect(agentSelects).toHaveLength(2);
  });

  it("is in the account export, with a step down for a database before 0085", () => {
    const agents = ACCOUNT_EXPORT_TABLES.find((t) => t.key === "agents")!;
    expect(agents.columns.split(",")).toContain("tool_rules");
    expect(agents.fallbackColumns![0]!.split(",")).not.toContain("tool_rules");
    expect(agents.fallbackColumns![0]!.split(",")).toContain("service_rules");
  });
});

describe("importing an agent's tool rules", () => {
  it("restores valid rules as they were, and round-trips the export", async () => {
    expect(rowOf(planAgentImports([agent({ tool_rules: TOOL_RULES })], [])).tool_rules).toEqual(TOOL_RULES);
    const { client } = db([], stored);
    const exported = (await loadWorkspaceExport(client, "u1")).workspace.agents;
    expect(rowOf(planAgentImports(exported, [])).tool_rules).toEqual(TOOL_RULES);
  });

  it("writes nothing for an older file or an agent with no rules, so a database without 0085 still takes it", () => {
    expect(rowOf(planAgentImports([agent()], []))).not.toHaveProperty("tool_rules");
    expect(rowOf(planAgentImports([agent({ tool_rules: null })], []))).not.toHaveProperty("tool_rules");
  });

  it("refuses rules the sidecar could not read, rather than importing an agent whose tools would all be refused", () => {
    for (const bad of [{ rules: [{ tool: "Bash", effect: "allow" }] }, ["Bash"], { rules: [], extra: 1 }]) {
      expect(planAgentImports([agent({ tool_rules: bad })], [])[0]).toMatchObject({ action: "reject", reason: "tool_rules_malformed" });
    }
  });
});
