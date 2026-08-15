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
//
// The passport sweep added two more query shapes — an update that filters with
// .not()/.lt() and terminates in .select(), and a plain select chain — so the
// builder is now chainable and awaitable. `sweep` lets a test supply what each
// of those two returns, and `sweepQueries` records the filters they applied so
// the sweep's boundaries can be asserted rather than assumed.
function makeDb(
  totals: { agent_id: string; spent_tokens: number; spent_microcents: number }[],
  sweep: { released?: unknown[]; expiring?: unknown[]; closed?: unknown[] } = {}
) {
  const updates: { table: string; values: any; id: string }[] = [];
  const sweepQueries: { kind: string; filters: [string, unknown, unknown?][] }[] = [];
  const rpc = vi.fn(async (_name: string, _args: any) => ({ data: totals, error: null }));

  const from = vi.fn((table: string) => ({
    update: (values: any) => {
      const filters: [string, unknown, unknown?][] = [];
      const chain: any = {
        // The last-seen flush: update().eq() and nothing more, awaited directly.
        eq: async (_col: string, id: string) => {
          updates.push({ table, values, id });
          return { data: null, error: null };
        },
        not: (col: string, op: string, val: unknown) => {
          filters.push([col, op, val]);
          return chain;
        },
        is: (col: string, val: unknown) => {
          filters.push([col, "is", val]);
          return chain;
        },
        lt: (col: string, val: unknown) => {
          filters.push([col, "lt", val]);
          return chain;
        },
        // Two update-then-select shapes now share this builder: releasing
        // retired passport keys on `agents`, and closing lapsed break-glass
        // grants. Keyed by table so a test can assert on either.
        select: async () => {
          const kind = table === "break_glass_grants" ? "grants" : "release";
          sweepQueries.push({ kind, filters });
          const rows = kind === "grants" ? sweep.closed : sweep.released;
          return { data: rows ?? [], error: null };
        },
      };
      return chain;
    },
    select: () => {
      const filters: [string, unknown, unknown?][] = [];
      const chain: any = {
        eq: (col: string, val: unknown) => {
          filters.push([col, "eq", val]);
          return chain;
        },
        not: (col: string, op: string, val: unknown) => {
          filters.push([col, op, val]);
          return chain;
        },
        gt: (col: string, val: unknown) => {
          filters.push([col, "gt", val]);
          return chain;
        },
        lt: (col: string, val: unknown) => {
          filters.push([col, "lt", val]);
          return chain;
        },
        order: () => chain,
        limit: async () => {
          sweepQueries.push({ kind: "expiring", filters });
          return { data: sweep.expiring ?? [], error: null };
        },
      };
      return chain;
    },
  }));
  return { db: { rpc, from } as any, updates, rpc, sweepQueries };
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
    expect(res).toEqual({
      agents: 0,
      lastSeenFlushed: 0,
      // The sweep runs on an empty fleet too, and reports nothing rather than
      // being skipped — a clean run and a run that did not happen must not
      // produce the same output.
      retiredKeysCleared: 0,
      expiringSoon: [],
      grantsClosed: 0,
    });
  });
});

/**
 * The passport sweep is HOUSEKEEPING, and every test here exists to keep it
 * that way.
 *
 * Expiry and the end of a grace window are enforced by lib/auth/passport.ts on
 * every challenge, by comparing timestamps. A cron that has not run — paused
 * scheduler, rotated CRON_SECRET, misconfiguration — must never be the reason
 * an expired passport still works. What the sweep buys is that a retired key
 * stops occupying the unique constraint, and that an operator hears about a
 * passport before it lapses rather than after.
 */
describe("runReconcile — passport sweep", () => {
  const redis = () => makeRedis().r;

  it("releases retired keys whose grace window has closed", async () => {
    const { db, sweepQueries } = makeDb([], { released: [{ id: "a1" }, { id: "a2" }] });
    const res = await runReconcile(db, redis() as any, { lagSeconds: 60 });

    expect(res.retiredKeysCleared).toBe(2);
    const release = sweepQueries.find((q) => q.kind === "release");
    // Only rows that actually rotated, and only once the deadline has passed.
    expect(release?.filters).toContainEqual(["previous_passport_pubkey", "is", null]);
    expect(release?.filters.some(([col, op]) => col === "previous_valid_until" && op === "lt")).toBe(
      true
    );
  });

  it("clears both rotation columns together, never just one", async () => {
    const { db } = makeDb([], { released: [{ id: "a1" }] });
    let cleared: Record<string, unknown> | null = null;
    const original = db.from;
    db.from = (table: string) => {
      const built = original(table);
      const update = built.update;
      built.update = (values: Record<string, unknown>) => {
        if ("previous_passport_pubkey" in values) cleared = values;
        return update(values);
      };
      return built;
    };
    await runReconcile(db, redis() as any, { lagSeconds: 60 });
    // A key released without its deadline — or a deadline without its key —
    // leaves a row the auth path would read as a retired key with no window.
    expect(cleared).toEqual({ previous_passport_pubkey: null, previous_valid_until: null });
  });

  it("reports passports about to lapse without acting on them", async () => {
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const { db, sweepQueries } = makeDb([], {
      expiring: [{ id: "a9", expires_at: expiresAt }],
    });
    const res = await runReconcile(db, redis() as any, { lagSeconds: 60 });

    expect(res.expiringSoon).toEqual([{ agentId: "a9", expiresAt }]);
    const query = sweepQueries.find((q) => q.kind === "expiring");
    // Only active agents, only ones with an expiry, and only ones that have not
    // already lapsed — a passport that expired last week is not "expiring soon",
    // it is expired, and the auth path has been refusing it since.
    expect(query?.filters).toContainEqual(["status", "eq", "active"]);
    expect(query?.filters).toContainEqual(["expires_at", "is", null]);
    expect(query?.filters.some(([col, op]) => col === "expires_at" && op === "gt")).toBe(true);
  });

  /**
   * The property that makes the sweep safe to have at all. Reconcile's first
   * half is the money-critical work and has already been written to Redis by
   * the time the sweep runs; a housekeeping failure must not turn a successful
   * reconcile into a 500 that pages someone about work which actually completed.
   */
  /**
   * Closing a lapsed grant does NOT end an elevation — lib/break-glass.ts
   * already treats it as dead by comparing expires_at in code. What this frees
   * is the one-live-grant-per-agent index slot, whose predicate can only be
   * `revoked_at is null` because Postgres refuses a STABLE function there.
   * Without it, an agent could be elevated once and then never again.
   */
  it("closes out lapsed break-glass grants so the next elevation is possible", async () => {
    const { db, sweepQueries } = makeDb([], { closed: [{ id: "g1" }] });
    const res = await runReconcile(db, redis() as any, { lagSeconds: 60 });

    expect(res.grantsClosed).toBe(1);
    const grants = sweepQueries.find((q) => q.kind === "grants");
    expect(grants?.filters).toContainEqual(["revoked_at", "is", null]);
    // Only lapsed ones. Closing a grant that is still live would end an
    // operator's elevation mid-incident, from a cron they did not run.
    expect(grants?.filters.some(([col, op]) => col === "expires_at" && op === "lt")).toBe(true);
  });

  it("cannot fail the reconcile it runs at the end of", async () => {
    const db = {
      rpc: vi.fn(async () => ({
        data: [{ agent_id: "a1", spent_tokens: 10, spent_microcents: 20 }],
        error: null,
      })),
      from: vi.fn(() => {
        throw new Error("PostgREST is having a day");
      }),
    } as any;
    const r = redis();

    const res = await runReconcile(db, r as any, { lagSeconds: 60 });

    // The spend half completed and is reported; the sweep reports nothing,
    // which is honest — nothing was swept.
    expect(res.agents).toBe(1);
    expect(res.retiredKeysCleared).toBe(0);
    expect(res.expiringSoon).toEqual([]);
    expect(res.grantsClosed).toBe(0);
  });
});
