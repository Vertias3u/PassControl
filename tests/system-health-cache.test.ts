import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  migration: vi.fn(async () => ({ state: "current" })),
  snapshot: vi.fn(async () => ({ format_version: 1 })),
}));

vi.mock("@/lib/system-health/index", () => ({
  getMigrationHealth: mocks.migration,
  getSystemHealthSnapshot: mocks.snapshot,
}));

describe("system-health cache policy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    mocks.migration.mockClear();
    mocks.snapshot.mockClear();
  });

  afterEach(() => vi.useRealTimers());

  it("keeps both isolate-local collectors inside the requested 30–60 second window", async () => {
    const { SYSTEM_HEALTH_CACHE_SECONDS, getCachedMigrationHealth, getCachedSystemHealthSnapshot } =
      await import("@/lib/system-health/cache");
    expect(SYSTEM_HEALTH_CACHE_SECONDS).toBe(45);
    await expect(getCachedMigrationHealth()).resolves.toEqual({ state: "current" });
    await expect(getCachedMigrationHealth()).resolves.toEqual({ state: "current" });
    await expect(getCachedSystemHealthSnapshot()).resolves.toEqual({ format_version: 1 });
    await expect(getCachedSystemHealthSnapshot()).resolves.toEqual({ format_version: 1 });
    expect(mocks.migration).toHaveBeenCalledOnce();
    expect(mocks.snapshot).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(46_000);
    await getCachedMigrationHealth();
    await getCachedSystemHealthSnapshot();
    expect(mocks.migration).toHaveBeenCalledTimes(2);
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent misses without relying on a deployment cache adapter", async () => {
    const { getCachedSystemHealthSnapshot } = await import("@/lib/system-health/cache");
    await Promise.all([getCachedSystemHealthSnapshot(), getCachedSystemHealthSnapshot()]);
    expect(mocks.snapshot).toHaveBeenCalledOnce();
  });
});
