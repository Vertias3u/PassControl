// Upstash Redis (REST, edge-compatible) — nonces, budget counters, key cache,
// suspend set, last-seen. The budget reserve is a single atomic Lua script
// (Tension 2 / S3) so reserve+check+rollback never races across round-trips.
import { Redis } from "@upstash/redis";

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
  reserveMarker: (agid: string, jti: string) => `reserve:${agid}:${jti}`,
  reserveCostMarker: (agid: string, jti: string) => `reserve_cost:${agid}:${jti}`,
  key: (agid: string, provider: string) => `key:${agid}:${provider}`,
  suspended: (agid: string) => `suspended:${agid}`,
  lastSeen: (agid: string) => `lastseen:${agid}`,
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
// Per-jti reserve markers let a crashed reconcile self-heal after marker expiry.
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

export async function reserveBudget(params: {
  agentId: string;
  jti: string;
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
      k.reserveMarker(params.agentId, params.jti),
      k.reservedCost(params.agentId),
      k.spentCost(params.agentId),
      k.reserveCostMarker(params.agentId, params.jti),
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
// usage to `spent`, and drop the per-jti marker. Done in one pipeline.
export async function reconcileBudget(params: {
  agentId: string;
  jti: string;
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
  pipe.del(k.reserveMarker(params.agentId, params.jti));
  pipe.del(k.reserveCostMarker(params.agentId, params.jti));
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

export async function purgeAgentCaches(agentId: string, providers: string[]): Promise<void> {
  const keys = providers.map((p) => k.key(agentId, p));
  if (keys.length) await redis().del(...keys);
}

// ── Per-agent fast revocation ─────────────────────────────────────────────────
export async function isSuspended(agentId: string): Promise<boolean> {
  return (await redis().exists(k.suspended(agentId))) === 1;
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
