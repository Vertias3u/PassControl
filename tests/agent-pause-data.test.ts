import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  replies: [] as { data: Record<string, unknown> | null; error: { code: string } | null }[],
  selects: [] as string[],
  filters: [] as [string, unknown][],
}));
vi.mock("@/lib/budget-pause", async (original) => ({
  ...await original<typeof import("@/lib/budget-pause")>(),
  readPauseView: vi.fn(async () => ({ tokens: { limit: 1000, used: 850, remaining: 150 }, cost: null, period: null })),
}));
vi.mock("@/lib/state/pause", () => ({
  pausePromptOpen: vi.fn(async () => false),
  readPauseLiftEnd: vi.fn(async () => null),
}));
vi.mock("@/lib/alerts/approvals", () => ({ pollTelegramDecisions: vi.fn() }));

import { readAgentPauseState } from "@/app/dashboard/agents/[id]/pause-data";

const row = {
  pause_percent: 80, budget_tokens: 1000, budget_cents: 25,
  budget_period: null, budget_period_cents: null,
  pause_action: "switch", pause_switch_provider: "openai", pause_switch_model: "gpt-5-nano",
};
const chain = {
  select: (columns: string) => { h.selects.push(columns); return chain; },
  eq: (column: string, value: unknown) => { h.filters.push([column, value]); return chain; },
  maybeSingle: async () => h.replies.shift()!,
};
const db = { from: () => chain };
const read = () => readAgentPauseState(db as never, "tenant-a", "agent-a");

beforeEach(() => { h.replies.length = 0; h.selects.length = 0; h.filters.length = 0; });

describe("agent page pause data (UI-01)", () => {
  it("reads the configured switch with the existing tenant-scoped pause read", async () => {
    h.replies.push({ data: row, error: null });
    expect(await read()).toMatchObject({ percent: 80, switchTo: { provider: "openai", model: "gpt-5-nano" } });
    expect(h.selects[0]).toContain("pause_action, pause_switch_provider, pause_switch_model");
    expect(h.filters).toEqual([["user_id", "tenant-a"], ["id", "agent-a"]]);
    expect(h.selects).toHaveLength(1);
  });

  it.each([
    { pause_action: "pause" },
    { pause_switch_model: null },
    { pause_switch_provider: "" },
  ])("does not invent a switch from incomplete or inactive configuration %j", async (patch) => {
    h.replies.push({ data: { ...row, ...patch }, error: null });
    expect(await read()).toMatchObject({ percent: 80, switchTo: null });
  });

  it.each(["42703", "PGRST204"])("preserves the old pause panel without 0088 (%s)", async (code) => {
    h.replies.push({ data: null, error: { code } }, { data: { pause_percent: 80, budget_tokens: 1000 }, error: null });
    expect(await read()).toMatchObject({ percent: 80, switchTo: null });
    expect(h.selects).toHaveLength(2);
    expect(h.selects[1]).not.toContain("pause_action");
    expect(h.filters).toEqual([["user_id", "tenant-a"], ["id", "agent-a"], ["user_id", "tenant-a"], ["id", "agent-a"]]);
  });

  it("does not retry unrelated database errors", async () => {
    h.replies.push({ data: null, error: { code: "08006" } });
    expect(await read()).toBeNull();
    expect(h.selects).toHaveLength(1);
  });

  it("still omits the panel if the database also lacks the pause line", async () => {
    h.replies.push({ data: null, error: { code: "42703" } }, { data: null, error: { code: "42703" } });
    expect(await read()).toBeNull();
  });
});
