import { beforeEach, describe, expect, it, vi } from "vitest";

const { pipeline, redisMock } = vi.hoisted(() => {
  const commands: string[] = [];
  const pipeline = {
    get: vi.fn((key: string) => {
      commands.push(key);
      return pipeline;
    }),
    incr: vi.fn((key: string) => {
      commands.push(key);
      return pipeline;
    }),
    exec: vi.fn(async () => [1, 1]),
  };
  const evalQuota = vi.fn(async (_script: string, _keys: string[], _args: string[]) => [0, 1, 1]);
  return { pipeline, redisMock: { pipeline: () => pipeline, eval: evalQuota }, commands };
});

vi.mock("@/lib/state/redis", () => ({ redis: () => redisMock }));

import { consumeCloudBetaQuota, readCloudBetaQuotaSnapshot } from "@/lib/cloud-beta-quota";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CLOUD_BETA_WORKSPACE_CALL_LIMIT;
  delete process.env.CLOUD_BETA_GLOBAL_CALL_LIMIT;
});

describe("Cloud beta quota", () => {
  it("is disabled for self-hosters unless limits are explicitly configured", async () => {
    await expect(consumeCloudBetaQuota("user-1", new Date("2026-08-09T00:00:00Z"))).resolves.toEqual({
      ok: true,
      disabled: true,
    });
    expect(pipeline.exec).not.toHaveBeenCalled();
  });

  it("uses one atomic quota-only operation without touching the budget-reservation Lua", async () => {
    process.env.CLOUD_BETA_WORKSPACE_CALL_LIMIT = "10000";
    process.env.CLOUD_BETA_GLOBAL_CALL_LIMIT = "50000";
    redisMock.eval.mockResolvedValueOnce([0, 12, 40]);

    await expect(
      consumeCloudBetaQuota("user-1", new Date("2026-08-09T00:00:00Z"))
    ).resolves.toEqual({ ok: true, workspaceCount: 12, globalCount: 40 });
    expect(redisMock.eval).toHaveBeenCalledWith(
      expect.any(String),
      ["cloud-beta:2026-08:workspace:user-1", "cloud-beta:2026-08:global"],
      ["10000", "50000"]
    );
    expect(pipeline.incr).not.toHaveBeenCalled();
  });

  it("refuses when either configured cap is exceeded", async () => {
    process.env.CLOUD_BETA_WORKSPACE_CALL_LIMIT = "10";
    process.env.CLOUD_BETA_GLOBAL_CALL_LIMIT = "50";
    redisMock.eval.mockResolvedValueOnce([-1, 11, 0]);
    await expect(consumeCloudBetaQuota("user-1")).resolves.toMatchObject({
      ok: false,
      reason: "workspace",
    });

    redisMock.eval.mockResolvedValueOnce([-2, 3, 51]);
    await expect(consumeCloudBetaQuota("user-1")).resolves.toMatchObject({
      ok: false,
      reason: "global",
    });
  });

  it("fails closed when Redis cannot answer the infrastructure gate", async () => {
    process.env.CLOUD_BETA_WORKSPACE_CALL_LIMIT = "10";
    redisMock.eval.mockRejectedValueOnce(new Error("redis unavailable"));
    await expect(consumeCloudBetaQuota("user-1")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("returns before the global INCR when this workspace is already over cap", async () => {
    process.env.CLOUD_BETA_WORKSPACE_CALL_LIMIT = "10";
    process.env.CLOUD_BETA_GLOBAL_CALL_LIMIT = "50";
    redisMock.eval.mockResolvedValueOnce([-1, 11, 0]);

    await expect(consumeCloudBetaQuota("attacker")).resolves.toEqual({
      ok: false,
      reason: "workspace",
    });

    const script = String(redisMock.eval.mock.calls[0]?.[0] ?? "").replace(/\s+/g, " ");
    expect(script).toMatch(
      /workspaceCount = redis\.call\('INCR', KEYS\[1\]\).*if workspaceLimit >= 0 and workspaceCount > workspaceLimit then return \{-1, workspaceCount, 0\} end.*globalCount = redis\.call\('INCR', KEYS\[2\]\)/
    );
  });

  it("rolls back both admitted counters when the shared global cap refuses the call", async () => {
    process.env.CLOUD_BETA_WORKSPACE_CALL_LIMIT = "10";
    process.env.CLOUD_BETA_GLOBAL_CALL_LIMIT = "50";
    redisMock.eval.mockResolvedValueOnce([-2, 3, 50]);

    await expect(consumeCloudBetaQuota("user-1")).resolves.toEqual({
      ok: false,
      reason: "global",
    });

    const script = String(redisMock.eval.mock.calls[0]?.[0] ?? "").replace(/\s+/g, " ");
    expect(script).toMatch(
      /globalCount = redis\.call\('INCR', KEYS\[2\]\).*if globalCount > globalLimit then.*workspaceCount = redis\.call\('DECR', KEYS\[1\]\).*globalCount = redis\.call\('DECR', KEYS\[2\]\).*return \{-2, workspaceCount, globalCount\}/
    );
  });

  it("preserves deployments that configure only one of the two beta caps", async () => {
    process.env.CLOUD_BETA_WORKSPACE_CALL_LIMIT = "10";
    redisMock.eval.mockResolvedValueOnce([0, 4, 0]);
    await expect(consumeCloudBetaQuota("workspace-only")).resolves.toEqual({
      ok: true,
      workspaceCount: 4,
      globalCount: 0,
    });
    expect(redisMock.eval.mock.calls[0]?.[2]).toEqual(["10", "-1"]);

    delete process.env.CLOUD_BETA_WORKSPACE_CALL_LIMIT;
    process.env.CLOUD_BETA_GLOBAL_CALL_LIMIT = "50";
    redisMock.eval.mockResolvedValueOnce([0, 0, 4]);
    await expect(consumeCloudBetaQuota("global-only")).resolves.toEqual({
      ok: true,
      workspaceCount: 0,
      globalCount: 4,
    });
    expect(redisMock.eval.mock.calls[1]?.[2]).toEqual(["-1", "50"]);
  });

  it("fails closed on a malformed quota-script reply", async () => {
    process.env.CLOUD_BETA_WORKSPACE_CALL_LIMIT = "10";
    redisMock.eval.mockResolvedValueOnce("unexpected" as never);
    await expect(consumeCloudBetaQuota("user-1")).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("does not coerce malformed array replies into an allow", async () => {
    process.env.CLOUD_BETA_WORKSPACE_CALL_LIMIT = "10";
    for (const raw of [
      [null, null, null],
      ["", "", ""],
    ]) {
      redisMock.eval.mockResolvedValueOnce(raw as never);
      await expect(consumeCloudBetaQuota("user-1")).resolves.toEqual({
        ok: false,
        reason: "unavailable",
      });
    }
  });

  it("reads the workspace allowance without consuming it or exposing the global count", async () => {
    process.env.CLOUD_BETA_WORKSPACE_CALL_LIMIT = "100";
    process.env.CLOUD_BETA_GLOBAL_CALL_LIMIT = "1000";
    pipeline.exec.mockResolvedValueOnce([37, 805]);

    await expect(
      readCloudBetaQuotaSnapshot("user-1", new Date("2026-08-09T00:00:00Z"))
    ).resolves.toEqual({
      state: "available",
      resetAt: "2026-09-01T00:00:00.000Z",
      workspace: { used: 37, limit: 100, remaining: 63, utilization: 0.37 },
      globalCapacity: "near-limit",
    });
    expect(pipeline.get).toHaveBeenCalledWith("cloud-beta:2026-08:workspace:user-1");
    expect(pipeline.get).toHaveBeenCalledWith("cloud-beta:2026-08:global");
    expect(pipeline.incr).not.toHaveBeenCalled();
    expect(pipeline.exec).toHaveBeenCalledOnce();
  });

  it("reports an honest disabled state when Cloud caps are not configured", async () => {
    await expect(
      readCloudBetaQuotaSnapshot("user-1", new Date("2026-12-31T23:59:00Z"))
    ).resolves.toEqual({
      state: "disabled",
      resetAt: "2027-01-01T00:00:00.000Z",
      workspace: { used: null, limit: null, remaining: null, utilization: null },
      globalCapacity: "not-configured",
    });
    expect(pipeline.exec).not.toHaveBeenCalled();
  });

  it("does not turn an unavailable counter read into zero usage", async () => {
    process.env.CLOUD_BETA_WORKSPACE_CALL_LIMIT = "100";
    process.env.CLOUD_BETA_GLOBAL_CALL_LIMIT = "1000";
    pipeline.exec.mockRejectedValueOnce(new Error("redis unavailable"));

    await expect(readCloudBetaQuotaSnapshot("user-1")).resolves.toMatchObject({
      state: "unavailable",
      workspace: { used: null, limit: 100, remaining: null, utilization: null },
      globalCapacity: "unavailable",
    });
  });
});
