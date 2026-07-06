import { describe, it, expect, vi, beforeEach } from "vitest";
import { runReconcile } from "../lib/reconcile";

// Minimal in-memory Redis supporting the subset runReconcile uses:
// scan(match), mget, set, get. scan returns one page (cursor "0").
function makeRedis(initial: Record<string, number> = {}) {
  const store = new Map<string, number>(Object.entries(initial));
  const sets: Record<string, number> = {};
  const r = {
    scan: vi.fn(async (_cursor: string, { match }: { match: string; count?: number }) => {
      const prefix = match.replace(/\*$/, "");
      const keys = [...store.keys()].filter((kk) => kk.startsWith(prefix));
      return ["0", keys] as [string, string[]];
    }),
    mget: vi.fn(async (...keys: string[]) => keys.map((kk) => store.get(kk) ?? null)),
    get: vi.fn(async (kk: string) => store.get(kk) ?? null),
    set: vi.fn(async (kk: string, v: number) => {
      store.set(kk, v);
      sets[kk] = v;
      return "OK";
    }),
  };
  return { r, sets, store };
}

// Supabase double: rpc() returns the incremental totals; from().update().eq()
// records last-seen flushes.
function makeDb(totals: { agent_id: string; spent_tokens: number; spent_microcents: number }[]) {
  const updates: { table: string; values: any; id: string }[] = [];
  const rpc = vi.fn(async (_name: string, _args: any) => ({ data: totals, error: null }));
  const from = vi.fn((table: string) => ({
    update: (values: any) => ({
      eq: async (_col: string, id: string) => {
        updates.push({ table, values, id });
        return { data: null, error: null };
      },
    }),
  }));
  return { db: { rpc, from } as any, updates, rpc };
}

describe("runReconcile — incremental, checkpoint-backed spend reconciliation", () => {
  let redish: ReturnType<typeof makeRedis>;
  beforeEach(() => {
    redish = makeRedis();
  });

  it("calls the incremental RPC with the settle-lag (no per-agent log scan)", async () => {
    const { db, rpc } = makeDb([]);
    await runReconcile(db, redish.r as any, { lagSeconds: 90 });
    expect(rpc).toHaveBeenCalledWith("reconcile_agent_spend", { p_lag_seconds: 90 });
  });

  it("sets spent:<agid> to the authoritative total returned by the RPC", async () => {
    const { db } = makeDb([
      { agent_id: "a1", spent_tokens: 1200, spent_microcents: 45_000 },
      { agent_id: "a2", spent_tokens: 0, spent_microcents: 0 },
    ]);
    const res = await runReconcile(db, redish.r as any, { lagSeconds: 60 });
    expect(redish.sets["spent:a1"]).toBe(1200);
    expect(redish.sets["spent_cost:a1"]).toBe(45_000);
    expect(redish.sets["spent:a2"]).toBe(0);
    expect(redish.sets["spent_cost:a2"]).toBe(0);
    expect(res.agents).toBe(2);
  });

  it("resets reserved:<agid> to the sum of still-live per-jti markers", async () => {
    redish = makeRedis({ "reserve:a1:j1": 50, "reserve:a1:j2": 75, "reserve:a2:j9": 10 });
    const { db } = makeDb([{ agent_id: "a1", spent_tokens: 0, spent_microcents: 0 }]);
    await runReconcile(db, redish.r as any, { lagSeconds: 60 });
    // a1 has two live markers => reserved = 125; a2 was not returned, untouched.
    expect(redish.sets["reserved:a1"]).toBe(125);
    expect(redish.sets["reserved:a2"]).toBeUndefined();
  });

  it("resets reserved to 0 when an agent has no live markers (leak self-heal)", async () => {
    const { db } = makeDb([{ agent_id: "a1", spent_tokens: 500, spent_microcents: 2_500 }]);
    await runReconcile(db, redish.r as any, { lagSeconds: 60 });
    expect(redish.sets["reserved:a1"]).toBe(0);
    expect(redish.sets["reserved_cost:a1"]).toBe(0);
  });

  it("resets reserved_cost:<agid> to the sum of still-live cost markers", async () => {
    redish = makeRedis({
      "reserve:a1:j1": 50,
      "reserve_cost:a1:j1": 500,
      "reserve:a1:j2": 75,
      "reserve_cost:a1:j2": 900,
      "reserve_cost:a2:j9": 10,
    });
    const { db } = makeDb([{ agent_id: "a1", spent_tokens: 0, spent_microcents: 0 }]);
    await runReconcile(db, redish.r as any, { lagSeconds: 60 });
    expect(redish.sets["reserved:a1"]).toBe(125);
    expect(redish.sets["reserved_cost:a1"]).toBe(1_400);
    expect(redish.sets["reserved_cost:a2"]).toBeUndefined();
  });

  it("flushes coalesced lastseen:<agid> into agents.last_seen_at", async () => {
    const ms = 1_700_000_000_000;
    redish = makeRedis({ "lastseen:a1": ms });
    const { db, updates } = makeDb([]);
    const res = await runReconcile(db, redish.r as any, { lagSeconds: 60 });
    expect(res.lastSeenFlushed).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ table: "agents", id: "a1" });
    expect(updates[0]!.values.last_seen_at).toBe(new Date(ms).toISOString());
  });

  it("handles an empty fleet without error", async () => {
    const { db } = makeDb([]);
    const res = await runReconcile(db, redish.r as any, { lagSeconds: 60 });
    expect(res).toEqual({ agents: 0, lastSeenFlushed: 0 });
  });
});
