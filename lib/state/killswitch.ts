// Kill switch (trust boundary #3) — instant, layered revocation, Redis-backed so
// it works on any host without a proprietary config service. Layers:
//   platform   — ops-only flag, blocks ALL tenants (no dashboard path)
//   tenant      — per-tenant master kill (the dashboard switch), keyed by userId
//   denylist    — emergency per-agent blocklist
// Per-agent suspension lives in redis.ts (suspended:<agid>) and is checked in
// parallel by the proxy as the instant per-agent layer.
//
//
// Durable record (0083, 2026-10-10). The tenant kill, per-service kills and
// session stops are ALSO rows in Postgres (kill-record.ts); Redis is the copy
// read per call. Before this, losing Redis lifted all of them silently. A
// per-tenant `loaded` marker rides in the same MGET as the tenant flag: when it
// is missing (Redis lost, or a tenant not loaded since this shipped), that
// tenant's stops are reloaded from the record, written back, and THIS call is
// decided from them. The reload only ever adds stops, so a stop armed before
// 0083 (no row) is never lifted by it. The ops-only platform flag and denylist
// have no record: nothing in code writes them.
import { logFailOpen } from "../observability";
import { redis } from "./redis";
import { sessionStopKey } from "./kill-keys";
import { deleteKillRecord, loadKillRecords, saveKillRecord, type KillRecord } from "./kill-record";

const KEY = {
  platform: "killswitch:platform",
  tenant: (userId: string) => `killswitch:tenant:${userId}`,
  // Any-API phase 2: one tenant's stop for one non-LLM service ("stop all GitHub
  // access, keep Claude"). Read only when a service route names its service.
  service: (userId: string, service: string) => `killswitch:tenant:${userId}:svc:${service}`,
  denylist: "killswitch:denylist",
  // Present once this tenant's stops have been loaded from the durable record.
  loaded: (userId: string) => `killswitch:loaded:${userId}`,
};

function recordKey(userId: string, stop: KillRecord): string {
  if (stop.kind === "tenant") return KEY.tenant(userId);
  if (stop.kind === "service") return KEY.service(userId, stop.service);
  return sessionStopKey(stop.agentId, stop.sessionId);
}

type RedisClient = ReturnType<typeof redis>;

/**
 * Load one tenant's stops from the record and write them back to Redis, then
 * mark the tenant loaded. Throws only when the RECORD cannot be read (the
 * caller's fail posture decides); a failed write-back is swallowed and leaves
 * the marker unset, so the next call loads again. Adds keys, never deletes one.
 */
async function reloadFromRecord(r: RedisClient, userId: string): Promise<KillRecord[]> {
  const stops = await loadKillRecords(userId);
  try {
    await Promise.all(stops.map((stop) => r.set(recordKey(userId, stop), 1)));
    await r.set(KEY.loaded(userId), 1);
  } catch {
    // The stops still decide this call; the next one tries the write-back again.
  }
  return stops;
}

export interface KillState {
  platformKill: boolean;
  userKill: boolean;
  denylist: string[];
  /**
   * The tenant's per-service kill for the service the caller named. Only the
   * service route asks, so it is absent on a model call and `isBlocked` — the
   * model route's test — never reads it.
   */
  serviceKill?: boolean;
  /**
   * Session stops just reloaded from the durable record. Present only on the
   * call that did the reload: the proxy reads suspension in PARALLEL with this
   * function, so that read saw the empty Redis, and `withRecordedSessionStop`
   * lets these overrule it. Every later call finds them in Redis.
   */
  recordedSessionStops?: ReadonlyArray<{ agentId: string; sessionId: string }>;
}

/**
 * Resolve the kill state relevant to a single agent's owner. A service route
 * passes its service, and that tenant's per-service kill is read in the SAME
 * round trip, so it shares this function's fail posture exactly (invariant 3's
 * kill column): it is a kill switch, not a scope rule.
 */
export async function readKillState(
  userId: string | null,
  options: { service?: string } = {}
): Promise<KillState> {
  try {
    const r = redis();
    // One MGET: the platform flag, the tenant flag, the tenant's loaded marker
    // and the named service's flag. The marker costs no extra command.
    const keys = [KEY.platform];
    if (userId) keys.push(KEY.tenant(userId), KEY.loaded(userId));
    if (userId && options.service) keys.push(KEY.service(userId, options.service));
    const [values, denylist] = await Promise.all([r.mget(...keys), r.smembers(KEY.denylist)]);
    const [platform, tenant, loaded, service] = values as unknown[];
    const state: KillState = {
      platformKill: Boolean(platform),
      userKill: Boolean(tenant),
      denylist: Array.isArray(denylist) ? (denylist as string[]) : [],
      ...(options.service ? { serviceKill: Boolean(service) } : {}),
    };
    if (!userId || (loaded !== null && loaded !== undefined)) return state;

    let stops: KillRecord[];
    try {
      stops = await reloadFromRecord(r, userId);
    } catch {
      // The record could not be read: the kill switch's own posture, as a failed
      // Redis read below. What Redis DID hold still counts either way.
      logFailOpen("kill_record_read");
      if (process.env.KILL_SWITCH_FAIL_CLOSED === "true") return { ...state, platformKill: true };
      return state;
    }
    const sessions = stops.flatMap((stop) =>
      stop.kind === "session" ? [{ agentId: stop.agentId, sessionId: stop.sessionId }] : []
    );
    return {
      ...state,
      userKill: state.userKill || stops.some((stop) => stop.kind === "tenant"),
      ...(options.service
        ? {
            serviceKill:
              state.serviceKill === true ||
              stops.some((stop) => stop.kind === "service" && stop.service === options.service),
          }
        : {}),
      ...(sessions.length ? { recordedSessionStops: sessions } : {}),
    };
  } catch {
    logFailOpen("kill_read");
    // Default: fail OPEN (treat as not-killed). The same Redis backs budget
    // reserves and per-agent suspend, so an outage already fails the proxy
    // request elsewhere — we don't add a "block every tenant on a transient
    // blip" path by default. Operators who want the emergency stop to be strict
    // can set KILL_SWITCH_FAIL_CLOSED=true, and a read failure blocks instead.
    // Same posture for a named service: under fail-closed the platform flag
    // already blocks everything; fail-open leaves the service open too.
    const service = options.service ? { serviceKill: false } : {};
    if (process.env.KILL_SWITCH_FAIL_CLOSED === "true") {
      return { platformKill: true, userKill: false, denylist: [], ...service };
    }
    return { platformKill: false, userKill: false, denylist: [], ...service };
  }
}

/**
 * The tenant and platform kill flags as OBSERVED, for the operator's screen.
 * `null` means that read failed. Deliberately separate from `readKillState`,
 * which applies the configured fail posture for enforcement: shown on a
 * dashboard, that posture would turn "could not read" into "armed" or "clear".
 */
export async function observeKillState(
  userId: string
): Promise<{ platform: boolean | null; tenant: boolean | null }> {
  const r = (() => {
    try {
      return redis();
    } catch {
      return null;
    }
  })();
  if (!r) return { platform: null, tenant: null };
  const [platform, tenant, loaded] = await Promise.all([
    r.get(KEY.platform).then((value) => Boolean(value), () => null),
    r.get(KEY.tenant(userId)).then((value) => Boolean(value), () => null),
    r.get(KEY.loaded(userId)).then((value) => Boolean(value), () => null),
  ]);
  // Redis answered "clear" for a tenant it has not loaded: the record decides,
  // as it will for the gateway's next call. Unreadable record = unknown.
  if (tenant === false && loaded === false) {
    const stops = await reloadFromRecord(r, userId).catch(() => null);
    return { platform, tenant: stops === null ? null : stops.some((stop) => stop.kind === "tenant") };
  }
  return { platform, tenant };
}

/**
 * The proxy's suspension read, corrected by any session stop the kill read just
 * reloaded from the record (see `KillState.recordedSessionStops`). Never weakens
 * the read: a suspended agent stays suspended.
 */
export function withRecordedSessionStop(
  suspended: boolean | "session",
  state: KillState,
  agentId: string,
  sessionId: string | null | undefined
): boolean | "session" {
  if (suspended !== false || !sessionId) return suspended;
  const stopped = state.recordedSessionStops?.some(
    (stop) => stop.agentId === agentId && stop.sessionId === sessionId
  );
  return stopped ? "session" : false;
}

/**
 * Make sure this tenant's recorded stops are in Redis, for a screen about to
 * read them there (the sessions panel). `false` when that could not be done.
 */
export async function ensureKillRecordLoaded(userId: string): Promise<boolean> {
  try {
    const r = redis();
    if (await r.get(KEY.loaded(userId))) return true;
    await reloadFromRecord(r, userId);
    return true;
  } catch {
    return false;
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

/**
 * Arm or disarm one tenant's stop for one service. Like a real tenant's master
 * kill, an arm is permanent until a human disarms it: no TTL.
 */
export async function armServiceKill(userId: string, service: string, on: boolean): Promise<void> {
  const r = redis();
  if (on) await r.set(KEY.service(userId, service), "1");
  else await r.del(KEY.service(userId, service));
}

/**
 * The per-service kill as OBSERVED, for the operator's toggle. `null` means the
 * read failed: shown on a dashboard, the enforcement posture would turn "could
 * not read" into "armed" or "clear" (see observeKillState).
 */
export async function observeServiceKill(userId: string, service: string): Promise<boolean | null> {
  try {
    const r = redis();
    const [armed, loaded] = await Promise.all([r.get(KEY.service(userId, service)), r.get(KEY.loaded(userId))]);
    if (armed || loaded) return Boolean(armed);
    // Not loaded since Redis lost its data: the record decides (observeKillState).
    const stops = await reloadFromRecord(r, userId);
    return stops.some((stop) => stop.kind === "service" && stop.service === service);
  } catch {
    return null;
  }
}

/**
 * Whether an arm or disarm reached the durable record as well as Redis. Redis is
 * what stops calls, so `durable: false` is a stop in force (or lifted) that a
 * Redis loss would undo; the operator is told, and can press again.
 */
export interface DurableKillResult {
  durable: boolean;
}

/**
 * The dashboard's and the control API's master kill: Redis AND the record.
 * Arm writes Redis first, so the stop is in force at once, then the record.
 * Disarm clears the record first, then Redis: a reload that lands in between
 * finds Redis still armed, so the worst it can do is re-arm. A Redis failure
 * throws, as before: nothing claims a stop that is not in force.
 * Not for the demo's self-expiring arm or the account-erasure guard, which stay
 * Redis-only through `armTenantKill`.
 */
export async function setTenantKillDurably(userId: string, on: boolean): Promise<DurableKillResult> {
  const stop: KillRecord = { kind: "tenant" };
  if (on) {
    await armTenantKill(userId, true);
    return { durable: await saveKillRecord(userId, stop) };
  }
  const durable = await deleteKillRecord(userId, stop);
  await armTenantKill(userId, false);
  return { durable };
}

/** One service's stop, recorded the same way as the master kill. */
export async function setServiceKillDurably(userId: string, service: string, on: boolean): Promise<DurableKillResult> {
  const stop: KillRecord = { kind: "service", service };
  if (on) {
    await armServiceKill(userId, service, true);
    return { durable: await saveKillRecord(userId, stop) };
  }
  const durable = await deleteKillRecord(userId, stop);
  await armServiceKill(userId, service, false);
  return { durable };
}
