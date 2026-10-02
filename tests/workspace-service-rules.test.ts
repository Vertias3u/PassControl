// An agent's GitHub access (`agents.service_rules`, 0074) travels with the
// workspace: exported with the agent, validated by the gateway's own parser on
// import, and never widened or silently dropped on the way.
import { describe, expect, it } from "vitest";
import { loadWorkspaceExport } from "@/lib/workspace-export";
import { planAgentImports } from "@/lib/workspace-import";

const PUBKEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const RULES = {
  github: { allow: [{ method: "GET", path: "/repos/acme/*/issues" }], max_requests_per_hour: 50 },
};

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

const stored = { id: "a1", created_at: "2026-09-30T00:00:00Z", published: false, public_label: null, ...agent(), budget_period: "day", budget_period_cents: 2500, service_rules: RULES };

describe("exporting an agent's service access", () => {
  it("carries service_rules with the agent", async () => {
    const { client } = db([], stored);
    const out = await loadWorkspaceExport(client, "u1");
    expect(out.workspace.agents[0]).toMatchObject({ service_rules: RULES, budget_period: "day" });
  });

  it("keeps the periodic limit on a database that has 0073 but not 0074", async () => {
    const { client, agentSelects } = db(["service_rules"], stored);
    const out = await loadWorkspaceExport(client, "u1");
    expect(out.workspace.agents[0]).toMatchObject({ budget_period: "day", budget_period_cents: 2500 });
    expect(out.workspace.agents[0]).not.toHaveProperty("service_rules");
    expect(agentSelects).toHaveLength(2);
  });

  it("still exports on a database with neither", async () => {
    const { client } = db(["service_rules", "budget_period"], stored);
    const out = await loadWorkspaceExport(client, "u1");
    expect(out.workspace.agents[0]).toMatchObject({ name: "triage-bot" });
  });
});

describe("importing an agent's service access", () => {
  const rowOf = (plan: ReturnType<typeof planAgentImports>) => (plan[0] as { row: Record<string, unknown> }).row;

  it("restores valid rules as they were", () => {
    const plan = planAgentImports([agent({ service_rules: RULES })], []);
    expect(plan[0]).toMatchObject({ action: "create" });
    expect(rowOf(plan).service_rules).toEqual(RULES);
  });

  it("writes nothing for an older file or an agent with no rules, so a database without 0074 still takes it", () => {
    expect(rowOf(planAgentImports([agent()], []))).not.toHaveProperty("service_rules");
    expect(rowOf(planAgentImports([agent({ service_rules: null })], []))).not.toHaveProperty("service_rules");
  });

  it("refuses rules the gateway would refuse, rather than importing an agent that silently has none", () => {
    // A write with a trailing ** is refused by the gateway (write rules are exact).
    const write = { github: { allow: [{ method: "POST", path: "/repos/acme/web/**" }] } };
    expect(planAgentImports([agent({ service_rules: write })], [])[0]).toMatchObject({
      action: "reject",
      reason: "service_rules_malformed",
    });
    expect(planAgentImports([agent({ service_rules: ["github"] })], [])[0]).toMatchObject({
      action: "reject",
      reason: "service_rules_malformed",
    });
  });

  it("refuses a service this build does not know", () => {
    expect(planAgentImports([agent({ service_rules: { slack: { allow: [] } } })], [])[0]).toMatchObject({
      action: "reject",
      reason: "service_rules_unknown_service",
    });
  });

  it("round-trips: what the export wrote, the import restores", async () => {
    const { client } = db([], stored);
    const exported = (await loadWorkspaceExport(client, "u1")).workspace.agents;
    expect(rowOf(planAgentImports(exported, [])).service_rules).toEqual(RULES);
  });
});

// The ACCOUNT export ("everything held about you") has its own allowlist and
// must not lag: a tenant's GitHub rules and what each GitHub call was are
// theirs. It must also not fail outright on a database without 0074.
describe("the account export", () => {
  function accountDb(missing: string[]) {
    const selects: Record<string, string[]> = {};
    const client = {
      from(table: string) {
        let columns = "";
        const chain: Record<string, unknown> = {
          select: (cols: string) => {
            columns = cols;
            (selects[table] ??= []).push(cols);
            return chain;
          },
          eq: () => chain,
          order: () => chain,
          range: () => chain,
          maybeSingle: async () => ({ data: null, error: null }),
          then: (resolve: (v: unknown) => void) => {
            const absent = missing.find((column) => columns.split(",").includes(column));
            if (absent) return resolve({ data: null, error: { code: "42703" } });
            if (table === "agents") return resolve({ data: [{ id: "a1", service_rules: RULES }], error: null });
            if (table === "agent_logs") {
              return resolve({ data: [{ id: "l1", call_kind: "service", endpoint: "GET /user" }], error: null });
            }
            return resolve({ data: [], error: null, count: 0 });
          },
        };
        return chain;
      },
    };
    return { client: client as never, selects };
  }
  const user = { id: "u1", email: "op@example.test", created_at: "2026-09-01T00:00:00Z" } as never;

  it("carries each agent's service rules and each call's kind and endpoint", async () => {
    const { loadAccountExport } = await import("@/lib/account-lifecycle");
    const { client, selects } = accountDb([]);
    const out = await loadAccountExport(client, user, client);
    expect(selects.agents![0]).toMatch(/\bservice_rules\b/);
    expect(selects.agent_logs![0]).toMatch(/\bcall_kind\b.*\bendpoint\b|\bendpoint\b.*\bcall_kind\b/);
    expect(out.data.agents[0]).toMatchObject({ service_rules: RULES });
    expect(out.data.agentLogs[0]).toMatchObject({ call_kind: "service", endpoint: "GET /user" });
  });

  // An agent's daily or monthly spending limit (0073) is the tenant's own
  // setting; "everything held about you" left it out until 2026-10-02.
  it("carries each agent's periodic spending limit", async () => {
    const { loadAccountExport } = await import("@/lib/account-lifecycle");
    const { client, selects } = accountDb([]);
    await loadAccountExport(client, user, client);
    expect(selects.agents![0]).toMatch(/\bbudget_period\b/);
    expect(selects.agents![0]).toMatch(/\bbudget_period_cents\b/);
  });

  it("steps down one migration at a time: keeps the limit on a database with 0073 but not 0074", async () => {
    const { loadAccountExport } = await import("@/lib/account-lifecycle");
    const { client, selects } = accountDb(["service_rules"]);
    await loadAccountExport(client, user, client);
    expect(selects.agents).toHaveLength(2);
    expect(selects.agents![1]).toMatch(/\bbudget_period_cents\b/);
    expect(selects.agents![1]).not.toMatch(/service_rules/);
  });

  it("still exports on a database with neither 0073 nor 0074", async () => {
    const { loadAccountExport } = await import("@/lib/account-lifecycle");
    const { client, selects } = accountDb(["service_rules", "budget_period"]);
    await expect(loadAccountExport(client, user, client)).resolves.toMatchObject({ data: expect.any(Object) });
    expect(selects.agents!.at(-1)).not.toMatch(/budget_period|service_rules/);
  });

  it("still exports on a database without 0074", async () => {
    const { loadAccountExport } = await import("@/lib/account-lifecycle");
    const { client, selects } = accountDb(["service_rules", "call_kind", "endpoint"]);
    await expect(loadAccountExport(client, user, client)).resolves.toMatchObject({ data: expect.any(Object) });
    expect(selects.agents!.at(-1)).not.toMatch(/service_rules/);
    expect(selects.agent_logs!.at(-1)).not.toMatch(/call_kind|endpoint/);
  });
});
