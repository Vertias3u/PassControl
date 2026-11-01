// 1.7.1 (external review P1): tool output the guard could not fully check. It is stored
// as its own kind of finding (severity `incomplete`, no families, a `gap`; migration 0091),
// taints in hold mode like a strong finding, de-duplicates like one, and gives the hold
// its own reason. A database before 0091 refuses the row; the hold still applies.
import { beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock("@/lib/state/redis", () => ({
  redis: () => ({
    get: async (key: string) => cache.values.get(key) ?? null,
    set: async (key: string, value: unknown, options?: { nx?: boolean }) => {
      if (options?.nx && cache.values.has(key)) return null;
      cache.values.set(key, value);
      return "OK";
    },
    del: async (key: string) => Number(cache.values.delete(key)),
  }),
}));

import { POLICY_UNREADABLE } from "@/lib/gate";
import { recordInjectionFindings, redisSeenStore, sidecarFinding, type FindingsDb } from "@/lib/injection-findings";
import type { InjectionFinding } from "@/lib/injection-guard";
import { HELD_INCOMPLETE, HELD_TAINTED, injectionHoldReason } from "@/lib/injection-hold";
import { INJECTION_DETECTOR, INJECTION_NORMALIZATION } from "@/cli/injection-scan.mjs";
import { clearTaint, readTaint, taintFromFindings, taintKey } from "@/lib/state/taint";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const T0 = Date.UTC(2026, 9, 31, 12);
const HOLD = { injection_guard: { mode: "hold" } };

const gap = (n = 1, kind: InjectionFinding["gap"] = "too_many_blocks"): InjectionFinding => ({
  path: "body",
  source: "request",
  families: [],
  severity: "incomplete",
  gap: kind,
  contentHmac: n.toString(16).padStart(64, "a"),
});
const high = (n = 9): InjectionFinding => ({
  path: "messages[1].content",
  source: "tool",
  families: ["instruction_override"],
  severity: "high",
  contentHmac: n.toString(16).padStart(64, "0"),
});

/** The unique key, and what a database before 0091 says to a gap row. */
function table({ before0091 = false } = {}) {
  const keys = new Set<string>();
  const written: Record<string, unknown>[] = [];
  const db: FindingsDb = {
    from: () => ({
      upsert: (rows: unknown[]) => ({
        select: async () => {
          const batch = rows as Record<string, unknown>[];
          if (before0091 && batch.some((r) => "gap" in r)) return { data: null, error: { code: "PGRST204", message: "Could not find the 'gap' column" } };
          const inserted = batch.filter((r) => {
            const key = `${r.user_id}|${r.agent_id}|${r.content_hmac}|${r.detector}`;
            if (keys.has(key)) return false;
            keys.add(key);
            written.push(r);
            return true;
          });
          return { data: inserted.map((r) => ({ content_hmac: r.content_hmac })), error: null };
        },
      }),
    }),
    rpc: async () => ({ error: null }),
  };
  return { db, written };
}

async function see(t: ReturnType<typeof table>, findings: InjectionFinding[], mode: "monitor" | "hold" = "hold", now = T0) {
  const outcome = await recordInjectionFindings({ db: t.db, seen: redisSeenStore(), userId: USER, agentId: AGENT, provider: "anthropic", model: "m", findings });
  return { outcome, taint: await taintFromFindings({ agentId: AGENT, mode, outcome, surface: "proxy", now }) };
}

beforeEach(() => cache.values.clear());

describe("a gap is stored as its own kind of finding", () => {
  it("severity incomplete, no families, its gap; a tell's row never names the column", async () => {
    const t = table();
    await see(t, [gap(), high()]);
    expect(t.written[0]).toMatchObject({ severity: "incomplete", families: [], gap: "too_many_blocks", path: "body", source: "request" });
    // So a database at 0089 or 0090 still takes every tell.
    expect(t.written[1]).not.toHaveProperty("gap");
  });
});

describe("hold mode", () => {
  it("a new gap taints, with no families, marked incomplete", async () => {
    const { taint } = await see(table(), [gap()]);
    expect(taint).toMatchObject({ families: [], incomplete: true, until: T0 + 30 * 60_000 });
    expect(await readTaint(AGENT, T0)).toEqual(taint);
  });

  it("monitor mode records it and never taints", async () => {
    const t = table();
    expect((await see(t, [gap()], "monitor")).taint).toBeNull();
    expect(t.written).toHaveLength(1);
  });

  it("a replayed gap does not re-taint after Clear (reviewer criterion 9)", async () => {
    const t = table();
    await see(t, [gap()]);
    await clearTaint(AGENT);
    cache.values.clear(); // Redis forgets the claim too: the table still remembers.
    expect(await see(t, [gap()], "hold", T0 + 60_000)).toEqual({ outcome: { state: "nothing_new" }, taint: null });
  });

  it("a database before 0091 refuses the row, and the hold still applies", async () => {
    const { outcome, taint } = await see(table({ before0091: true }), [gap()]);
    expect(outcome.state).toBe("unavailable");
    expect(taint).toMatchObject({ incomplete: true });
  });

  it("a later strong finding adds its families to an incomplete taint", async () => {
    const t = table();
    await see(t, [gap()]);
    const { taint } = await see(t, [high()], "hold", T0 + 1_000);
    expect(taint).toMatchObject({ since: T0, families: ["instruction_override"], incomplete: true });
  });

  it("a 1.7.0 taint value (no incomplete field) still reads", async () => {
    cache.values.set(taintKey(AGENT), JSON.stringify({ since: T0, until: T0 + 60_000, families: ["role_markup"], surface: "proxy" }));
    expect(await readTaint(AGENT, T0)).toEqual({ since: T0, until: T0 + 60_000, families: ["role_markup"], surface: "proxy" });
  });
});

describe("the owner-facing reason", () => {
  it("says the output could not be fully checked when that is the only reason", async () => {
    await see(table(), [gap()]);
    expect(await injectionHoldReason(HOLD, AGENT, T0)).toBe(HELD_INCOMPLETE);
    expect(await injectionHoldReason(POLICY_UNREADABLE, AGENT, T0)).toBe(HELD_INCOMPLETE);
    expect(HELD_INCOMPLETE).toMatch(/could not fully check/);
  });

  it("says a tell was read once there is one", async () => {
    const t = table();
    await see(t, [gap()]);
    await see(t, [high()], "hold", T0 + 1);
    expect(await injectionHoldReason(HOLD, AGENT, T0 + 2)).toBe(HELD_TAINTED);
  });
});

describe("the sidecar's report of a gap", () => {
  const event = (over: Record<string, unknown> = {}) => ({
    kind: "injection_incomplete",
    at: T0,
    source: "tool_result",
    path: "tool_calls[0].tool_response",
    tool: "Read",
    gap: "too_large",
    detector: INJECTION_DETECTOR,
    normalization_version: INJECTION_NORMALIZATION,
    block_sha256: "b".repeat(64),
    ...over,
  });

  it("becomes an incomplete finding with the tool's name and an HMAC, never the hash", () => {
    const finding = sidecarFinding(event(), USER);
    expect(finding).toMatchObject({ severity: "incomplete", gap: "too_large", families: [], toolName: "Read", path: "tool_calls[0].tool_response" });
    expect(finding!.contentHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(finding!.contentHmac).not.toBe("b".repeat(64));
    expect(sidecarFinding(event({ gap: "scan_failed" }), USER)).toMatchObject({ gap: "scan_failed" });
  });

  it.each([
    ["a gap only the gateway can see", { gap: "too_many_blocks" }],
    ["an unknown gap", { gap: "lazy" }],
    ["families on a gap", { families: ["role_markup"] }],
    ["another detector", { detector: "pc-heuristic-0" }],
    ["no hash", { block_sha256: undefined }],
  ])("refuses %s", (_name, over) => {
    expect(sidecarFinding(event(over), USER)).toBeNull();
  });
});
