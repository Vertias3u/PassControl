import { describe, expect, it } from "vitest";
import {
  buildAgentPassportView,
  requireAgentPassport,
  type AgentPassportRow,
  type PassportLogRow,
} from "@/app/dashboard/agents/[id]/passport-data";
import { createPassportSigil, passportIdForDisplay } from "@/lib/passport-art";

const TENANT_A = "10000000-0000-4000-8000-000000000001";
const TENANT_B = "20000000-0000-4000-8000-000000000002";
const AGENT_A = "a0000000-0000-4000-8000-000000000001";
const AGENT_B = "b0000000-0000-4000-8000-000000000002";
const ABSENT_AGENT = "c0000000-0000-4000-8000-000000000003";
const KEY_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const KEY_B = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";

const agentA: AgentPassportRow & { user_id: string } = {
  id: AGENT_A,
  user_id: TENANT_A,
  name: "Aster Relay",
  passport_pubkey: KEY_A,
  status: "active",
  budget_tokens: 10_000,
  budget_cents: 250,
  spent_tokens: 2_500,
  spent_microcents: 75_000_000,
  allowed_scopes: [
    { provider: "openai", models: ["gpt-4.1*"] },
    { provider: "anthropic", models: ["claude-sonnet-4*"] },
  ],
  policy: {
    deny: [{ provider: "openai", models: ["gpt-4*"] }],
    windows: [
      {
        days: ["mon", "tue", "wed", "thu", "fri"],
        start: "09:00",
        end: "18:00",
        tz: "UTC",
      },
    ],
    max_requests_per_hour: 100,
  },
  created_at: "2026-07-20T08:00:00.000Z",
  last_seen_at: "2026-07-28T10:30:00.000Z",
};

const agentB: AgentPassportRow & { user_id: string } = {
  ...agentA,
  id: AGENT_B,
  user_id: TENANT_B,
  name: "Foreign Custodian",
  passport_pubkey: KEY_B,
};

const logs: Array<PassportLogRow & { user_id: string; agent_id: string }> = [
  {
    id: "log-a-1",
    user_id: TENANT_A,
    agent_id: AGENT_A,
    provider: "openai",
    model: "gpt-4.1-mini",
    status: "ok",
    created_at: "2026-07-21T08:00:00.000Z",
  },
  {
    id: "log-a-2",
    user_id: TENANT_A,
    agent_id: AGENT_A,
    provider: "openai",
    model: "gpt-4.1-mini",
    status: "ok",
    created_at: "2026-07-22T08:00:00.000Z",
  },
  {
    id: "log-a-3",
    user_id: TENANT_A,
    agent_id: AGENT_A,
    provider: "deepseek",
    model: "deepseek-chat",
    status: "blocked_scope",
    created_at: "2026-07-23T08:00:00.000Z",
  },
  {
    id: "log-b-secret",
    user_id: TENANT_B,
    agent_id: AGENT_B,
    provider: "anthropic",
    model: "claude-opus-4-6",
    status: "ok",
    created_at: "2026-07-24T08:00:00.000Z",
  },
];

type Row = Record<string, unknown>;

type RpcMode = "ok" | "missing" | "failing";

function makeRlsDb(viewerId: string, rpcMode: RpcMode = "ok") {
  const calls: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tables: Record<string, Row[]> = {
    agents: [agentA, agentB],
    agent_logs: logs,
  };

  const db = {
    // Stands in for public.agent_provider_stamps. The function is SECURITY
    // INVOKER, so RLS scopes it to the caller — mirrored here by filtering on
    // viewerId before p_user_id is applied, which can only narrow further.
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      if (rpcMode === "missing") {
        return { data: null, error: { code: "PGRST202", message: "function not found" } };
      }
      if (rpcMode === "failing") {
        return { data: null, error: { code: "57014", message: "statement timeout" } };
      }

      const rows = logs.filter(
        (row) =>
          row.user_id === viewerId &&
          row.user_id === args.p_user_id &&
          row.agent_id === args.p_agent_id &&
          row.status === "ok" &&
          row.provider
      );
      const grouped = new Map<string, { first: string; last: string; calls: number }>();
      for (const row of rows) {
        const at = String(row.created_at);
        const current = grouped.get(row.provider!);
        if (!current) {
          grouped.set(row.provider!, { first: at, last: at, calls: 1 });
          continue;
        }
        current.calls += 1;
        if (at < current.first) current.first = at;
        if (at > current.last) current.last = at;
      }
      return {
        data: [...grouped.entries()].map(([provider, value]) => ({
          provider,
          first_seen_at: value.first,
          last_seen_at: value.last,
          recorded_calls: value.calls,
        })),
        error: null,
      };
    },
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let ascending = true;
      let range: [number, number] | null = null;
      calls.push({ table, filters });

      const result = () => {
        let rows = (tables[table] ?? []).filter((row) => row.user_id === viewerId);
        for (const [column, value] of filters) {
          rows = rows.filter((row) => row[column] === value);
        }
        const count = rows.length;
        rows = [...rows].sort((a, b) => {
          const left = String(a.created_at ?? "");
          const right = String(b.created_at ?? "");
          return ascending ? left.localeCompare(right) : right.localeCompare(left);
        });
        if (range) rows = rows.slice(range[0], range[1] + 1);
        return { data: rows, error: null, count };
      };

      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        order: (_column: string, options?: { ascending?: boolean }) => {
          ascending = options?.ascending ?? true;
          return builder;
        },
        range: (from: number, to: number) => {
          range = [from, to];
          return builder;
        },
        limit: (amount: number) => {
          range = [0, Math.max(0, amount - 1)];
          return builder;
        },
        maybeSingle: async () => {
          const rows = result().data;
          return { data: rows[0] ?? null, error: null };
        },
        then: (
          resolve: (value: { data: Row[]; error: null; count: number }) => unknown,
          reject?: (reason: unknown) => unknown
        ) => Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  };

  return { db, calls, rpcCalls };
}

describe("Agent Passport tenant boundary", () => {
  it("returns the identical not-found path for another tenant and an absent passport", async () => {
    const notFoundSignal = new Error("NEXT_NOT_FOUND");
    const notFound = (): never => {
      throw notFoundSignal;
    };
    const foreign = makeRlsDb(TENANT_A);

    await expect(
      requireAgentPassport(foreign.db as never, TENANT_A, AGENT_B, notFound)
    ).rejects.toBe(notFoundSignal);
    expect(foreign.calls.map((call) => call.table)).toEqual(["agents"]);

    const absent = makeRlsDb(TENANT_A);
    await expect(
      requireAgentPassport(absent.db as never, TENANT_A, ABSENT_AGENT, notFound)
    ).rejects.toBe(notFoundSignal);
    expect(absent.calls.map((call) => call.table)).toEqual(["agents"]);
  });

  it("loads only the owned agent and scopes its history by tenant and agent", async () => {
    const { db, calls } = makeRlsDb(TENANT_A);
    const passport = await requireAgentPassport(db as never, TENANT_A, AGENT_A);

    expect(passport.agent.name).toBe("Aster Relay");
    expect(passport.agent.passportId).toBe(KEY_A);
    expect(passport.recentVerdicts.map((entry) => entry.id)).not.toContain("log-b-secret");

    expect(calls[0]?.filters).toContainEqual(["user_id", TENANT_A]);
    expect(calls[0]?.filters).toContainEqual(["id", AGENT_A]);
    for (const call of calls.filter((entry) => entry.table === "agent_logs")) {
      expect(call.filters).toContainEqual(["user_id", TENANT_A]);
      expect(call.filters).toContainEqual(["agent_id", AGENT_A]);
    }
  });
});

// Lifetime stamps used to cost two queries per candidate provider — roughly
// fourteen PostgREST round trips for one page view. They now come from a single
// grouped aggregate (migration 0013), so this pins the round-trip count as well
// as the result.
describe("Agent Passport provider stamps", () => {
  it("aggregates lifetime stamps in one round trip, scoped to tenant and agent", async () => {
    const { db, calls, rpcCalls } = makeRlsDb(TENANT_A);
    const passport = await requireAgentPassport(db as never, TENANT_A, AGENT_A);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.name).toBe("agent_provider_stamps");
    expect(rpcCalls[0]?.args).toEqual({ p_agent_id: AGENT_A, p_user_id: TENANT_A });

    // One agents lookup plus one recent-history query. No per-provider fan-out.
    expect(calls.filter((call) => call.table === "agent_logs")).toHaveLength(1);

    expect(passport.providerStamps).toEqual([
      {
        provider: "openai",
        firstSeenAt: "2026-07-21T08:00:00.000Z",
        lastSeenAt: "2026-07-22T08:00:00.000Z",
        recordedCalls: 2,
      },
    ]);
  });

  it("falls back to recent history when the aggregate function is absent", async () => {
    // A self-hoster who pulls the code before applying migration 0013 gets a
    // working page with stamps derived from recent history, not a broken one.
    const { db, rpcCalls } = makeRlsDb(TENANT_A, "missing");
    const passport = await requireAgentPassport(db as never, TENANT_A, AGENT_A);

    expect(rpcCalls).toHaveLength(1);
    expect(passport.providerStamps.map((stamp) => stamp.provider)).toEqual(["openai"]);
    expect(passport.agent.name).toBe("Aster Relay");
  });

  it("fails closed when the aggregate query itself errors", async () => {
    const { db } = makeRlsDb(TENANT_A, "failing");
    await expect(requireAgentPassport(db as never, TENANT_A, AGENT_A)).rejects.toThrow(
      "Unable to load this agent passport."
    );
  });
});

describe("Agent Passport view model", () => {
  it("surfaces validated policy rules read-only", () => {
    const view = buildAgentPassportView(agentA, []);

    expect(view.policy).toEqual({
      configured: true,
      valid: true,
      deny: [{ provider: "openai", models: ["gpt-4*"] }],
      windows: [
        {
          days: ["mon", "tue", "wed", "thu", "fri"],
          start: "09:00",
          end: "18:00",
          tz: "UTC",
        },
      ],
      maxRequestsPerHour: 100,
    });

    expect(buildAgentPassportView({ ...agentA, policy: null }, []).policy).toMatchObject({
      configured: false,
      valid: true,
    });
    expect(
      buildAgentPassportView({ ...agentA, policy: { max_requests_per_hour: 0 } }, []).policy
    ).toEqual({
      configured: true,
      valid: false,
      deny: [],
      windows: [],
      maxRequestsPerHour: null,
    });
  });

  it("aggregates successful provider entries and preserves every recent verdict", () => {
    const view = buildAgentPassportView(agentA, logs.filter((log) => log.user_id === TENANT_A));

    expect(view.providerStamps).toEqual([
      {
        provider: "openai",
        firstSeenAt: "2026-07-21T08:00:00.000Z",
        lastSeenAt: "2026-07-22T08:00:00.000Z",
        recordedCalls: 2,
      },
    ]);
    expect(view.recentVerdicts.map((entry) => entry.status)).toEqual([
      "blocked_scope",
      "ok",
      "ok",
    ]);
  });

  it("converts micro-cents against a cent cap and treats only null as unlimited", () => {
    const finite = buildAgentPassportView(agentA, []);
    expect(finite.budgets.cost).toMatchObject({
      spentMicrocents: 75_000_000,
      capCents: 250,
      percentUsed: 30,
      unlimited: false,
    });

    const unlimited = buildAgentPassportView(
      { ...agentA, budget_tokens: null, budget_cents: null },
      []
    );
    expect(unlimited.budgets.tokens.unlimited).toBe(true);
    expect(unlimited.budgets.cost.unlimited).toBe(true);

    const zero = buildAgentPassportView(
      { ...agentA, budget_tokens: 0, budget_cents: 0 },
      []
    );
    expect(zero.budgets.tokens.percentUsed).toBe(100);
    expect(zero.budgets.cost.percentUsed).toBe(100);
  });

  it("keeps lifetime stamp totals while bounding the recent verdict payload", () => {
    const manyLogs = Array.from({ length: 60 }, (_, index): PassportLogRow => ({
      id: `log-${index.toString().padStart(2, "0")}`,
      provider: "openai",
      model: "gpt-4.1-mini",
      status: "ok",
      created_at: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString(),
    }));

    const view = buildAgentPassportView(agentA, manyLogs);

    expect(view.providerStamps[0]?.recordedCalls).toBe(60);
    expect(view.recentVerdicts).toHaveLength(50);
    expect(view.recentVerdicts[0]?.id).toBe("log-59");
  });
});

describe("passport sigil and redaction", () => {
  it("is deterministic, bounded, and visibly key-dependent", () => {
    const first = createPassportSigil(KEY_A);
    expect(createPassportSigil(KEY_A)).toEqual(first);
    expect(createPassportSigil(KEY_B)).not.toEqual(first);
    expect(first.cells.length).toBeGreaterThan(10);
    for (const cell of first.cells) {
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.x).toBeLessThan(7);
      expect(cell.y).toBeGreaterThanOrEqual(0);
      expect(cell.y).toBeLessThan(7);
    }
  });

  it("redacts by default and reveals the public ID only after explicit opt-in", () => {
    expect(passportIdForDisplay(KEY_A)).toBe("AAAAAAAA…");
    expect(passportIdForDisplay(KEY_A, true)).toBe(KEY_A);
  });
});
