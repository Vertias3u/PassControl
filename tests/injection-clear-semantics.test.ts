// Clear removes the hold, not the findings: the table remembers a block even when
// Redis forgets it. Exercise the real record, taint and Clear steps without a stack.
import { beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ values: new Map<string, unknown>(), seenDown: false }));
vi.mock("@/lib/state/redis", () => ({
  redis: () => ({
    get: async (key: string) => cache.values.get(key) ?? null,
    set: async (key: string, value: unknown, options?: { nx?: boolean; ex?: number }) => {
      // Only seen claims fail here; taint Redis remains writable to isolate dedup failure.
      if (cache.seenDown && key.startsWith("injection_seen:")) throw new Error("seen Redis down");
      if (options?.nx && cache.values.has(key)) return null;
      cache.values.set(key, value);
      return "OK";
    },
    del: async (key: string) => Number(cache.values.delete(key)),
  }),
}));

import { recordInjectionFindings, redisSeenStore, seenKey, type FindingsDb } from "@/lib/injection-findings";
import type { InjectionFinding } from "@/lib/injection-guard";
import { clearTaint, readTaint, taintFromFindings, taintKey } from "@/lib/state/taint";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const T0 = Date.UTC(2026, 9, 30, 12);
const LATER = T0 + 60_000;
const high = (n: number): InjectionFinding => ({
  path: "messages[3].content[0].content",
  source: "tool_result",
  families: ["instruction_override"],
  severity: "high",
  contentHmac: n.toString(16).padStart(64, "0"),
});

// PostgREST ignoreDuplicates returns only inserted rows, keyed by all four columns.
function fakeTable(error: { code: string; message: string } | null = null) {
  const rows = new Set<string>();
  const upsert = vi.fn((batch: unknown[], options: { onConflict: string; ignoreDuplicates: boolean }) => ({
    select: async (columns: string) => {
      expect(options).toEqual({ onConflict: "user_id,agent_id,content_hmac,detector", ignoreDuplicates: true });
      expect(columns).toBe("content_hmac");
      if (error) return { data: null, error };
      const inserted = (batch as Record<string, unknown>[]).filter((row) => {
        const key = JSON.stringify([row.user_id, row.agent_id, row.content_hmac, row.detector]);
        if (rows.has(key)) return false;
        rows.add(key);
        return true;
      });
      return { data: inserted.map((row) => ({ content_hmac: row.content_hmac })), error: null };
    },
  }));
  const db: FindingsDb = {
    from: (table) => {
      expect(table).toBe("injection_findings");
      return { upsert };
    },
    rpc: async () => ({ error: null }),
  };
  return { db, rows, upsert };
}

async function scan(table: ReturnType<typeof fakeTable>, finding: InjectionFinding, mode: "monitor" | "hold" = "hold", now = T0) {
  const outcome = await recordInjectionFindings({
    db: table.db, seen: redisSeenStore(), userId: USER, agentId: AGENT,
    provider: "anthropic", model: "claude-test", findings: [finding],
  });
  const taint = await taintFromFindings({ agentId: AGENT, mode, outcome, surface: "proxy", now });
  return { outcome, taint };
}

async function recordAndClear(table: ReturnType<typeof fakeTable>) {
  const first = await scan(table, high(1));
  expect(first.outcome.state).toBe("recorded");
  expect(first.taint).toMatchObject({ since: T0, until: T0 + 30 * 60_000 });
  expect(await readTaint(AGENT, T0)).toEqual(first.taint);
  expect(await clearTaint(AGENT)).toBe(true);
  expect(await readTaint(AGENT, T0)).toBeNull();
  expect(cache.values.has(seenKey(AGENT, high(1).contentHmac))).toBe(true);
  expect(table.rows.size).toBe(1);
}

beforeEach(() => {
  cache.values.clear();
  cache.seenDown = false;
});

describe("the injection guard's Clear semantics", () => {
  // A remembered block cannot undo Clear, because replay is not a new finding.
  it("does not re-taint on the exact same block after Clear", async () => {
    const table = fakeTable();
    await recordAndClear(table);
    expect(await scan(table, high(1), "hold", LATER)).toEqual({ outcome: { state: "nothing_new" }, taint: null });
    expect(table.upsert).toHaveBeenCalledTimes(1);
    expect(await readTaint(AGENT, LATER)).toBeNull();
  });

  // Redis is only an optimisation: the table's unique key must preserve Clear when it fails or forgets.
  it.each(["throws", "forgets"] as const)("does not re-taint when the seen store %s after Clear", async (fault) => {
    const table = fakeTable();
    await recordAndClear(table);
    if (fault === "throws") cache.seenDown = true;
    else cache.values.delete(seenKey(AGENT, high(1).contentHmac));
    expect(await scan(table, high(1), "hold", LATER)).toEqual({ outcome: { state: "nothing_new" }, taint: null });
    expect(table.upsert).toHaveBeenCalledTimes(2);
    expect(table.rows.size).toBe(1);
    expect(await readTaint(AGENT, LATER)).toBeNull();
  });

  // Unrecorded highs still hold during a DB fault; retrying one can therefore undo Clear until storage recovers.
  it.each([
    { state: "failed", error: { code: "XX000", message: "database down" } },
    { state: "unavailable", error: { code: "42P01", message: "table missing" } },
  ] as const)("taints and can re-taint after Clear when recording is $state", async ({ state, error }) => {
    const table = fakeTable(error);
    for (const now of [T0, LATER]) {
      const result = await scan(table, high(1), "hold", now);
      expect(result.outcome).toEqual({ state, unrecorded: [high(1)] });
      expect(result.taint).toMatchObject({ since: now, until: now + 30 * 60_000 });
      expect(await readTaint(AGENT, now)).toEqual(result.taint);
      expect(table.rows.size).toBe(0);
      expect(cache.values.has(seenKey(AGENT, high(1).contentHmac))).toBe(false);
      expect(await clearTaint(AGENT)).toBe(true);
      expect(await readTaint(AGENT, now)).toBeNull();
    }
    expect(table.upsert).toHaveBeenCalledTimes(2);
  });

  // Clear is not immunity to the same tell in a different block: a different HMAC is new.
  it("taints after Clear for a different block with the same tell", async () => {
    const table = fakeTable();
    await recordAndClear(table);
    const result = await scan(table, high(2), "hold", LATER);
    expect(result.outcome).toEqual({ state: "recorded", recorded: [high(2)] });
    expect(result.taint).toMatchObject({ since: LATER, until: LATER + 30 * 60_000, families: high(1).families });
    expect(await readTaint(AGENT, LATER)).toEqual(result.taint);
    expect(table.rows.size).toBe(2);
  });

  // Low findings never hold, and monitor never holds even for highs or unrecorded findings.
  it.each(["hold", "monitor"] as const)("respects severity and mode in %s mode even during DB faults", async (mode) => {
    for (const error of [null, { code: "XX000", message: "database down" }, { code: "42P01", message: "table missing" }]) {
      for (const severity of ["low", "high"] as const) {
        if (mode === "hold" && severity === "high") continue;
        cache.values.clear();
        const result = await scan(fakeTable(error), { ...high(1), severity }, mode);
        expect(result.outcome.state).toBe(error === null ? "recorded" : error.code === "42P01" ? "unavailable" : "failed");
        expect(result.taint).toBeNull();
        expect(await readTaint(AGENT, T0)).toBeNull();
        expect(cache.values.has(taintKey(AGENT))).toBe(false);
      }
    }
  });
});
