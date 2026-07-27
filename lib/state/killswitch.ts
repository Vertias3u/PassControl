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

/** Why a call was stopped, for the audit trail only — never for the wire. */
export type BlockedReason = "blocked_killed" | "blocked_suspended";

/**
 * Attribute a block to the control that caused it.
 *
 * The proxy answers every revocation with the same 403 body: a caller learns
 * that it was stopped, never which control stopped it. That opacity is
 * deliberate on the wire and wrong in the log — an operator who armed the
 * tenant kill switch used to read `blocked_suspended` in the audit trail and go
 * looking at a per-agent suspension that was never set.
 *
 * A kill (platform, tenant, or denylist) outranks a suspend when both apply: it
 * is the operator's deliberate, tenant-wide act and the one they are looking
 * for. Returns null when nothing blocks, so a caller cannot log an allow as a
 * block. Keep in step with isBlocked() — every state it rejects must yield a
 * reason here.
 */
export function blockedReason(
  state: KillState,
  agentId: string,
  suspended: boolean
): BlockedReason | null {
  if (isBlocked(state, agentId)) return "blocked_killed";
  if (suspended) return "blocked_suspended";
  return null;
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
