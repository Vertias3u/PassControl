import { describe, expect, it } from "vitest";
import { UPSTREAM_DEADLINE_ON_VERCEL_MS, upstreamFirstByteDeadlineMs } from "@/lib/providers/upstream-deadline";

// Vercel's Edge runtime must BEGIN a response within 25 s of the request arriving
// (vercel.com/docs/functions/runtimes/edge, "Maximum duration", read 2026-11-21).
// A function cut there never runs its settlement: the budget hold stays open for
// a human to resolve, and no audit row or receipt is written.
describe("upstreamFirstByteDeadlineMs", () => {
  it("defaults under the 25 s edge limit on Vercel", () => {
    expect(upstreamFirstByteDeadlineMs({ VERCEL: "1" })).toBe(UPSTREAM_DEADLINE_ON_VERCEL_MS);
    expect(UPSTREAM_DEADLINE_ON_VERCEL_MS).toBeLessThan(25_000);
    expect(UPSTREAM_DEADLINE_ON_VERCEL_MS).toBeGreaterThanOrEqual(15_000);
  });

  it("sets no deadline off Vercel, where nothing cuts the call", () => {
    expect(upstreamFirstByteDeadlineMs({})).toBeNull();
  });

  it("takes an explicit operator value anywhere", () => {
    expect(upstreamFirstByteDeadlineMs({ UPSTREAM_FIRST_BYTE_DEADLINE_MS: "90000" })).toBe(90_000);
    expect(upstreamFirstByteDeadlineMs({ VERCEL: "1", UPSTREAM_FIRST_BYTE_DEADLINE_MS: "18000" })).toBe(18_000);
  });

  it("never lets an operator value outrun the edge limit on Vercel", () => {
    expect(upstreamFirstByteDeadlineMs({ VERCEL: "1", UPSTREAM_FIRST_BYTE_DEADLINE_MS: "60000" })).toBe(UPSTREAM_DEADLINE_ON_VERCEL_MS);
  });

  it("ignores a value that is not a positive whole number of milliseconds", () => {
    for (const bad of ["", "0", "-5", "1.5", "abc", "12s"]) {
      expect(upstreamFirstByteDeadlineMs({ UPSTREAM_FIRST_BYTE_DEADLINE_MS: bad }), bad).toBeNull();
      expect(upstreamFirstByteDeadlineMs({ VERCEL: "1", UPSTREAM_FIRST_BYTE_DEADLINE_MS: bad }), bad).toBe(UPSTREAM_DEADLINE_ON_VERCEL_MS);
    }
  });
});
