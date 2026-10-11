// F1: lib/fleet can create an agent WITH a periodic limit, but only when its
// caller hands one over explicitly as a trusted option. It never derives one
// from the request body and never invents a default, because the control API
// (and so the CLI) calls fleet.createAgent with a caller's raw JSON, and that
// path must create exactly the agent it created before F1.
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/state/redis", () => ({}));
vi.mock("@/lib/state/killswitch", () => ({}));

import { createAgent, createDirectAgent } from "@/lib/fleet";

const DAY_20 = { budget_period: "day" as const, budget_period_cents: 2000 };
const input = {
  name: "bot",
  passportPubkey: randomBytes(32).toString("base64url"),
  scopes: [{ provider: "anthropic", models: ["claude-*"] }],
};

function insertDb() {
  const seen: { insert: Record<string, unknown> | null } = { insert: null };
  const chain: any = {
    insert: (row: Record<string, unknown>) => {
      seen.insert = row;
      return chain;
    },
    select: () => chain,
    single: async () => ({ data: { id: "agent-1", created_at: "2026-10-10T00:00:00Z" }, error: null }),
  };
  return { db: { from: () => chain } as any, seen };
}

function rpcDb() {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: [{ agent_id: "agent-1", key_id: "key-1" }], error: null }));
  return { db: { rpc } as any, rpc };
}

describe("fleet.createAgent", () => {
  it("writes the period limit it is handed", async () => {
    const { db, seen } = insertDb();
    await createAgent(db, "u1", input, { period: DAY_20 });
    expect(seen.insert).toMatchObject(DAY_20);
  });

  it("writes no period of its own when handed none (the control API's call)", async () => {
    const { db, seen } = insertDb();
    await createAgent(db, "u1", input);
    expect(seen.insert).not.toHaveProperty("budget_period");
    expect(seen.insert).not.toHaveProperty("budget_period_cents");
  });

  it("ignores a period in the request body: creation through the API is unchanged", async () => {
    const { db, seen } = insertDb();
    await createAgent(db, "u1", { ...input, budget_period: "day", budget_period_cents: 1 });
    expect(seen.insert).not.toHaveProperty("budget_period");
  });
});

describe("fleet.createDirectAgent", () => {
  const direct = { name: "worker", keyName: "laptop", scopes: input.scopes };

  it("passes the period limit to the one-transaction RPC", async () => {
    const { db, rpc } = rpcDb();
    await createDirectAgent(db, "u1", direct, { period: DAY_20 });
    expect(rpc.mock.calls[0]?.[1]).toMatchObject({ p_budget_period: "day", p_budget_period_cents: 2000 });
  });

  it("sends the pre-0082 argument list when handed no period", async () => {
    const { db, rpc } = rpcDb();
    await createDirectAgent(db, "u1", direct);
    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args).not.toHaveProperty("p_budget_period");
    expect(args).not.toHaveProperty("p_budget_period_cents");
  });

  it("sends no period for an explicit no-limit, so it works before 0082 is applied", async () => {
    const { db, rpc } = rpcDb();
    await createDirectAgent(db, "u1", direct, { period: { budget_period: null, budget_period_cents: null } });
    expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty("p_budget_period");
  });
});
