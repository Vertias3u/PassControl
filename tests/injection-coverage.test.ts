// 1.7.1 (external review P6): a block format the gateway has no rule for is said, once an
// hour per agent and format, so the operator sees what the guard cannot read. Never held.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ keys: new Map<string, unknown>(), events: [] as [string, Record<string, unknown>][], down: false }));
vi.mock("@/lib/state/redis", () => ({
  redis: () => ({
    set: async (key: string, value: unknown, options?: { nx?: boolean; ex?: number }) => {
      if (h.down) throw new Error("redis down");
      if (options?.nx && h.keys.has(key)) return null;
      h.keys.set(key, { value, ex: options?.ex });
      return "OK";
    },
  }),
}));
vi.mock("@/lib/observability", () => ({
  captureGuardEvent: async (event: string, ctx: Record<string, unknown>) => void h.events.push([event, ctx]),
}));

import { COVERAGE_NOTE_SECONDS, noteUnknownCoverage } from "@/lib/injection-coverage";

beforeEach(() => {
  h.keys.clear();
  h.events.length = 0;
  h.down = false;
});

describe("noteUnknownCoverage", () => {
  it("says each new format once, per agent, for an hour", async () => {
    await noteUnknownCoverage("agent-a", ["fancy_new_result", "role:critic"]);
    await noteUnknownCoverage("agent-a", ["fancy_new_result"]);
    await noteUnknownCoverage("agent-b", ["fancy_new_result"]);
    expect(h.events).toEqual([
      ["proxy.injection_coverage_unknown", expect.objectContaining({ agentId: "agent-a", code: "types:fancy_new_result,role:critic" })],
      ["proxy.injection_coverage_unknown", expect.objectContaining({ agentId: "agent-b", code: "types:fancy_new_result" })],
    ]);
    expect([...h.keys.values()].every((v) => (v as { ex: number }).ex === COVERAGE_NOTE_SECONDS)).toBe(true);
    expect(COVERAGE_NOTE_SECONDS).toBe(3600);
  });

  it("says nothing, and never throws, when the store cannot be read", async () => {
    h.down = true;
    await expect(noteUnknownCoverage("agent-a", ["fancy_new_result"])).resolves.toBeUndefined();
    expect(h.events).toEqual([]);
  });
});
