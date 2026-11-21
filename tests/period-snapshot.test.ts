// Review 2026-11-21, finding 1: the proxy's "is there a last-enforced limit?" question.
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";

const exists = vi.fn();
vi.mock("@/lib/state/redis", () => ({ redis: () => ({ exists: (...a: unknown[]) => exists(...a) }) }));

import { hasPeriodSnapshot, periodSnapshotKey } from "@/lib/state/period-snapshot";

afterEach(() => exists.mockReset());

it("reads the same key the hold script writes the snapshot under", () => {
  const holds = readFileSync("lib/state/holds.ts", "utf8");
  expect(holds).toContain("pbase: (agid: string) => `pbase:${agid}`");
  expect(periodSnapshotKey("agent-1")).toBe("pbase:agent-1");
});

it("says yes only when the snapshot exists", async () => {
  exists.mockResolvedValueOnce(1);
  expect(await hasPeriodSnapshot("agent-1")).toBe(true);
  expect(exists).toHaveBeenCalledWith("pbase:agent-1");
  exists.mockResolvedValueOnce(0);
  expect(await hasPeriodSnapshot("agent-1")).toBe(false);
});

it("an unreadable answer keeps the fenced hold (yes), never a free pass", async () => {
  exists.mockRejectedValueOnce(new Error("redis down"));
  expect(await hasPeriodSnapshot("agent-1")).toBe(true);
});
