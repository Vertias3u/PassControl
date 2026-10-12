// Subscription mode, Phase 2: the dashboard's one tool-rules mutation.
//
// It changes what an agent may do on the owner's machine, so it sits behind MFA
// step-up like every credential and access mutation, and it validates with the SAME
// parser the sidecar and the gateway use (cli/tool-rules.mjs): the editor is not the
// boundary, but it must never write rules that would then deny every tool.
import { beforeEach, describe, expect, it, vi } from "vitest";

const AGENT = "11111111-1111-4111-8111-111111111111";
const TENANT = "tenant-a";

const h = vi.hoisted(() => ({
  gate: vi.fn(),
  audit: vi.fn(),
  revalidate: vi.fn(),
  updates: [] as { values: Record<string, unknown>; filters: [string, unknown][] }[],
  updateError: { value: null as unknown },
  updatedRows: { value: [{ id: "11111111-1111-4111-8111-111111111111" }] as unknown[] },
}));

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => h.revalidate(...a) }));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => ({}) }));
vi.mock("@/lib/mfa", () => ({ mfaAuthorizedUser: (...a: unknown[]) => h.gate(...a) }));
vi.mock("@/lib/audit", () => ({ recordAdminAction: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const filters: [string, unknown][] = [];
      let values: Record<string, unknown> | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (v: Record<string, unknown>) => ((values = v), chain),
        eq: (column: string, value: unknown) => (filters.push([column, value]), chain),
        then: (resolve: (v: unknown) => void) => {
          if (values) h.updates.push({ values, filters: [...filters] });
          resolve(h.updateError.value ? { data: null, error: h.updateError.value } : { data: h.updatedRows.value, error: null });
        },
      };
      return chain;
    },
  }),
}));

import { setAgentToolRules } from "@/app/dashboard/tool-rules-actions";

beforeEach(() => {
  vi.clearAllMocks();
  h.updates.length = 0;
  h.updateError.value = null;
  h.updatedRows.value = [{ id: AGENT }];
  h.gate.mockResolvedValue({ ok: true, user: { id: TENANT } });
});

const rules = [
  { tool: "Bash", command: "git push*", effect: "ask_owner" },
  { tool: "Bash", command: "rm -rf *", effect: "deny" },
  { tool: "WebFetch", domain: "*.example.com", effect: "ask" },
  { tool: "mcp__github__*", effect: "ask_owner" },
];

describe("setAgentToolRules", () => {
  it("stores the rules in the shape the sidecar reads, for the acting tenant's agent only", async () => {
    const result = await setAgentToolRules(AGENT, { rules, approvalWaitS: 180 });
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(h.updates).toEqual([
      { values: { tool_rules: { rules, approval_wait_s: 180 } }, filters: [["id", AGENT], ["user_id", TENANT]] },
    ]);
    expect(h.revalidate).toHaveBeenCalledWith(`/dashboard/agents/${AGENT}`);
  });

  it("leaves out the wait when it is the default, and empties the column when there are no rules", async () => {
    await setAgentToolRules(AGENT, { rules: rules.slice(0, 1), approvalWaitS: null });
    expect(h.updates[0]!.values).toEqual({ tool_rules: { rules: rules.slice(0, 1) } });
    await setAgentToolRules(AGENT, { rules: [], approvalWaitS: null });
    expect(h.updates[1]!.values).toEqual({ tool_rules: null });
  });

  it("drops an empty condition instead of storing one", async () => {
    await setAgentToolRules(AGENT, { rules: [{ tool: "Bash", command: "  ", effect: "deny" }], approvalWaitS: null });
    expect(h.updates[0]!.values).toEqual({ tool_rules: { rules: [{ tool: "Bash", effect: "deny" }] } });
  });

  it("refuses, with the reason, rules the sidecar could not read: and writes nothing", async () => {
    for (const bad of [
      [{ tool: "Bash", effect: "allow" }],
      [{ tool: "Bash", path: "/etc/*", effect: "deny" }],
      [{ tool: "Read", path: "relative/path", effect: "deny" }],
      [{ tool: "WebFetch", domain: "https://example.com", effect: "deny" }],
      [{ tool: "rm -rf", effect: "deny" }],
    ]) {
      const result = await setAgentToolRules(AGENT, { rules: bad as never, approvalWaitS: null });
      expect(result.error, JSON.stringify(bad)).toMatch(/rule 1/i);
    }
    expect((await setAgentToolRules(AGENT, { rules, approvalWaitS: 5 })).error).toMatch(/10 and 540/);
    expect(h.updates).toEqual([]);
  });

  it("needs MFA step-up before anything is written", async () => {
    h.gate.mockResolvedValue({ ok: false, reason: "step_up_required" });
    expect((await setAgentToolRules(AGENT, { rules, approvalWaitS: null })).error).toMatch(/two-factor/);
    expect(h.updates).toEqual([]);
  });

  it("refuses an id that is not an agent's, and says so when no row of this tenant matched", async () => {
    expect((await setAgentToolRules("not-a-uuid", { rules, approvalWaitS: null })).error).toMatch(/could not be found/);
    h.updatedRows.value = [];
    expect((await setAgentToolRules(AGENT, { rules, approvalWaitS: null })).error).toMatch(/could not be found/);
  });

  it("says plainly when the database predates 0085, and never echoes the database's words", async () => {
    h.updateError.value = { code: "42703", message: 'column "tool_rules" does not exist' };
    expect((await setAgentToolRules(AGENT, { rules, approvalWaitS: null })).error).toMatch(/0085/);
    h.updateError.value = { code: "XX000", message: "internal detail git push" };
    const result = await setAgentToolRules(AGENT, { rules, approvalWaitS: null });
    expect(result.error).toBe("Something went wrong. Please try again.");
  });

  it("audits counts by effect, never the commands, paths or domains", async () => {
    await setAgentToolRules(AGENT, { rules, approvalWaitS: 180 });
    expect(h.audit).toHaveBeenCalledWith({
      userId: TENANT,
      action: "agent.tool_rules",
      targetType: "agent",
      targetId: AGENT,
      metadata: { rules: 4, deny: 1, ask: 1, ask_owner: 2, approval_wait_s: 180 },
    });
    expect(JSON.stringify(h.audit.mock.calls)).not.toMatch(/git push|example\.com|mcp__/);
  });
});
