// Fixed-window rate limiter on the existing Upstash REST client. Edge-native and
// dependency-free. One atomic INCR per request; EXPIRE is set on the first hit so
// the counter resets after `windowSeconds`. Chosen over @upstash/ratelimit for
// simplicity + testability — upgrade to its sliding window later if burst-at-the-
// window-boundary becomes a real concern (see DECISIONS.md).
import { redis } from "./state/redis";

export interface RateLimitResult {
  success: boolean;
  remaining: number;
}

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
    const r = redis();
    const count = await r.incr(k);
    if (count === 1) await r.expire(k, windowSeconds);
    return { success: count <= limit, remaining: Math.max(0, limit - count) };
  } catch {
    return { success: true, remaining: limit };
  }
}
