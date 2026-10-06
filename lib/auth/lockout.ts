// Temporary account lockout after repeated failed logins. Layered on top of the
// per-IP/per-email rate limit (lib/ratelimit) as a second brute-force defense.
//
// State lives in Redis keyed on the NORMALIZED email (lower-cased + trimmed by
// the caller) so switching source IP or changing the casing of the username does
// not reset or bypass the counter. The lockout window escalates with repeated
// lockouts and is cleared on the next successful login. We deliberately do not
// expose the remaining-attempt count to the client.
//
// FAILS OPEN (owner decision, 2026-10-04). When Redis is unreachable, nobody is
// locked and nothing is recorded. It used to throw, which took the whole /login
// action down with it: on Cloud, Upstash running out of monthly commands would
// have locked every operator out, the owner included, at exactly the moment the
// dashboard (and its kill switch) is needed. That matches the login rate limiter
// beside it, and Supabase still checks the password. Unlike the Direct Agent Key
// pre-auth limiter, nothing here protects the database from unauthenticated
// work, so there is no reason for this one to fail closed.
import { logFailOpen } from "@/lib/observability";
import { redis } from "@/lib/state/redis";

const FAILS_BEFORE_LOCK = 5; // consecutive failures that trigger a lockout
const FAIL_WINDOW_S = 900; // failures must be within 15 min to accumulate
const LOCK_LEVEL_TTL_S = 86_400; // remember escalation level for 24h

// Escalating cooldown by lockout level (seconds): 1m, 5m, 15m, then 1h.
const LOCK_DURATIONS = [60, 300, 900, 3600];

const failKey = (email: string) => `loginfail:${email}`;
const lockKey = (email: string) => `lockout:${email}`;
const levelKey = (email: string) => `locklevel:${email}`;

/** True if the account is currently in a cooling-off lockout window. */
export async function isLockedOut(email: string): Promise<boolean> {
  if (!email) return false;
  try {
    return (await redis().exists(lockKey(email))) === 1;
  } catch {
    logFailOpen("lockout");
    return false;
  }
}

/** Record a failed login. Locks the account once the threshold is reached. */
export async function recordLoginFailure(email: string): Promise<void> {
  if (!email) return;
  try {
    await recordFailure(email);
  } catch {
    logFailOpen("lockout");
  }
}

async function recordFailure(email: string): Promise<void> {
  const r = redis();
  const fails = await r.incr(failKey(email));
  if (fails === 1) await r.expire(failKey(email), FAIL_WINDOW_S);

  if (fails >= FAILS_BEFORE_LOCK) {
    // Escalate: each lockout bumps the level, lengthening the next cooldown.
    const level = await r.incr(levelKey(email));
    await r.expire(levelKey(email), LOCK_LEVEL_TTL_S);
    const dur =
      LOCK_DURATIONS[Math.min(level, LOCK_DURATIONS.length) - 1] ??
      LOCK_DURATIONS[LOCK_DURATIONS.length - 1]!;
    await r.set(lockKey(email), 1, { ex: dur });
    await r.del(failKey(email)); // reset the per-window counter after locking
  }
}

/** Clear all lockout state for an account after a successful authentication. */
export async function clearLoginFailures(email: string): Promise<void> {
  if (!email) return;
  try {
    await redis().del(failKey(email), lockKey(email), levelKey(email));
  } catch {
    logFailOpen("lockout");
  }
}
