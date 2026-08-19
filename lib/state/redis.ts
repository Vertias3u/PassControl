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
  // `policy2` deliberately, not `policy` — see the cache-shape note below.
  policy: (uid: string, agid: string) => `policy2:${uid}:${agid}`,
  fallbacks: (uid: string, agid: string) => `fallbacks:${uid}:${agid}`,
  suspended: (agid: string) => `suspended:${agid}`,
  owner: (uid: string) => `owner:${uid}`,
  // Which providers a tenant holds a credential for. Names no secret and no
  // credential id — only the provider list, used to say what an agent could fail
  // over to. Never a decrypt path.
  providerKeys: (uid: string) => `provkeys:${uid}`,
  lastSeen: (agid: string) => `lastseen:${agid}`,
  keyImport: (uid: string, id: string) => `keyimport:${uid}:${id}`,
};

/**
 * Undo the Upstash client's automatic deserialization for a cache that stores a
 * string.
 *
 * `@upstash/redis` serialises a string by passing it through unchanged, then
 * deserialises EVERY response with `JSON.parse`. So a value written as JSON text
 * — which is every structured cache below — comes back as a parsed object, and
 * `redis().get<string>(…)` quietly asserts otherwise: it is a type argument, not
 * a runtime coercion. Every caller then does `JSON.parse(cached)`, which throws
 * on an object, and every caller's catch branch reads that as "the cached value
 * is malformed".
 *
 * For the policy cache that meant `policy:malformed`, which the proxy fails
 * CLOSED on — an agent with no policy at all was refused for the length of every
 * cache window, clearing only on the miss that re-read Postgres. Found in
 * production on 2026-08-16.
 *
 * The fix belongs here rather than in each caller: the callers are written
 * against the declared `string` contract and are correct as written, so this
 * restores the contract instead of teaching four modules about a client
 * behaviour they should never have to know.
 *
 * Not `automaticDeserialization: false` on the client, which would be the same
 * repair with a far wider blast radius: one client serves the atomic budget Lua
 * script, the nonce `set nx`, and the spend counters, and all of their return
 * types would move at once.
 *
 * A non-string round-trips through `JSON.stringify`, which reproduces the exact
 * text that was stored — including the digit-only case, where `parseRecursive`
 * hands back a real number.
 */
function asCachedString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? null;
}

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
  return asCachedString(await redis().get<unknown>(k.key(agentId, provider)));
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
//
// The key is `policy2:` because the cached SHAPE changed when shadow mode landed:
// it used to be the policy value itself, and is now { p, s } carrying the live
// policy and the shadow candidate from one row read. Reusing `policy:` would
// have made every entry written by the previous deploy parse as a policy object
// with two unknown keys — which parsePolicy rejects, so the gateway would have
// read `policy:malformed` and DENIED live traffic for the length of one cache
// window. There is no invalidation path to keep in sync (the cache is purely
// TTL-driven, which is what "takes effect after at most 60 seconds" means), so
// the whole cost of the rename is 60 seconds of misses on deploy.
export async function getCachedAgentPolicy(
  userId: string,
  agentId: string
): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.policy(userId, agentId)));
}

export async function setCachedAgentPolicy(
  userId: string,
  agentId: string,
  serializedPolicy: string,
  ttlSeconds = 60
): Promise<void> {
  await redis().set(k.policy(userId, agentId), serializedPolicy, { ex: ttlSeconds });
}

/**
 * Drop the cached policy for one agent.
 *
 * One key holds both the live policy and the shadow candidate, so this clears
 * both — which is what promotion needs. Promotion changes ENFORCEMENT, and
 * leaving the old pair cached would mean the operator watches up to 60 seconds
 * of traffic decided by the policy they just replaced. Best-effort at every
 * call site: a failed purge costs one cache window, and must never be the
 * reason a save is reported as failed when the row was in fact written.
 */
export async function purgeAgentPolicy(userId: string, agentId: string): Promise<void> {
  await redis().del(k.policy(userId, agentId));
}

export async function getCachedAgentFallbacks(
  userId: string,
  agentId: string
): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.fallbacks(userId, agentId)));
}

export async function setCachedAgentFallbacks(
  userId: string,
  agentId: string,
  serializedFallbacks: string,
  ttlSeconds = 60
): Promise<void> {
  await redis().set(k.fallbacks(userId, agentId), serializedFallbacks, { ex: ttlSeconds });
}

export async function purgeAgentFallbacks(userId: string, agentId: string): Promise<void> {
  await redis().del(k.fallbacks(userId, agentId));
}

// ── Owner-binding cache ──────────────────────────────────────────────────────
// The owner claim on a receipt is read per call, so it is cached like policy.
// Owner bindings change far less often than policy, hence the longer TTL. Not
// secret material — a published owner is public by definition.
export async function getCachedOwner(userId: string): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.owner(userId)));
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

export async function getCachedProviderKeys(userId: string): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.providerKeys(userId)));
}

export async function setCachedProviderKeys(
  userId: string,
  serializedProviders: string,
  ttlSeconds = 300
): Promise<void> {
  await redis().set(k.providerKeys(userId), serializedProviders, { ex: ttlSeconds });
}

export async function purgeProviderKeysCache(userId: string): Promise<void> {
  await redis().del(k.providerKeys(userId));
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
  const sealed = asCachedString(await redis().get<unknown>(key));
  await redis().del(key);
  return sealed ?? null;
}
