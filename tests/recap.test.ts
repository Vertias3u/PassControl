import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  spend: [] as { agentId: string; at: string; microcents: number }[],
  queries: [] as { table: string; filters: [string, string, unknown][]; range: number[] }[],
  verified: new Set<string>(),
  fail: "",
  rpc: vi.fn(),
  client: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => h.client() }));

import { buildWeeklyRecap, readWeeklyRecap, weeklyRecapPeriod } from "@/lib/recap";

const AT = new Date("2026-10-22T12:00:00Z");
const START = "2026-10-12T00:00:00.000Z";
const END = "2026-10-19T00:00:00.000Z";
const PREVIOUS = "2026-10-05T00:00:00.000Z";
const agent = (id = "a1", name = "Scout", user_id = "tenant-a") => ({ id, name, user_id });
const log = (id: string, status = "ok", overrides = {}) => ({
  id, agent_id: "a1", user_id: "tenant-a", created_at: "2026-10-13T12:00:00Z",
  status, provider: "openai", model: "gpt-5-mini", ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.queries.length = 0;
  h.verified.clear();
  h.fail = "";
  h.tables = { agents: [agent()], agent_logs: [] };
  h.spend = [];
  h.rpc.mockImplementation(async (name: string, args: { p_agent_id: string; p_since: string }) => {
    expect(name).toBe("agent_period_spend");
    // An RPC is allowed only for IDs returned by a tenant-filtered agents read.
    expect(h.verified.has(args.p_agent_id)).toBe(true);
    if (h.fail === "rpc") return { data: null, error: { message: "failed" } };
    if (h.fail === "malformed-rpc") return { data: [{}], error: null };
    const spent_microcents = h.spend.filter((s) => s.agentId === args.p_agent_id && s.at >= args.p_since)
      .reduce((n, s) => n + s.microcents, 0);
    return { data: [{ spent_microcents: String(spent_microcents), spent_tokens: 0 }], error: null };
  });
  h.client.mockImplementation(() => ({
    rpc: h.rpc,
    from: (table: string) => {
      const query = { table, filters: [] as [string, string, unknown][], range: [0, 499] as [number, number] };
      h.queries.push(query);
      const chain = {
        select: () => chain,
        eq: (c: string, v: unknown) => (query.filters.push(["eq", c, v]), chain),
        gte: (c: string, v: unknown) => (query.filters.push(["gte", c, v]), chain),
        lt: (c: string, v: unknown) => (query.filters.push(["lt", c, v]), chain),
        order: () => chain,
        range: (from: number, to: number) => (query.range = [from, to], chain),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
          const tenant = query.filters.find(([op, c]) => op === "eq" && c === "user_id")?.[2];
          // No filter, no rows: a test cannot accidentally pass with an unscoped read.
          const data = (h.tables[table] ?? []).filter((row) => row.user_id === tenant)
            .filter((row) => query.filters.every(([op, c, v]) => op === "eq" ? row[c] === v : op === "gte" ? String(row[c]) >= String(v) : String(row[c]) < String(v)))
            .slice(query.range[0], query.range[1] + 1);
          if (table === "agents") for (const row of data) h.verified.add(String(row.id));
          return Promise.resolve({ data, error: h.fail === table ? { message: "failed" } : null }).then(resolve, reject);
        },
      };
      return chain;
    },
  }));
});

describe("weekly UTC boundaries", () => {
  it.each([
    ["2026-10-18T23:59:59.999Z", "2026-10-05T00:00:00.000Z", START],
    [END, START, END],
    ["2026-10-18T20:00:00-04:00", START, END],
    ["2027-01-04T00:00:00Z", "2026-12-28T00:00:00.000Z", "2027-01-04T00:00:00.000Z"],
  ])("uses the last completed week at %s", (at, start, end) => {
    expect(weeklyRecapPeriod(new Date(at))).toMatchObject({ start, end });
  });
});

describe("readWeeklyRecap", () => {
  it("returns one empty-week line even when there was spending the week before", async () => {
    h.spend = [{ agentId: "a1", at: "2026-10-06T00:00:00.000Z", microcents: 500_000_000 }];
    const recap = await readWeeklyRecap("tenant-a", AT);
    expect(recap.state).toBe("empty");
    expect(recap.text).toMatch(/no.*activity.*UTC/i);
    expect(recap.text?.split("\n")).toHaveLength(1);
    if (recap.state !== "unavailable") expect(recap.agents).toEqual([]);
  });

  it("uses ledger spend including adjustments, compares weeks and keeps new-week spend out", async () => {
    h.spend = [
      { agentId: "a1", at: PREVIOUS, microcents: 200_000_000 },
      { agentId: "a1", at: START, microcents: 350_000_000 },
      { agentId: "a1", at: END, microcents: 900_000_000 },
    ];
    h.tables.agent_logs = [log("one"), log("two", "blocked_budget_pause"), log("three", "blocked_scope")];
    const recap = await readWeeklyRecap("tenant-a", AT);
    expect(recap.state).toBe("ready");
    if (recap.state === "unavailable") throw new Error("unavailable");
    expect(recap.period).toEqual({ start: START, end: END, previousStart: PREVIOUS });
    expect(recap.totals).toMatchObject({ spentMicrocents: 350_000_000, previousSpentMicrocents: 200_000_000, refusedCalls: 1, pausedCalls: 1 });
    expect(recap.agents[0]).toMatchObject({ id: "a1", name: "Scout", spentMicrocents: 350_000_000, previousSpentMicrocents: 200_000_000 });
    expect(recap.text).toContain("$3.50");
    expect(recap.text).toContain("$2.00");
    expect(h.rpc.mock.calls.map(([, args]) => args.p_since).sort()).toEqual([PREVIOUS, START, END, END].sort());
  });

  it("scopes every table query and never runs spend RPCs for another tenant's agents", async () => {
    h.tables.agents!.push(agent("private", "SECRET", "tenant-b"));
    h.tables.agent_logs = [log("own", "blocked_scope"), log("other", "blocked_scope", { user_id: "tenant-b", agent_id: "private" })];
    const own = await readWeeklyRecap("tenant-a", AT);
    expect(own.state).toBe("ready");
    if (own.state === "unavailable") throw new Error("unavailable");
    expect(own.totals.refusedCalls).toBe(1);
    expect(own.text).not.toContain("SECRET");
    expect(h.rpc.mock.calls.every(([, args]) => args.p_agent_id === "a1")).toBe(true);
    expect(h.queries.length).toBeGreaterThanOrEqual(2);
    for (const query of h.queries) expect(query.filters).toContainEqual(["eq", "user_id", "tenant-a"]);
    h.rpc.mockClear();
    h.tables.agents = [agent()];
    h.tables.agent_logs = [log("own")];
    const other = await readWeeklyRecap("tenant-b", AT);
    expect(other.state).toBe("empty");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("counts all blocked statuses as refusals, except pauses which are counted separately", async () => {
    h.tables.agent_logs = ["blocked_budget", "blocked_scope", "blocked_budget_pause", "blocked_suspended", "upstream_error", "ok"]
      .map((status, i) => log(String(i), status));
    const recap = await readWeeklyRecap("tenant-a", AT);
    if (recap.state === "unavailable") throw new Error("unavailable");
    expect(recap.totals).toMatchObject({ refusedCalls: 3, pausedCalls: 1 });
  });

  it("uses half-open boundaries for log counts and ranks three top models by admitted calls", async () => {
    h.tables.agent_logs = [
      log("before", "blocked_scope", { created_at: "2026-10-11T23:59:59.999Z" }),
      log("start", "blocked_scope", { created_at: START }),
      log("end", "blocked_scope", { created_at: END }),
      ...["z", "b", "a", "d", "a", "z", "z"].map((model, i) => log(String(i), "ok", { model })),
      log("refused-model", "blocked_scope", { model: "must-not-be-top" }),
      log("unconfirmed", "usage_unknown", { model: "a" }),
    ];
    const recap = await readWeeklyRecap("tenant-a", AT);
    if (recap.state === "unavailable") throw new Error("unavailable");
    expect(recap.totals.refusedCalls).toBe(2);
    expect(recap.agents[0]?.topModels).toEqual([
      { provider: "openai", model: "a", calls: 3 },
      { provider: "openai", model: "z", calls: 3 },
      { provider: "openai", model: "b", calls: 1 },
    ]);
  });

  it("shows the biggest spenders first, ten agents and an exact remainder; totals include everyone", async () => {
    h.tables.agents = Array.from({ length: 12 }, (_, i) => agent(`a${i}`, `Agent ${i}`));
    h.spend = h.tables.agents.map((a, i) => ({ agentId: String(a.id), at: START, microcents: (i + 1) * 100_000_000 }));
    const recap = await readWeeklyRecap("tenant-a", AT);
    if (recap.state === "unavailable") throw new Error("unavailable");
    expect(recap.agents).toHaveLength(10);
    expect(recap.agents[0]?.id).toBe("a11");
    expect(recap.moreAgents).toBe(2);
    expect(recap.totals.spentMicrocents).toBe(7_800_000_000);
    expect(recap.text?.split("\n")).toHaveLength(12);
    expect(recap.text).toContain("and 2 more");
  });

  it("paginates the fleet and call metadata without dropping tenant filters or truncating counts", async () => {
    h.tables.agents = Array.from({ length: 501 }, (_, i) => agent(`a${i}`));
    h.tables.agent_logs = Array.from({ length: 501 }, (_, i) => log(String(i), "blocked_scope", { agent_id: "a500" }));
    const recap = await readWeeklyRecap("tenant-a", AT);
    if (recap.state === "unavailable") throw new Error("unavailable");
    expect(recap.totals.refusedCalls).toBe(501);
    expect(recap.agents[0]?.id).toBe("a500");
    for (const table of ["agents", "agent_logs"]) {
      expect(h.queries.filter((q) => q.table === table)).toHaveLength(2);
    }
    for (const query of h.queries) expect(query.filters).toContainEqual(["eq", "user_id", "tenant-a"]);
  });

  it("keeps names and model IDs inert and each agent on one plain-text line", async () => {
    h.tables.agents = [agent("a1", "@everyone `Scout`\n<@123>")];
    h.tables.agent_logs = [log("one", "ok", { model: "@here`bad\nmodel" })];
    const recap = await readWeeklyRecap("tenant-a", AT);
    expect(recap.text).not.toMatch(/[@`<>]/);
    expect(recap.text?.split("\n")).toHaveLength(2);
    expect(recap.text).toContain("Scout");
  });

  it.each(["agents", "agent_logs", "rpc", "malformed-rpc"])("returns unavailable rather than a partial or zero recap after a %s failure", async (failure) => {
    h.fail = failure;
    const recap = await readWeeklyRecap("tenant-a", AT);
    expect(recap.state).toBe("unavailable");
    expect(recap.text).toBeNull();
  });

  it("does not attribute newly arriving current-week spend to the closed week", async () => {
    const original = h.rpc.getMockImplementation()!;
    let tailReads = 0;
    h.rpc.mockImplementation(async (name, args) => {
      const result = await original(name, args);
      if (args.p_since === END && ++tailReads === 1) {
        h.spend.push({ agentId: "a1", at: END, microcents: 100_000_000 });
      }
      return result;
    });
    expect((await readWeeklyRecap("tenant-a", AT)).state).toBe("unavailable");
  });

  it("does not silently omit a call whose agent ownership could not be resolved", async () => {
    h.tables.agent_logs = [log("unresolved", "blocked_scope", { agent_id: "not-in-owned-fleet" })];
    expect((await readWeeklyRecap("tenant-a", AT)).state).toBe("unavailable");
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("handles missing service configuration inside its failure boundary", async () => {
    h.client.mockImplementation(() => { throw new Error("service not configured"); });
    expect((await readWeeklyRecap("tenant-a", AT)).state).toBe("unavailable");
  });
});

describe("recap text from the shared numbers", () => {
  const period = { start: START, end: END, previousStart: PREVIOUS };
  const row = (id: string, spentMicrocents = 100_000_000) => ({
    id, name: `Agent ${id}`, spentMicrocents, previousSpentMicrocents: 200_000_000,
    calls: 1, refusedCalls: 0, pausedCalls: 0,
    topModels: [{ provider: "openai", model: "gpt-5-mini", calls: 1 }],
  });

  it("formats one line per agent in spend order, with a ten-agent cap and full totals", () => {
    const recap = buildWeeklyRecap(period, Array.from({ length: 12 }, (_, i) => row(String(i), (i + 1) * 100_000_000)));
    if (recap.state === "unavailable") throw new Error("unavailable");
    expect(recap.agents).toHaveLength(10);
    expect(recap.agents[0]?.id).toBe("11");
    expect(recap.totals.spentMicrocents).toBe(7_800_000_000);
    expect(recap.text.split("\n")).toHaveLength(12);
    expect(recap.text).toContain("and 2 more");
  });

  it("never turns a quiet week into a table of previous-week zeros", () => {
    const recap = buildWeeklyRecap(period, [{ ...row("quiet", 0), calls: 0, topModels: [] }]);
    expect(recap.state).toBe("empty");
    expect(recap.text?.split("\n")).toHaveLength(1);
    expect(recap.text).toMatch(/No activity.*UTC/);
  });

  it("imports the shared name sanitizer and leaves no mention or code syntax in the text", () => {
    const recap = buildWeeklyRecap(period, [{ ...row("one"), name: "@everyone `Scout`\n<@123>", topModels: [{ provider: "openai", model: "@here`bad\nmodel", calls: 1 }] }]);
    expect(recap.text).not.toMatch(/[@`<>]/);
    expect(recap.text?.split("\n")).toHaveLength(2);
    expect(recap.text).toContain("Scout");
  });
});
