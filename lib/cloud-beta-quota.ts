// Infrastructure protection for the deliberately tiny Cloud beta.
//
// This is NOT an agent budget and does not touch RESERVE_LUA. The two monthly
// counters share one Redis round trip through their own atomic script, keeping
// the money gate isolated from a temporary launch control. Limits are opt-in so
// the source-available/self-hosted core has no Cloud product cap by default.
import { redis } from "@/lib/state/redis";

export type CloudBetaQuotaResult =
  | { ok: true; disabled: true }
  | { ok: true; workspaceCount: number; globalCount: number }
  | { ok: false; reason: "workspace" | "global" | "unavailable" };

export type CloudBetaGlobalCapacity =
  | "not-configured"
  | "available"
  | "near-limit"
  | "exhausted"
  | "unavailable";

export interface CloudBetaQuotaSnapshot {
  state: "available" | "disabled" | "unavailable";
  resetAt: string;
  workspace: {
    used: number | null;
    limit: number | null;
    remaining: number | null;
    utilization: number | null;
  };
  // Intentionally categorical. A tenant may see whether the shared beta has
  // headroom, but never the aggregate call count of other tenants.
  globalCapacity: CloudBetaGlobalCapacity;
}

function configuredLimit(name: string): number | null {
  const value = Number(process.env[name] ?? "0");
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function nextUtcMonth(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

function globalCapacity(used: number, limit: number | null): CloudBetaGlobalCapacity {
  if (limit === null) return "not-configured";
  if (used >= limit) return "exhausted";
  if (used / limit >= 0.8) return "near-limit";
  return "available";
}

// Separate from RESERVE_LUA on purpose: this is launch-capacity accounting, not
// money. Workspace admission happens first inside the same atomic Redis call,
// so a tenant that is already over its own ceiling cannot spend the shared
// allowance and lock every other beta tenant out.
const CLOUD_BETA_QUOTA_LUA = `
local workspaceLimit = tonumber(ARGV[1])
local globalLimit = tonumber(ARGV[2])
local workspaceCount = 0
local globalCount = 0

if workspaceLimit >= 0 then
  workspaceCount = redis.call('INCR', KEYS[1])
  if workspaceLimit >= 0 and workspaceCount > workspaceLimit then
    return {-1, workspaceCount, 0}
  end
end

if globalLimit >= 0 then
  globalCount = redis.call('INCR', KEYS[2])
  if globalCount > globalLimit then
    if workspaceLimit >= 0 then
      workspaceCount = redis.call('DECR', KEYS[1])
    end
    globalCount = redis.call('DECR', KEYS[2])
    return {-2, workspaceCount, globalCount}
  end
end

return {0, workspaceCount, globalCount}
`;

/**
 * Read-only view of the temporary Cloud beta counters for the dashboard.
 * This deliberately uses GET, never INCR, and remains outside RESERVE_LUA.
 */
export async function readCloudBetaQuotaSnapshot(
  userId: string,
  now: Date = new Date()
): Promise<CloudBetaQuotaSnapshot> {
  const workspaceLimit = configuredLimit("CLOUD_BETA_WORKSPACE_CALL_LIMIT");
  const globalLimit = configuredLimit("CLOUD_BETA_GLOBAL_CALL_LIMIT");
  const resetAt = nextUtcMonth(now);
  const emptyWorkspace = {
    used: null,
    limit: workspaceLimit,
    remaining: null,
    utilization: null,
  };

  if (workspaceLimit === null && globalLimit === null) {
    return {
      state: "disabled",
      resetAt,
      workspace: emptyWorkspace,
      globalCapacity: "not-configured",
    };
  }

  const month = now.toISOString().slice(0, 7);
  const pipe = redis().pipeline();
  const order: Array<"workspace" | "global"> = [];
  if (workspaceLimit !== null) {
    pipe.get(`cloud-beta:${month}:workspace:${userId}`);
    order.push("workspace");
  }
  if (globalLimit !== null) {
    pipe.get(`cloud-beta:${month}:global`);
    order.push("global");
  }

  let values: unknown[];
  try {
    values = (await pipe.exec()) as unknown[];
  } catch {
    return {
      state: "unavailable",
      resetAt,
      workspace: emptyWorkspace,
      globalCapacity: globalLimit === null ? "not-configured" : "unavailable",
    };
  }

  let workspaceUsed = 0;
  let globalUsed = 0;
  for (let index = 0; index < order.length; index++) {
    if (order[index] === "workspace") workspaceUsed = count(values[index]);
    else globalUsed = count(values[index]);
  }

  return {
    state: "available",
    resetAt,
    workspace:
      workspaceLimit === null
        ? emptyWorkspace
        : {
            used: workspaceUsed,
            limit: workspaceLimit,
            remaining: Math.max(0, workspaceLimit - workspaceUsed),
            utilization: Math.min(1, workspaceUsed / workspaceLimit),
          },
    globalCapacity: globalCapacity(globalUsed, globalLimit),
  };
}

export async function consumeCloudBetaQuota(
  userId: string,
  now: Date = new Date()
): Promise<CloudBetaQuotaResult> {
  const workspaceLimit = configuredLimit("CLOUD_BETA_WORKSPACE_CALL_LIMIT");
  const globalLimit = configuredLimit("CLOUD_BETA_GLOBAL_CALL_LIMIT");
  if (workspaceLimit === null && globalLimit === null) return { ok: true, disabled: true };

  const month = now.toISOString().slice(0, 7);
  let raw: unknown;
  try {
    raw = await redis().eval(
      CLOUD_BETA_QUOTA_LUA,
      [`cloud-beta:${month}:workspace:${userId}`, `cloud-beta:${month}:global`],
      [String(workspaceLimit ?? -1), String(globalLimit ?? -1)]
    );
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  if (!Array.isArray(raw) || raw.length !== 3) return { ok: false, reason: "unavailable" };
  if (
    typeof raw[0] !== "number" ||
    typeof raw[1] !== "number" ||
    typeof raw[2] !== "number" ||
    !Number.isFinite(raw[0]) ||
    !Number.isFinite(raw[1]) ||
    !Number.isFinite(raw[2])
  ) {
    return { ok: false, reason: "unavailable" };
  }
  const [status, workspaceCount, globalCount] = raw;
  if (status === -1) return { ok: false, reason: "workspace" };
  if (status === -2) return { ok: false, reason: "global" };
  if (status !== 0) return { ok: false, reason: "unavailable" };
  return { ok: true, workspaceCount, globalCount };
}
