import { describe, it, expect, vi, beforeEach } from "vitest";

// `establishBudgetState` is the other half of openHold's `epochToPersist`, and
// the ONE line that decides which rows it may write. 0057 moved that guard from
// the timestamp to the epoch, because 0057 backfills the timestamp for an agent
// that was already spending: guarded on the timestamp, such an agent matches no
// row, never records the epoch it mints, and stays unfenced on every call.
const chain = vi.hoisted(() => ({
  update: null as Record<string, unknown> | null,
  eq: [] as [string, unknown][],
  is: [] as [string, unknown][],
  table: null as string | null,
  error: null as { code: string; message: string } | null,
}));

vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      chain.table = table;
      const b: any = {
        update: (values: Record<string, unknown>) => {
          chain.update = values;
          return b;
        },
        eq: (column: string, value: unknown) => {
          chain.eq.push([column, value]);
          return b;
        },
        is: (column: string, value: unknown) => {
          chain.is.push([column, value]);
          // supabase-js reports `count: null` unless the caller asked for it,
          // so "how many rows did I change" is NOT available here — which is
          // why matching no row cannot be distinguished from matching one, and
          // must not be treated as a failure.
          return Promise.resolve({ error: chain.error, count: null });
        },
      };
      return b;
    },
  }),
}));

import { establishBudgetState } from "@/lib/state/holds";

describe("establishBudgetState", () => {
  beforeEach(() => {
    chain.update = null;
    chain.eq = [];
    chain.is = [];
    chain.table = null;
    chain.error = null;
  });

  it("rejects a returned database error so the proxy cannot dispatch without a durable generation", async () => {
    // Supabase resolves SQL failures with { error }; it does not have to throw.
    // The proxy awaits this helper and blocks dispatch ONLY when it rejects.
    // If this resolves, a new grant can spend with both DB markers still null;
    // losing Redis then admits another first-init with its spend reset to zero.
    chain.error = { code: "57014", message: "canceling statement due to statement timeout" };
    await expect(establishBudgetState("agent-1", "epoch-1")).rejects.toBeDefined();
  });

  it("treats matching no row as success, because that is the guard working", async () => {
    // An agent that already carries an epoch matches nothing here, and every
    // concurrent first-init but one lands in exactly that state. Rejecting on
    // it would turn the convergence property into a 503 on the losing calls.
    chain.error = null;
    await expect(establishBudgetState("agent-1", "epoch-1")).resolves.toBeUndefined();
  });

  it("claims a row that has no epoch yet, not one that has no timestamp", async () => {
    await establishBudgetState("agent-1", "epoch-1");
    expect(chain.table).toBe("agents");
    expect(chain.eq).toEqual([["id", "agent-1"]]);
    // The whole point: an agent 0057 marked HAS a timestamp and still needs to
    // record its first epoch. Guarding on the timestamp would exclude it.
    expect(chain.is).toEqual([["budget_epoch", null]]);
  });

  it("writes both columns, so the pair 0057 gave a meaning cannot be created here", async () => {
    await establishBudgetState("agent-1", "epoch-1");
    expect(chain.update).toMatchObject({
      budget_epoch: "epoch-1",
      budget_state_established_at: expect.any(String),
    });
  });
});
