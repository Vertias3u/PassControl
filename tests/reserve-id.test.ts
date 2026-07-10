import { beforeEach, describe, expect, it, vi } from "vitest";

const { store, fakeRedis } = vi.hoisted(() => {
  const values = new Map<string, number>();
  const client = {
    async eval(_script: string, keys: string[], args: string[]) {
      const tokenCap = Number(args[0]);
      const tokenEstimate = Number(args[1]);
      const costCap = Number(args[2]);
      const costEstimate = Number(args[3]);
      const spentTokens = values.get(keys[1]!) ?? 0;
      const spentCost = values.get(keys[4]!) ?? 0;
      const reservedTokens = (values.get(keys[0]!) ?? 0) + tokenEstimate;
      const reservedCost = (values.get(keys[3]!) ?? 0) + costEstimate;
      values.set(keys[0]!, reservedTokens);
      values.set(keys[3]!, reservedCost);
      if (
        (tokenCap >= 0 && reservedTokens + spentTokens > tokenCap) ||
        (costCap >= 0 && reservedCost + spentCost > costCap)
      ) {
        values.set(keys[0]!, reservedTokens - tokenEstimate);
        values.set(keys[3]!, reservedCost - costEstimate);
        return [-1, 0];
      }
      values.set(keys[2]!, tokenEstimate);
      values.set(keys[5]!, costEstimate);
      return [reservedTokens, reservedCost];
    },
    async scan(_cursor: string, opts: { match: string }) {
      const prefix = opts.match.slice(0, -1);
      return ["0", [...values.keys()].filter((key) => key.startsWith(prefix))];
    },
    async mget(...keys: string[]) {
      return keys.map((key) => values.get(key) ?? null);
    },
    async set(key: string, value: number) {
      values.set(key, Number(value));
      return "OK";
    },
    async get(key: string) {
      return values.get(key) ?? null;
    },
  };
  return { store: values, fakeRedis: client };
});

vi.mock("@upstash/redis", () => ({
  Redis: { fromEnv: () => fakeRedis },
}));

import { reserveBudget } from "../lib/state/redis";
import { runReconcile } from "../lib/reconcile";

beforeEach(() => store.clear());

describe("budget reservation request ids", () => {
  it("keeps both live markers for concurrent requests sharing one visa jti", async () => {
    const shared = { agentId: "agent-1", jti: "visa-jti", capTokens: 1_000, markerTtlSeconds: 60 };
    await Promise.all([
      reserveBudget({ ...shared, reserveId: "request-1", estimate: 30 }),
      reserveBudget({ ...shared, reserveId: "request-2", estimate: 40 }),
    ]);

    const db = {
      rpc: vi.fn(async () => ({
        data: [{ agent_id: "agent-1", spent_tokens: 0, spent_microcents: 0 }],
      })),
      from: vi.fn(),
    } as any;
    await runReconcile(db, fakeRedis as any, { lagSeconds: 60 });

    expect(await fakeRedis.get("reserved:agent-1")).toBe(70);
  });
});
