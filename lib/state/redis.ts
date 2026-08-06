// Upstash Redis (REST, edge-compatible) — nonces, budget counters, key cache,
// suspend set, last-seen. The budget reserve is a single atomic Lua script
// (Tension 2 / S3) so reserve+check+rollback never races across round-trips.
import { Redis } from "@upstash/redis";
import { logFailOpen } from "../observability";

let _redis: Redis | null = null;
export function redis(): Redis {
  if (_redis) return _redis;
  _redis = Redis.fromEnv();
  return _redis;
}

// ── Key namespaces ────────────────────────────────────────────────────────────
const k = {
  nonce: (n: string) => `nonce:${n}`,
  reserved: (agid: string) => `reserved:${agid}`,
  spent: (agid: string) => `spent:${agid}`,
  reservedCost: (agid: string) => `reserved_cost:${agid}`,
  spentCost: (agid: string) => `spent_cost:${agid}`,
  reserveMarker: (agid: string, reserveId: string) => `reserve:${agid}:${reserveId}`,
  reserveCostMarker: (agid: string, reserveId: string) => `reserve_cost:${agid}:${reserveId}`,
  key: (agid: string, provider: string) => `key:${agid}:${provider}`,
  policy: (uid: string, agid: string) => `policy:${uid}:${agid}`,
  suspended: (agid: string) => `suspended:${agid}`,
  owner: (uid: string) => `owner:${uid}`,
  lastSeen: (agid: string) => `lastseen:${agid}`,
  keyImport: (uid: string, id: string) => `keyimport:${uid}:${id}`,
};

// ── Replay nonces (Flow B) ────────────────────────────────────────────────────
/** Returns true if the nonce was fresh (claimed), false if already seen (replay). */
export async function claimNonce(nonce: string, ttlSeconds = 180): Promise<boolean> {
  const res = await redis().set(k.nonce(nonce), 1, { nx: true, ex: ttlSeconds });
  return res === "OK";
}

// ── Budget reserve (atomic) ───────────────────────────────────────────────────
// Reserve token and cost estimates for agid unless reserved+spent would exceed
// either cap. cap < 0 means unlimited. The single Lua script keeps both budget
// dimensions atomic: if either cap fails, both reservations roll back together.
// Per-request reserve markers let a crashed reconcile self-heal after marker expiry.
const RESERVE_LUA = `
local tokenCap = tonumber(ARGV[1])
local tokenEstimate = tonumber(ARGV[2])
local costCap = tonumber(ARGV[3])
local costEstimate = tonumber(ARGV[4])
local markerTtl = tonumber(ARGV[5])
local spentTokens = tonumber(redis.call('GET', KEYS[2]) or '0')
local spentCost = tonumber(redis.call('GET', KEYS[5]) or '0')
local reservedTokens = redis.call('INCRBY', KEYS[1], tokenEstimate)
local reservedCost = redis.call('INCRBY', KEYS[4], costEstimate)

local function rollback()
  redis.call('DECRBY', KEYS[1], tokenEstimate)
  redis.call('DECRBY', KEYS[4], costEstimate)
end

if tokenCap >= 0 and (reservedTokens + spentTokens) > tokenCap then
  rollback()
  return {-1, 0}
end
if costCap >= 0 and (reservedCost + spentCost) > costCap then
  rollback()
  return {-2, 0}
end
redis.call('SET', KEYS[3], tokenEstimate, 'EX', markerTtl)
redis.call('SET', KEYS[6], costEstimate, 'EX', markerTtl)
return {reservedTokens, reservedCost}
`;

export interface ReserveResult {
  ok: boolean;
  reserved?: number;
  reservedMicrocents?: number;
  reason?: "tokens" | "cost";
}

export interface BudgetSnapshot {
  reservedTokens: number;
  spentTokens: number | null;
  reservedMicrocents: number;
  spentMicrocents: number | null;
}

/**
 * Read the four counters used by the atomic reserve without changing them.
 * Null spent values matter: the live route would seed those dimensions from
 * its database snapshot before reserving, while an existing Redis value wins.
 */
export async function readBudgetSnapshot(agentId: string): Promise<BudgetSnapshot> {
  const values = await redis().mget<[number | null, number | null, number | null, number | null]>(
    k.reserved(agentId),
    k.spent(agentId),
    k.reservedCost(agentId),
    k.spentCost(agentId)
  );
  const numberOr = (value: unknown, fallback: number | null): number | null => {
    if (value === null || value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    reservedTokens: numberOr(values[0], 0) ?? 0,
    spentTokens: numberOr(values[1], null),
    reservedMicrocents: numberOr(values[2], 0) ?? 0,
    spentMicrocents: numberOr(values[3], null),
  };
}

export async function reserveBudget(params: {
  agentId: string;
  reserveId: string;
  estimate: number;
  estimateMicrocents?: number;
  capTokens: number | null; // null = unlimited
  capMicrocents?: number | null; // null = no cost cap
  markerTtlSeconds: number;
}): Promise<ReserveResult> {
  const tokenCap = params.capTokens == null ? -1 : Math.max(0, Math.floor(params.capTokens));
  const costCap = params.capMicrocents == null ? -1 : Math.max(0, Math.round(params.capMicrocents));
  const tokenEstimate = Math.max(0, Math.floor(params.estimate));
  const costEstimate = Math.max(0, Math.round(params.estimateMicrocents ?? 0));
  const tracksCost = params.estimateMicrocents != null || params.capMicrocents != null;
  const res = (await redis().eval(
    RESERVE_LUA,
    [
      k.reserved(params.agentId),
      k.spent(params.agentId),
      k.reserveMarker(params.agentId, params.reserveId),
      k.reservedCost(params.agentId),
      k.spentCost(params.agentId),
      k.reserveCostMarker(params.agentId, params.reserveId),
    ],
    [
      String(tokenCap),
      String(tokenEstimate),
      String(costCap),
      String(costEstimate),
      String(params.markerTtlSeconds),
    ]
  )) as number[] | number;
  const out = Array.isArray(res) ? res.map(Number) : [Number(res), 0];
  if (out[0] === -1) return { ok: false, reason: "tokens" };
  if (out[0] === -2) return { ok: false, reason: "cost" };
  return tracksCost
    ? { ok: true, reserved: out[0], reservedMicrocents: out[1] ?? 0 }
    : { ok: true, reserved: out[0] };
}

// Reconcile after a stream: release the estimate from `reserved`, add the true
// usage to `spent`, and drop the per-request marker. Done in one pipeline.
export async function reconcileBudget(params: {
  agentId: string;
  reserveId: string;
  estimate: number;
  estimateMicrocents?: number;
  actualTokens: number;
  actualMicrocents?: number;
}): Promise<void> {
  const estimate = Math.max(0, Math.floor(params.estimate));
  const actualTokens = Math.max(0, Math.floor(params.actualTokens));
  const estimateMicrocents = Math.max(0, Math.round(params.estimateMicrocents ?? 0));
  const actualMicrocents = Math.max(0, Math.round(params.actualMicrocents ?? 0));
  const pipe = redis().pipeline();
  pipe.decrby(k.reserved(params.agentId), estimate);
  pipe.decrby(k.reservedCost(params.agentId), estimateMicrocents);
  pipe.incrby(k.spent(params.agentId), actualTokens);
  pipe.incrby(k.spentCost(params.agentId), actualMicrocents);
  pipe.del(k.reserveMarker(params.agentId, params.reserveId));
  pipe.del(k.reserveCostMarker(params.agentId, params.reserveId));
  await pipe.exec();
}

export async function getSpent(agentId: string): Promise<number> {
  return Number((await redis().get<number>(k.spent(agentId))) ?? 0);
}

export async function setSpent(agentId: string, tokens: number): Promise<void> {
  await redis().set(k.spent(agentId), tokens);
}

export async function setReserved(agentId: string, tokens: number): Promise<void> {
  await redis().set(k.reserved(agentId), tokens);
}

/** Seed spent:<agid> from the DB mirror once (NX), so cold instances don't
 *  under-count before the reconcile cron runs. */
export async function seedSpent(
  agentId: string,
  dbSpentTokens: number,
  dbSpentMicrocents = 0
): Promise<void> {
  const pipe = redis().pipeline();
  pipe.set(k.spent(agentId), dbSpentTokens, { nx: true });
  pipe.set(k.spentCost(agentId), dbSpentMicrocents, { nx: true });
  await pipe.exec();
}

// ── Provider-key cache (stores ciphertext only; see aesgcm.ts) ────────────────
export async function getCachedKey(agentId: string, provider: string): Promise<string | null> {
  return redis().get<string>(k.key(agentId, provider));
}

export async function setCachedKey(
  agentId: string,
  provider: string,
  sealed: string,
  ttlSeconds = 60
): Promise<void> {
  await redis().set(k.key(agentId, provider), sealed, { ex: ttlSeconds });
}

// ── Agent-policy cache ───────────────────────────────────────────────────────
// Policy is not secret material, so cache its serialized JSON directly. Include
// both tenant and agent identifiers even though agent UUIDs are globally unique:
// tenant isolation must be visible in every hot-path key, not merely assumed.
export async function getCachedAgentPolicy(
  userId: string,
  agentId: string
): Promise<string | null> {
  return redis().get<string>(k.policy(userId, agentId));
}

export async function setCachedAgentPolicy(
  userId: string,
  agentId: string,
  serializedPolicy: string,
  ttlSeconds = 60
): Promise<void> {
  await redis().set(k.policy(userId, agentId), serializedPolicy, { ex: ttlSeconds });
}

// ── Owner-binding cache ──────────────────────────────────────────────────────
// The owner claim on a receipt is read per call, so it is cached like policy.
// Owner bindings change far less often than policy, hence the longer TTL. Not
// secret material — a published owner is public by definition.
export async function getCachedOwner(userId: string): Promise<string | null> {
  return redis().get<string>(k.owner(userId));
}

export async function setCachedOwner(
  userId: string,
  serializedOwner: string,
  ttlSeconds = 300
): Promise<void> {
  await redis().set(k.owner(userId), serializedOwner, { ex: ttlSeconds });
}

export async function purgeOwnerCache(userId: string): Promise<void> {
  await redis().del(k.owner(userId));
}

export async function purgeAgentCaches(agentId: string, providers: string[]): Promise<void> {
  const keys = providers.map((p) => k.key(agentId, p));
  if (keys.length) await redis().del(...keys);
}

// ── Per-agent fast revocation ─────────────────────────────────────────────────
export async function isSuspended(agentId: string): Promise<boolean> {
  try {
    return (await redis().exists(k.suspended(agentId))) === 1;
  } catch {
    logFailOpen("suspend_read");
    // Match the Redis-backed kill switch: fail open by default to avoid blocking
    // every agent on a transient Redis read blip; operators can opt into strict
    // fail-closed behavior for revocation reads.
    return process.env.KILL_SWITCH_FAIL_CLOSED === "true";
  }
}

export async function suspendAgent(agentId: string): Promise<void> {
  await redis().set(k.suspended(agentId), 1);
}

export async function unsuspendAgent(agentId: string): Promise<void> {
  await redis().del(k.suspended(agentId));
}

// ── last_seen (write-coalesced; flushed to Postgres by the reconcile cron) ────
export async function touchLastSeen(agentId: string): Promise<void> {
  await redis().set(k.lastSeen(agentId), Date.now());
}

// ── Key-import handoff (dashboard on-ramp) ───────────────────────────────────
// Holds an ALREADY-SEALED provider key between the probe step and the commit
// step. The browser gets only the opaque id, never the material — so the raw
// key, in any form, never leaves the server. Tenant is baked into the key so
// one tenant can never redeem another's handoff even with a guessed id.
export async function stashKeyImport(
  userId: string,
  id: string,
  sealedKey: string,
  ttlSeconds: number
): Promise<void> {
  await redis().set(k.keyImport(userId, id), sealedKey, { ex: ttlSeconds });
}

/**
 * Redeem a handoff EXACTLY once. The delete is unconditional and happens even
 * on a miss, so a captured id cannot be replayed for the rest of its TTL.
 */
export async function takeKeyImport(userId: string, id: string): Promise<string | null> {
  const key = k.keyImport(userId, id);
  const sealed = await redis().get<string>(key);
  await redis().del(key);
  return sealed ?? null;
}
