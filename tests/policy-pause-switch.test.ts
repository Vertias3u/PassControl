import { beforeEach, describe, expect, it, vi } from "vitest";

// L7 (1.6.0, 0088): what happens at the pause line is read with the live policy,
// on a rung of its own above 0087's, so a gateway that deploys before 0088 reads
// "pause" (today's behaviour) and loses nothing else.
const { getCachedAgentPolicyMock, setCachedAgentPolicyMock } = vi.hoisted(() => ({
  getCachedAgentPolicyMock: vi.fn(),
  setCachedAgentPolicyMock: vi.fn(),
}));
vi.mock("@vercel/functions", () => ({ waitUntil: (p: unknown) => p }));
vi.mock("@/lib/state/redis", () => ({
  getCachedAgentPolicy: (...a: unknown[]) => getCachedAgentPolicyMock(...a),
  setCachedAgentPolicy: (...a: unknown[]) => setCachedAgentPolicyMock(...a),
  readPolicyFence: async () => null,
}));

import { readCurrentAgentPolicyAndShadow } from "@/lib/state/policy";

const TOP =
  "policy, policy_shadow, sender_constraint_mode, budget_epoch, budget_state_established_at, budget_tokens, budget_cents, budget_period, budget_period_cents, pause_percent, pause_action, pause_switch_provider, pause_switch_model";
const PAUSE_RUNG =
  "policy, policy_shadow, sender_constraint_mode, budget_epoch, budget_state_established_at, budget_tokens, budget_cents, budget_period, budget_period_cents, pause_percent";

function db(rows: (columns: string) => { data: unknown; error: unknown }) {
  const selects: string[] = [];
  let columns = "";
  const b: any = {
    select: (c: string) => {
      columns = c;
      selects.push(c);
      return b;
    },
    eq: () => b,
    maybeSingle: async () => rows(columns),
  };
  return { db: { from: () => b } as any, selects };
}
const missing = (column: string) => ({ data: null, error: { code: "42703", message: `column agents.${column} does not exist` } });
const base = { policy: null, policy_shadow: null, sender_constraint_mode: "off", budget_epoch: null, budget_state_established_at: null, budget_tokens: null, budget_cents: 1000, budget_period: null, budget_period_cents: null, pause_percent: 80 };

beforeEach(() => {
  vi.clearAllMocks();
  getCachedAgentPolicyMock.mockResolvedValue(null);
});

describe("the pause line's switch in the live policy read", () => {
  it("reads a switch on the top rung, and caches it", async () => {
    const { db: client, selects } = db(() => ({
      data: { ...base, pause_action: "switch", pause_switch_provider: "openrouter", pause_switch_model: "anthropic/claude-haiku-4.5" },
      error: null,
    }));
    const read = await readCurrentAgentPolicyAndShadow(client, "u", "a");
    expect(selects).toEqual([TOP]);
    expect(read.pause).toEqual({ known: true, percent: 80, switchTo: { provider: "openrouter", model: "anthropic/claude-haiku-4.5" } });
    const cached = JSON.parse(setCachedAgentPolicyMock.mock.calls[0]![2]);
    expect(cached).toMatchObject({ ppk: true, ppc: 80, pss: ["openrouter", "anthropic/claude-haiku-4.5"] });
  });

  it("reads pause when the row says pause, or half a switch", async () => {
    for (const row of [
      { pause_action: "pause", pause_switch_provider: null, pause_switch_model: null },
      { pause_action: "switch", pause_switch_provider: "openai", pause_switch_model: null },
      { pause_action: "something", pause_switch_provider: "openai", pause_switch_model: "gpt-5-mini" },
    ]) {
      const { db: client } = db(() => ({ data: { ...base, ...row }, error: null }));
      expect((await readCurrentAgentPolicyAndShadow(client, "u", "a")).pause).toEqual({ known: true, percent: 80, switchTo: null });
    }
  });

  it("falls to 0087's rung on a database without 0088, and reads pause", async () => {
    const { db: client, selects } = db((columns) => (columns.includes("pause_action") ? missing("pause_action") : { data: base, error: null }));
    const read = await readCurrentAgentPolicyAndShadow(client, "u", "a");
    expect(selects).toEqual([TOP, PAUSE_RUNG]);
    expect(read.pause).toEqual({ known: true, percent: 80, switchTo: null });
    expect(read.budget).toEqual({ known: true, tokens: null, cents: 1000 });
  });

  it("decodes a cached switch, and reads an entry from before 0088 as pause", async () => {
    getCachedAgentPolicyMock.mockResolvedValueOnce(JSON.stringify({ p: null, s: null, ppk: true, ppc: 70, pss: ["anthropic", "claude-haiku-4-5"] }));
    expect((await readCurrentAgentPolicyAndShadow(db(() => ({ data: null, error: null })).db, "u", "a")).pause).toEqual({
      known: true,
      percent: 70,
      switchTo: { provider: "anthropic", model: "claude-haiku-4-5" },
    });
    getCachedAgentPolicyMock.mockResolvedValueOnce(JSON.stringify({ p: null, s: null, ppk: true, ppc: 70 }));
    expect((await readCurrentAgentPolicyAndShadow(db(() => ({ data: null, error: null })).db, "u", "a")).pause).toEqual({
      known: true,
      percent: 70,
      switchTo: null,
    });
  });
});
