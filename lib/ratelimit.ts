// Fixed-window rate limiter on the existing Upstash REST client. Edge-native and
// dependency-free. One Lua script increments and ensures a TTL in the same Redis
// operation so a lost EXPIRE cannot wedge a key forever. Chosen over
// @upstash/ratelimit for simplicity + testability — upgrade to its sliding window
// later if burst-at-the-window-boundary becomes a real concern (see DECISIONS.md).
import { redis } from "./state/redis";
import { logFailOpen } from "./observability";

export interface RateLimitResult {
  success: boolean;
  remaining: number;
}

const RATE_LIMIT_LUA = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return count
`;

/**
 * Allow at most `limit` calls per `windowSeconds` for `key`. Fails OPEN on a
 * Redis error — availability over strictness for an auth endpoint that already
 * has signature verification + nonce replay protection behind it.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const k = `ratelimit:${key}`;
  try {
    const count = Number(await redis().eval(RATE_LIMIT_LUA, [k], [String(windowSeconds)]));
    return { success: count <= limit, remaining: Math.max(0, limit - count) };
  } catch {
    logFailOpen("ratelimit");
    return { success: true, remaining: limit };
  }
}
