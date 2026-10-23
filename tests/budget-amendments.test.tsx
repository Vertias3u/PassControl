import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditInput, AuditRecord } from "@/lib/audit";

const h = vi.hoisted(() => ({
  row: {} as Record<string, unknown>,
  audits: [] as AuditRecord[],
  queries: [] as { columns: string; filters: [string, unknown][]; patch: Record<string, unknown> | null }[],
  readError: false, writeError: false, missingSwitch: false,
  purge: vi.fn(async () => true),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/state/redis", () => ({ purgeAgentPolicy: h.purge }));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => ({
  auth: { getUser: async () => ({ data: { user: { id: "tenant-a" } } }) },
  from: (table: string) => {
    expect(table).toBe("agents");
    let columns = "";
    let patch: Record<string, unknown> | null = null;
    const filters: [string, unknown][] = [];
    const chain = {
      select: (value: string) => (columns = value, chain),
      update: (value: Record<string, unknown>) => (patch = value, chain),
      eq: (key: string, value: unknown) => (filters.push([key, value]), chain),
      maybeSingle: async () => {
        h.queries.push({ columns, filters, patch });
        if (h.missingSwitch && (columns.includes("pause_action") || (patch && "pause_action" in patch))) {
          return { data: null, error: { code: "PGRST204" } };
        }
        if (patch ? h.writeError : h.readError) return { data: null, error: { code: "XX000" } };
        if (!filters.some(([key, value]) => key === "user_id" && value === "tenant-a") ||
            !filters.some(([key, value]) => key === "id" && value === h.row.id)) return { data: null, error: null };
        if (patch) Object.assign(h.row, patch);
        return { data: Object.fromEntries(columns.split(",").map((key) => key.trim()).filter((key) => key in h.row).map((key) => [key, h.row[key]])), error: null };
      },
    };
    return chain;
  },
}) }));
vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return { ...actual, recordAdminAction: async (input: AuditInput) => { h.audits.push(actual.buildAuditRecord(input)); } };
});

import { updateAgentBudgets } from "@/app/dashboard/actions";
import { toCapabilityHistory } from "@/lib/audit-history";
import { CapabilityHistory } from "@/components/CapabilityHistory";

const base = { budget_tokens: null, budget_cents: 2000 };
const off = { ...base, pause_percent: null, pause_action: "pause", pause_switch_provider: null, pause_switch_model: null };
const switched = { ...base, pause_percent: 90, pause_action: "switch", pause_switch_provider: "anthropic", pause_switch_model: "claude-haiku-4-5" };
const history = () => toCapabilityHistory(h.audits.map((row, index) => ({ ...row, id: `audit-${index}`, created_at: `2026-10-23T00:0${index}:00Z` })));

beforeEach(() => {
  vi.clearAllMocks();
  h.audits.length = h.queries.length = 0;
  h.readError = h.writeError = h.missingSwitch = false;
  h.row = { id: "agent-a", user_id: "tenant-a", ...off, allowed_scopes: [{ provider: "anthropic", models: ["claude-*"] }] };
});

describe("budget Amendments from real saves", () => {
  it("records before/after for a 90% cheaper-model switch, then clearing only its line", async () => {
    expect(await updateAgentBudgets("agent-a", { ...base, pause_percent: 90, pause_switch: { provider: "anthropic", model: "claude-haiku-4-5" } })).toEqual({ ok: true, value: undefined });
    expect(await updateAgentBudgets("agent-a", { ...base, pause_percent: null })).toEqual({ ok: true, value: undefined });
    expect(h.audits).toHaveLength(2);
    expect(h.audits.map(({ metadata }) => ({ from: metadata.from, to: metadata.to }))).toEqual([
      { from: JSON.stringify(off), to: JSON.stringify(switched) },
      { from: JSON.stringify(switched), to: JSON.stringify(off) },
    ]);
    expect(h.audits[1]!.metadata.fields).toContain("pause_switch_model");
    const changes = history();
    expect(changes.every((change) => change.recorded)).toBe(true);
    const html = renderToStaticMarkup(<CapabilityHistory history={changes} />);
    expect(html).toContain("not set → 90%");
    expect(html).toContain("90% → not set");
    expect(html).toContain("none → claude-haiku-4-5");
    expect(html).toContain("claude-haiku-4-5 → none");
    expect(html).not.toMatch(/predates|not recorded|data-state="unrecorded"/);
    expect(h.row).toMatchObject(off);
    expect(h.purge).toHaveBeenCalledTimes(2);
    for (const query of h.queries) {
      expect(query.filters).toContainEqual(["user_id", "tenant-a"]);
      expect(query.filters).toContainEqual(["id", "agent-a"]);
      expect(query.columns).not.toContain("*");
    }
    expect(JSON.stringify(h.audits)).not.toContain("allowed_scopes");
  });

  it("records switching back to pause without clearing the percentage", async () => {
    Object.assign(h.row, switched);
    expect((await updateAgentBudgets("agent-a", { ...base, pause_switch: null })).ok).toBe(true);
    expect(h.audits[0]!.metadata.from).toBe(JSON.stringify({ ...base, pause_action: "switch", pause_switch_provider: "anthropic", pause_switch_model: "claude-haiku-4-5" }));
    expect(h.audits[0]!.metadata.to).toBe(JSON.stringify({ ...base, pause_action: "pause", pause_switch_provider: null, pause_switch_model: null }));
    expect(history()[0]!.recorded).toBe(true);
    expect(h.row.pause_percent).toBe(90);
  });

  it("does not claim an earlier value when the snapshot lookup fails, but still saves", async () => {
    h.readError = true;
    expect((await updateAgentBudgets("agent-a", { ...base, pause_percent: 75 })).ok).toBe(true);
    expect(h.audits[0]!.metadata.from).toBeUndefined();
    expect(h.audits[0]!.metadata.to).toBe(JSON.stringify({ ...base, pause_percent: 75 }));
    const html = renderToStaticMarkup(<CapabilityHistory history={history()} />);
    expect(html).toMatch(/earlier value was not recorded/i);
    expect(html).not.toContain("predates");
    expect(h.row.pause_percent).toBe(75);
  });

  it("keeps pre-0088 clear saves working without claiming switch columns were saved", async () => {
    h.missingSwitch = true;
    for (const key of ["pause_action", "pause_switch_provider", "pause_switch_model"]) delete h.row[key];
    expect((await updateAgentBudgets("agent-a", { ...base, pause_percent: null })).ok).toBe(true);
    expect(h.audits[0]!.metadata.to).toBe(JSON.stringify({ ...base, pause_percent: null }));
    expect(h.audits[0]!.metadata.fields).not.toContain("pause_action");
    expect(h.row).not.toHaveProperty("pause_action");
  });

  it("records cap and periodic changes in their existing units, omitting unchanged values", async () => {
    Object.assign(h.row, { budget_period: null, budget_period_cents: null });
    const input = { budget_tokens: 1000, budget_cents: 2500, budget_period: "day" as const, budget_period_cents: 125 };
    expect((await updateAgentBudgets("agent-a", input)).ok).toBe(true);
    const html = renderToStaticMarkup(<CapabilityHistory history={history()} />);
    expect(html).toContain("Token cap: no cap → 1,000");
    expect(html).toContain("Cost cap: $20.00 → $25.00");
    expect(html).toContain("Limit period: none → day");
    expect(html).toContain("Periodic cost cap: no cap → $1.25");
    expect((await updateAgentBudgets("agent-a", input)).ok).toBe(true);
    expect(history().find((change) => change.id === "audit-1")).toMatchObject({
      recorded: true, summary: "Budget saved with no effective change.", detail: [],
    });
    expect(h.row.pause_percent).toBeNull();
  });

  it("retains a recorded save and the existing warning when the cache purge fails", async () => {
    h.purge.mockResolvedValueOnce(false);
    expect((await updateAgentBudgets("agent-a", { ...base, pause_percent: 75 })).ok).toBe(true);
    expect(h.audits[0]!.metadata.budgets_live).toBe(false);
    expect(history()[0]!.recorded).toBe(true);
    expect(h.row.pause_percent).toBe(75);
  });

  it("writes no amendment when the save fails or the agent belongs to another workspace", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.writeError = true;
    expect((await updateAgentBudgets("agent-a", { ...base, pause_percent: 75 })).ok).toBe(false);
    h.writeError = false;
    h.row.id = "another-agent";
    expect((await updateAgentBudgets("agent-a", { ...base, pause_percent: 75 })).ok).toBe(false);
    expect(h.audits).toEqual([]);
    expect(h.purge).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("historical budget Amendments", () => {
  const render = (metadata: Record<string, unknown>) => renderToStaticMarkup(<CapabilityHistory history={toCapabilityHistory([{ id: "old", action: "agent.update", metadata }])} />);

  it("says an older row has no recorded earlier value, without dating its writer", () => {
    const html = render({ fields: "budget_tokens,budget_cents,pause_percent" });
    expect(html).toMatch(/earlier value was not recorded/i);
    expect(html).toContain('data-state="unrecorded"');
    expect(html).not.toContain("predates");
  });

  it.each(["{broken", JSON.stringify({ pause_percent: "ninety" }), { omitted: "too_large", chars: 40_000 }])("keeps a damaged budget snapshot distinct from a missing one (%j)", (from) => {
    const html = render({ fields: "pause_percent", from, to: JSON.stringify({ pause_percent: 90 }) });
    expect(html).toContain('data-state="damaged"');
    expect(html).toContain("cannot be read");
    expect(html).not.toContain("predates");
  });
});
