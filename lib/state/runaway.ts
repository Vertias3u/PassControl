// Redis counters for the runaway-agent package (1.9.0, lib/runaway.ts has the why).
//
// The loop breaker is ONE eval per model call, and only for an agent whose policy sets
// `loop_breaker`: an agent without it costs no command at all. Upstash's free tier
// meters commands, so the check, the count and the trip are one script.
import { redis } from "@/lib/state/redis";
import { LOOP_PAUSE_S, LOOP_WINDOW_S, SESSION_NEW_PER_HOUR, SESSION_STATE_TTL_S } from "@/lib/runaway";

const pauseKey = (agentId: string) => `loop:pause:${agentId}`;
const fingerprintKey = (agentId: string, fp: string) => `loop:fp:${agentId}:${fp}`;
const FINGERPRINT = /^[0-9a-f]{64}$/;

// KEYS[1] the agent's pause, KEYS[2] this fingerprint's count. ARGV: repeats, window ms,
// pause ms. Returns {0, count} counted, {1, ms left} paused, {2, pause ms} tripped now.
// A call refused while paused is not counted, so a pause never extends itself. The trip
// happens inside the script, so exactly one caller of a burst sees {2}.
const LOOP_LUA = `
local left = redis.call('PTTL', KEYS[1])
if left > 0 then return {1, left} end
if left == -1 then return {1, tonumber(ARGV[3])} end
local n = redis.call('INCR', KEYS[2])
if n == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[2]) end
if n >= tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], '1', 'PX', ARGV[3])
  redis.call('DEL', KEYS[2])
  return {2, tonumber(ARGV[3])}
end
return {0, n}
`;

export type LoopCheck = { state: "ok" | "paused" | "tripped"; retryAfterS: number };

/**
 * Count this call and say whether the agent's model calls are paused. null when Redis
 * cannot answer: the caller fails OPEN, because this guards against accidents and the
 * agent's own limits stay the hard line.
 */
export async function checkLoop(
  agentId: string,
  fingerprint: string,
  repeats: number,
  opts: { windowMs?: number; pauseMs?: number; redisClient?: typeof redis } = {}
): Promise<LoopCheck | null> {
  if (!FINGERPRINT.test(fingerprint)) return null;
  const windowMs = opts.windowMs ?? LOOP_WINDOW_S * 1000;
  const pauseMs = opts.pauseMs ?? LOOP_PAUSE_S * 1000;
  try {
    const out = (await (opts.redisClient ?? redis)().eval(
      LOOP_LUA,
      [pauseKey(agentId), fingerprintKey(agentId, fingerprint)],
      [String(repeats), String(windowMs), String(pauseMs)]
    )) as [number, number];
    const [code, value] = [Number(out[0]), Number(out[1])];
    if (code === 0) return { state: "ok", retryAfterS: 0 };
    const retryAfterS = Math.max(1, Math.ceil(value / 1000));
    return { state: code === 2 ? "tripped" : "paused", retryAfterS };
  } catch {
    return null;
  }
}

// ── Per-session caps ────────────────────────────────────────────────────────
//
// ONE eval per model call, and only for an agent whose policy sets `session_caps` and a
// call that declares a session. KEYS[1] the session's start (ms), KEYS[2] its call count,
// KEYS[3] the agent's new-session counter for this hour, KEYS[4] its money ledger when
// it has a money cap. ARGV: now ms, calls cap (-1 off), minutes cap (-1 off), new sessions
// per hour, idle TTL s, '1' when the session's money is capped.
// Returns {0, calls} admitted, {-1} calls, {-2} minutes, {-3} too many new sessions,
// {-4} the session's money record is not usable. Every check runs before anything is
// written, so a refused call is not counted, keeps nothing alive, and a refused NEW
// session leaves no clock behind.
//
// The money ledger has the hold's shape (`r` reserved, `s` spent, micro-cents); OPEN_LUA
// checks it and settle moves it. Its life is the session's (review 2026-11-21):
//   - made at zero when the session starts, so a session that idled out (its clock and
//     count expire a day after its last call) starts with a fresh cap, like the others;
//   - while the session lives it is never made again: one that is missing was lost, and
//     remaking it at zero would hand the session a fresh cap. That call is refused (-4);
//     the session's clock is not refreshed by it, and a new session id works at once;
//   - a session starting over a ledger a hold still reserves against (its clock was lost
//     mid-call) is refused too, since resetting it would let that hold settle into a
//     ledger that never held its reservation. Retryable: the hold settles within minutes.
const SESSION_LUA = `
local now = tonumber(ARGV[1])
local ttl = tonumber(ARGV[5])
local money = ARGV[6] == '1'
local start = redis.call('GET', KEYS[1])
local fresh = not start
if fresh then
  if tonumber(redis.call('GET', KEYS[3]) or '0') >= tonumber(ARGV[4]) then return {-3, 0} end
  if money and tonumber(redis.call('HGET', KEYS[4], 'r') or '0') ~= 0 then return {-4, 0} end
else
  if money and redis.call('EXISTS', KEYS[4]) == 0 then return {-4, 0} end
  local minutes = tonumber(ARGV[3])
  if minutes >= 0 and now - tonumber(start) >= minutes * 60000 then return {-2, 0} end
end
local c = 0
if not fresh then c = tonumber(redis.call('GET', KEYS[2]) or '0') end
local calls = tonumber(ARGV[2])
if calls >= 0 and c + 1 > calls then return {-1, c} end
if fresh then
  if redis.call('INCR', KEYS[3]) == 1 then redis.call('EXPIRE', KEYS[3], 3600) end
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
  redis.call('SET', KEYS[2], '1', 'EX', ttl)
  c = 1
  if money then
    redis.call('DEL', KEYS[4])
    redis.call('HSET', KEYS[4], 'r', '0', 's', '0')
  end
else
  redis.call('EXPIRE', KEYS[1], ttl)
  c = redis.call('INCR', KEYS[2])
  redis.call('EXPIRE', KEYS[2], ttl)
end
if money then redis.call('EXPIRE', KEYS[4], ttl + 3600) end
return {0, c}
`;

/** The declared-id rule (lib/client-lineage.ts DECLARED); nothing else becomes a key. */
const DECLARED_SESSION = /^[A-Za-z0-9._:-]{1,128}$/;
const SESSION_LEDGER_JTI = /^ses_[0-9a-f]{40}$/;

export type SessionCapCheck =
  | { ok: true; calls: number }
  | { ok: false; reason: "calls" | "minutes" | "sessions" }
  /** The session's money record is missing, or busy under an open hold: 503, retryable. */
  | { ok: false; reason: "state" };

/**
 * Count this call against its session's caps. null when Redis cannot answer or the id is
 * not one the gateway accepts: the caller fails OPEN and joins no ledger, because this
 * guards against accidents and the agent's own limits stay the hard line.
 */
export async function checkSessionCaps(
  agentId: string,
  session: string,
  opts: {
    calls?: number | null;
    minutes?: number | null;
    /** sessionLedgerJti(session), when the policy caps the session's money. */
    ledgerJti?: string;
    nowMs?: number;
    newPerHour?: number;
    redisClient?: typeof redis;
  } = {}
): Promise<SessionCapCheck | null> {
  if (!DECLARED_SESSION.test(session)) return null;
  if (opts.ledgerJti !== undefined && !SESSION_LEDGER_JTI.test(opts.ledgerJti)) return null;
  const nowMs = opts.nowMs ?? Date.now();
  const hour = Math.floor(nowMs / 3_600_000);
  // The ledger key is lib/state/holds.ts delegationLedgerKey's format, spelled here so the
  // 49 suites that mock that module still load this one; tests/session-caps.redis.test.ts
  // pins the two together through the real hold script.
  const ledgerKey = opts.ledgerJti ? `dl:${agentId}:${opts.ledgerJti}` : `dl:${agentId}:none`;
  try {
    const out = (await (opts.redisClient ?? redis)().eval(
      SESSION_LUA,
      [`sst:${agentId}:${session}`, `scl:${agentId}:${session}`, `ssnew:${agentId}:${hour}`, ledgerKey],
      [
        String(nowMs),
        String(opts.calls ?? -1),
        String(opts.minutes ?? -1),
        String(opts.newPerHour ?? SESSION_NEW_PER_HOUR),
        String(SESSION_STATE_TTL_S),
        opts.ledgerJti ? "1" : "0",
      ]
    )) as [number, number];
    const code = Number(out[0]);
    if (code === 0) return { ok: true, calls: Number(out[1]) };
    if (code === -1) return { ok: false, reason: "calls" };
    if (code === -2) return { ok: false, reason: "minutes" };
    if (code === -3) return { ok: false, reason: "sessions" };
    if (code === -4) return { ok: false, reason: "state" };
    return null;
  } catch {
    return null;
  }
}
