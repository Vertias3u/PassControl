import { describe, it, expect, vi, beforeEach } from "vitest";

const raiseSpentFloorMock = vi.fn();
const countOpenHoldsMock = vi.fn();
const readReservedMock = vi.fn();

/**
 * The hold module is mocked, NOT re-implemented.
 *
 * `raiseSpentFloor` is a Lua script, and a TypeScript copy of it living in this
 * fake would be a second definition of the one rule that matters — "never lower
 * a spend counter" — free to drift from the real one while this file stayed
 * green. What the script DOES is pinned against real Redis in
 * tests/holds.redis.test.ts; what this file pins is that the cron RAISES rather
 * than SETS, and that it no longer writes reservations at all.
 */
vi.mock("@/lib/state/holds", () => ({
  raiseSpentFloor: (...args: unknown[]) => raiseSpentFloorMock(...args),
  countOpenHolds: (...args: unknown[]) => countOpenHoldsMock(...args),
  readReserved: (...args: unknown[]) => readReservedMock(...args),
}));

import { runReconcile } from "../lib/reconcile";

// Minimal in-memory Redis supporting the subset runReconcile uses:
// scan(match), mget, set, get. scan returns one page (cursor "0").
function makeRedis(
  initial: Record<string, number> = {},
  initialLists: Record<string, string[]> = {}
) {
  const store = new Map<string, number>(Object.entries(initial));
  const lists = new Map<string, string[]>(Object.entries(initialLists));
  const sets: Record<string, number> = {};
  const r = {
    scan: vi.fn(async (_cursor: string, { match }: { match: string; count?: number }) => {
      const prefix = match.replace(/\*$/, "");
      const keys = [...new Set([...store.keys(), ...lists.keys()])].filter((kk) => kk.startsWith(prefix));
      return ["0", keys] as [string, string[]];
    }),
    mget: vi.fn(async (...keys: string[]) => keys.map((kk) => store.get(kk) ?? null)),
    get: vi.fn(async (kk: string) => store.get(kk) ?? null),
    lrange: vi.fn(async (kk: string, start: number, stop: number) =>
      (lists.get(kk) ?? []).slice(start, stop + 1)
    ),
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
    raiseSpentFloorMock.mockReset().mockResolvedValue({ raised: true });
    countOpenHoldsMock.mockReset().mockResolvedValue(0);
    readReservedMock.mockReset().mockResolvedValue({ tokens: 0, microcents: 0 });
  });

  it("calls the incremental RPC with the settle-lag (no per-agent log scan)", async () => {
    const { db, rpc } = makeDb([]);
    await runReconcile(db, redish.r as any, { lagSeconds: 90 });
    expect(rpc).toHaveBeenCalledWith("reconcile_agent_spend", { p_lag_seconds: 90 });
  });

  // THE CLOBBER, REVERSED. This used to assert `set`, and the `sets` recorder
  // below exists because that assertion was written to pin exactly the wrong
  // behaviour: the RPC total is LAGGED, so setting from it erased every
  // settlement made inside the lag window — up to a full day of spend handed
  // back as capacity, once a day, silently.
  it("RAISES spent toward the authoritative total, and never SETS it", async () => {
    const { db } = makeDb([
      { agent_id: "a1", spent_tokens: 1200, spent_microcents: 45_000 },
      { agent_id: "a2", spent_tokens: 0, spent_microcents: 0 },
    ]);
    const res = await runReconcile(db, redish.r as any, { lagSeconds: 60 });

    expect(raiseSpentFloorMock).toHaveBeenCalledWith(
      { agentId: "a1", tokens: 1200, microcents: 45_000 },
      redish.r
    );
    expect(raiseSpentFloorMock).toHaveBeenCalledWith(
      { agentId: "a2", tokens: 0, microcents: 0 },
      redish.r
    );
    // Not one direct write to a spend counter. A `set` here is the bug.
    expect(Object.keys(redish.sets).filter((kk) => kk.startsWith("spent"))).toEqual([]);
    expect(res.agents).toBe(2);
  });

  // Step 12. The old code rebuilt `reserved:` from a SCAN of per-request
  // markers and wrote the sum back — non-atomic across a round trip, so a
  // reservation taken concurrently was simply overwritten. Reservations now move
  // only through the atomic hold transitions, so the cron must not touch them AT
  // ALL. This asserts the absence, because a partial write here is invisible
  // until an agent is refused for money it is not spending.
  it("never writes a reservation counter, and never scans for reserve markers", async () => {
    redish = makeRedis({ "reserve:a1:j1": 50, "reserve:a1:j2": 75, "reserved:a1": 125 });
    const { db } = makeDb([{ agent_id: "a1", spent_tokens: 0, spent_microcents: 0 }]);
    await runReconcile(db, redish.r as any, { lagSeconds: 60 });

    expect(Object.keys(redish.sets).filter((kk) => kk.startsWith("reserved"))).toEqual([]);
    // The counter that was already there is left exactly as it was.
    expect(redish.store.get("reserved:a1")).toBe(125);
    const scanned = redish.r.scan.mock.calls.map(([, o]: any) => o.match);
    expect(scanned.some((m: string) => m.startsWith("reserve"))).toBe(false);
  });

  // Reported, never acted on. A cron that closed open holds would be
  // self-heal-by-expiry with a scheduler attached — the original defect.
  it("reports open holds and reservation drift without correcting either", async () => {
    countOpenHoldsMock.mockResolvedValue(3);
    const { db } = makeDb([{ agent_id: "a1", spent_tokens: 0, spent_microcents: 0 }]);
    const res = await runReconcile(db, redish.r as any, { lagSeconds: 60 });

    expect(res.openHolds).toBe(3);
    // Drift is only meaningful with no holds open; with three open, a non-zero
    // reservation is exactly what should be there.
    expect(res.reservedDrift).toBe(0);
    expect(Object.keys(redish.sets).filter((kk) => kk.startsWith("reserved"))).toEqual([]);
  });

  it("flags a reservation left behind with no hold to justify it", async () => {
    countOpenHoldsMock.mockResolvedValue(0);
    readReservedMock.mockResolvedValue({ tokens: 40, microcents: 0 });
    const { db } = makeDb([{ agent_id: "a1", spent_tokens: 0, spent_microcents: 0 }]);
    const res = await runReconcile(db, redish.r as any, { lagSeconds: 60 });

    expect(res.reservedDrift).toBe(1);
    // Surfaced, not silently repaired: an invariant broke, and overwriting the
    // counter is how the old code hid exactly this.
    expect(Object.keys(redish.sets).filter((kk) => kk.startsWith("reserved"))).toEqual([]);
  });

  // A housekeeping read must never be able to fail the half of the run that
  // moved money — which has already happened by the time it executes.
  it("survives a housekeeping read that throws", async () => {
    countOpenHoldsMock.mockRejectedValue(new Error("redis blip"));
    const { db } = makeDb([{ agent_id: "a1", spent_tokens: 7, spent_microcents: 8 }]);
    const res = await runReconcile(db, redish.r as any, { lagSeconds: 60 });

    expect(res.agents).toBe(1);
    expect(res.openHolds).toBe(0);
    expect(raiseSpentFloorMock).toHaveBeenCalled();
  });

  // The two tests that stood here — "resets reserved to 0 when an agent has no
  // live markers (leak self-heal)" and its cost-dimension twin — are DELETED
  // rather than adapted, because the mechanism they pinned is the defect.
  //
  // Self-heal by marker expiry meant money was released on a timer: a call that
  // had genuinely been billed got its reservation back once its marker aged out,
  // whether or not anyone had settled it. An open hold now never expires, and
  // only an explicit transition or an audited operator rebuild can move a
  // reservation. See tests/holds.redis.test.ts, which asserts `TTL == -1` on an
  // open hold precisely so nobody restores this as hygiene.


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
      passportSourceSignals: [],
      grantsClosed: 0,
      // Zero open holds and zero drift, reported rather than omitted — for the
      // same reason as the sweep counts above. "Nothing is outstanding" and
      // "nobody looked" must not be the same output.
      openHolds: 0,
      reservedDrift: 0,
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

describe("runReconcile — passport source observation summary", () => {
  it("reports the bounded Redis signal without turning it into enforcement", async () => {
    const signal = {
      strength: "strong",
      observedAt: "2026-08-31T10:00:00.000Z",
      countries: ["DE", "US"],
    };
    const redish = makeRedis({}, {
      "passport_source_signals:a9": [JSON.stringify(signal)],
    });
    const { db } = makeDb([]);

    const res = await runReconcile(db, redish.r as any, { lagSeconds: 60 });

    expect(res.passportSourceSignals).toEqual([{ agentId: "a9", ...signal }]);
    expect(res).not.toHaveProperty("agentsSuspended");
  });
});
