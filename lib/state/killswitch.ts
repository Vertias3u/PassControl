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
import { logFailOpen } from "../observability";
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
    logFailOpen("kill_read");
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

/**
 * Arm/disarm the per-tenant master kill (the dashboard / control-API switch).
 *
 * `ttlSeconds` makes an ARM self-expire. It exists for exactly one caller — the
 * public keyless demo, where a single shared tenant flag is toggled by anonymous
 * visitors and an abandoned arm would wedge the demo for everyone after them.
 * Real tenants must never pass it: an operator's emergency stop stays armed until
 * a human disarms it. Omitting it keeps the original permanent-write behaviour.
 * Disarm is a delete, so the TTL is irrelevant there and is never sent.
 */
export async function armTenantKill(
  userId: string,
  on: boolean,
  opts: { ttlSeconds?: number } = {}
): Promise<void> {
  const r = redis();
  if (!on) {
    await r.del(KEY.tenant(userId));
    return;
  }
  if (opts.ttlSeconds && opts.ttlSeconds > 0) {
    await r.set(KEY.tenant(userId), 1, { ex: opts.ttlSeconds });
    return;
  }
  await r.set(KEY.tenant(userId), 1);
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
