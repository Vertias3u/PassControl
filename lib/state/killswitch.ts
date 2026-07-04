// Kill switch (trust boundary #3) — instant, layered revocation, Redis-backed so
// it works on any host without a proprietary config service. Layers:
//   platform   — ops-only flag, blocks ALL tenants (no dashboard path)
//   tenant      — per-tenant master kill (the dashboard switch), keyed by userId
//   denylist    — emergency per-agent blocklist
// Per-agent suspension lives in redis.ts (suspended:<agid>) and is checked in
// parallel by the proxy as the instant per-agent layer.
//
// (Reads are 3 concurrent Redis ops; could be folded into one pipeline later to
// cut request count — kept as Promise.all here for clarity. Correctness first.)
import { redis } from "./redis";

const KEY = {
  platform: "killswitch:platform",
  tenant: (userId: string) => `killswitch:tenant:${userId}`,
  denylist: "killswitch:denylist",
};

export interface KillState {
  platformKill: boolean;
  userKill: boolean;
  denylist: string[];
}

/** Resolve the kill state relevant to a single agent's owner. */
export async function readKillState(userId: string | null): Promise<KillState> {
  try {
    const r = redis();
    const [platform, tenant, denylist] = await Promise.all([
      r.get(KEY.platform),
      userId ? r.get(KEY.tenant(userId)) : Promise.resolve(null),
      r.smembers(KEY.denylist),
    ]);
    return {
      platformKill: Boolean(platform),
      userKill: Boolean(tenant),
      denylist: Array.isArray(denylist) ? (denylist as string[]) : [],
    };
  } catch {
    // Default: fail OPEN (treat as not-killed). The same Redis backs budget
    // reserves and per-agent suspend, so an outage already fails the proxy
    // request elsewhere — we don't add a "block every tenant on a transient
    // blip" path by default. Operators who want the emergency stop to be strict
    // can set KILL_SWITCH_FAIL_CLOSED=true, and a read failure blocks instead.
    if (process.env.KILL_SWITCH_FAIL_CLOSED === "true") {
      return { platformKill: true, userKill: false, denylist: [] };
    }
    return { platformKill: false, userKill: false, denylist: [] };
  }
}

export function isBlocked(state: KillState, agentId: string): boolean {
  return state.platformKill || state.userKill || state.denylist.includes(agentId);
}

/** Arm/disarm the per-tenant master kill (the dashboard / control-API switch). */
export async function armTenantKill(userId: string, on: boolean): Promise<void> {
  const r = redis();
  if (on) await r.set(KEY.tenant(userId), 1);
  else await r.del(KEY.tenant(userId));
}

/** Ops-only: platform-wide kill across all tenants. No dashboard path by design. */
export async function setPlatformKill(on: boolean): Promise<void> {
  const r = redis();
  if (on) await r.set(KEY.platform, 1);
  else await r.del(KEY.platform);
}

/** Ops-only: emergency per-agent denylist. */
export async function addToDenylist(agentId: string): Promise<void> {
  await redis().sadd(KEY.denylist, agentId);
}
export async function removeFromDenylist(agentId: string): Promise<void> {
  await redis().srem(KEY.denylist, agentId);
}
