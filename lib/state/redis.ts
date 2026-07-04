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
  reserveMarker: (agid: string, jti: string) => `reserve:${agid}:${jti}`,
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
// Reserve `est` tokens for agid unless reserved+spent would exceed cap.
// cap < 0 means unlimited. Also writes a per-jti reserve marker with TTL so a
// crashed reconcile self-heals (the marker expires; the cron resets the counter).
const RESERVE_LUA = `
local cap = tonumber(ARGV[1])
local est = tonumber(ARGV[2])
local markerTtl = tonumber(ARGV[3])
local spent = tonumber(redis.call('GET', KEYS[2]) or '0')
local reserved = redis.call('INCRBY', KEYS[1], est)
if cap >= 0 and (reserved + spent) > cap then
  redis.call('DECRBY', KEYS[1], est)
  return -1
end
redis.call('SET', KEYS[3], est, 'EX', markerTtl)
return reserved
`;

export interface ReserveResult {
  ok: boolean;
  reserved?: number;
}

export async function reserveBudget(params: {
  agentId: string;
  jti: string;
  estimate: number;
  capTokens: number | null; // null = unlimited
  markerTtlSeconds: number;
}): Promise<ReserveResult> {
  const cap = params.capTokens == null ? -1 : params.capTokens;
  const res = (await redis().eval(
    RESERVE_LUA,
    [k.reserved(params.agentId), k.spent(params.agentId), k.reserveMarker(params.agentId, params.jti)],
    [String(cap), String(params.estimate), String(params.markerTtlSeconds)]
  )) as number;
  return res === -1 ? { ok: false } : { ok: true, reserved: res };
}

// Reconcile after a stream: release the estimate from `reserved`, add the true
// usage to `spent`, and drop the per-jti marker. Done in one pipeline.
export async function reconcileBudget(params: {
  agentId: string;
  jti: string;
  estimate: number;
  actualTokens: number;
}): Promise<void> {
  const pipe = redis().pipeline();
  pipe.decrby(k.reserved(params.agentId), params.estimate);
  pipe.incrby(k.spent(params.agentId), params.actualTokens);
  pipe.del(k.reserveMarker(params.agentId, params.jti));
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
export async function seedSpent(agentId: string, dbSpentTokens: number): Promise<void> {
  await redis().set(k.spent(agentId), dbSpentTokens, { nx: true });
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
