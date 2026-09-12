// One attempt, one durable record of what it reserved.
//
// ── The problem this replaces ────────────────────────────────────────────────
//
// The gateway used to hold money in two per-request marker keys with a TTL, and
// every consumer of that reservation guessed at the rest. Three defects fell out
// of the same root:
//
//   * The reconcile cron `SET` `spent:` from a lagged RPC total, erasing live
//     spend settled inside the lag window, and rebuilt `reserved:` from a
//     non-atomic SCAN+MGET that raced concurrent reservations.
//   * Settlement ran as a raw pipeline with nothing keyed on the attempt, while
//     `Redis.fromEnv()` takes @upstash/redis's default `retries ?? 5` — so a
//     fetch that threw AFTER the server had executed replayed the whole delta.
//   * A stream that broke after delivering content settled at zero, refunding
//     the entire hold for tokens the provider had actually generated.
//
// ── The rule that replaces them ─────────────────────────────────────────────
//
// EVERY TRANSITION IS ONE LUA EVAL, IDEMPOTENT ON THE ATTEMPT ID. That is the
// whole design. Redis executes a script atomically, so a transition cannot
// interleave with another; keying it on the attempt makes a replay a no-op
// rather than a second delta; and computing the release from the STORED estimate
// means settlement can no longer be handed an estimate that disagrees with what
// was actually reserved.
//
// AN OPEN HOLD NEVER EXPIRES. Expiry must never be the thing that releases
// money — self-heal-by-expiry *was* the bug. A hold gets a TTL only once it is
// terminal, and then only so that a replayed settle reads as "already settled"
// rather than as a settle against a hold that never existed. 900s is far past
// any transport retry or `waitUntil` window.
//
// The counters `spent:` / `reserved:` are written here and, for `spent:` only,
// by the monotone raise in lib/reconcile.ts. Nothing else may SET them. That is
// why `getSpent`/`setSpent`/`setReserved` are gone rather than kept "just in
// case": they were the non-atomic escape hatches this module exists to close.
import type { Redis } from "@upstash/redis";
import { redis } from "./redis";
import { serviceClient } from "../supabase";

/**
 * The client a call should use.
 *
 * The hot path always wants the shared one. `runReconcile` is handed a client by
 * its caller so the cron stays testable, and passing it through keeps that
 * contract honest rather than having one function in the module quietly reach
 * for a different connection than the one it was given.
 */
type Client = Pick<Redis, "eval" | "zcard" | "mget" | "pipeline">;
const on = (client?: Client): Client => client ?? redis();

/**
 * How long a terminal hold's record survives, so a replayed settle is LEGIBLE.
 *
 * This is not a release mechanism and must never become one. It exists so that
 * a settle arriving twice — a transport retry, a re-run `waitUntil` — finds the
 * record and returns "already settled" instead of finding nothing and being
 * indistinguishable from a settle against an attempt that never opened. The
 * latter is an anomaly worth counting; the former is routine.
 */
export const HOLD_TOMBSTONE_TTL_S = 900;

/**
 * How many open holds one rebuild reads. Only the seed branch depends on the
 * sum being complete, and an agent with this many abandoned attempts has a
 * problem a rebuild is not the answer to.
 */
const REBUILD_HOLD_SCAN_LIMIT = 1000;

const k = {
  reserved: (agid: string) => `reserved:${agid}`,
  spent: (agid: string) => `spent:${agid}`,
  reservedCost: (agid: string) => `reserved_cost:${agid}`,
  spentCost: (agid: string) => `spent_cost:${agid}`,
  hold: (agid: string, attemptId: string) => `hold:${agid}:${attemptId}`,
  holds: (agid: string) => `holds:${agid}`,
  epoch: (agid: string) => `epoch:${agid}`,
  /**
   * The ACCOUNTING FORMAT TAG. Present only on state written by a version that
   * seeds all four counters at mint.
   *
   * Without it a missing counter is undecidable: `reserved:` is created by
   * INCRBY on the first successful open, so an agent that minted and was then
   * refused by its cap legitimately has none — and refusing that agent would
   * brick it forever. The tag is what lets "this counter was never written" be
   * told apart from "this counter was lost".
   */
  fmt: (agid: string) => `acctfmt:${agid}`,
};

/** The only accounting format this build can reason about. */
const ACCT_FORMAT = "1";

/**
 * The hold hash. Short field names because every one of them is written on the
 * hot path, and the meanings live here rather than in the Lua.
 *
 *   st — state: open | settled | released | resolved
 *   et/ec — ESTIMATE, tokens and micro-cents. What was reserved.
 *   kt/kc — KNOWN. What the provider actually reported, as observed.
 *   at/ac — APPLIED. What actually moved into `spent:`.
 *   oc — outcome that closed it.
 *   cr — created, epoch ms.
 *
 * `at`/`ac` are load-bearing rather than redundant: operator resolution computes
 * its delta from the stored record, and without the applied figures ALONGSIDE
 * the estimate the arithmetic is underdetermined — a resolution would have to
 * guess whether a previous transition had already moved money, and guessing
 * wrong double-applies or under-applies.
 */
export type HoldState = "open" | "settled" | "released" | "resolved";

/** Why an attempt ended. Decides what gets applied; see `settle` below. */
export type HoldOutcome =
  /** Usage was reported and the accounting is confirmed complete. */
  | "complete"
  /** The attempt may have been billed and nobody can say for how much. */
  | "usage_unknown"
  /** Provably never sent upstream. Nothing was consumed. */
  | "not_dispatched"
  /** An operator decided, through the control plane. */
  | "resolved";

export interface OpenHoldResult {
  ok: boolean;
  /**
   * `tokens` / `cost` are CAP denials — the agent is out of budget, answered
   * 402. `state` is not: it means the hot-path counters were lost and the
   * gateway declines to invent a starting balance, answered 503. They must
   * never be conflated. An agent told 402 reads it as "I am out of budget" and
   * stops retrying, which is the wrong response to an operator-recoverable
   * infrastructure fault. See the early return in the proxy.
   */
  reason?: "tokens" | "cost" | "state";
  reserved?: number;
  reservedMicrocents?: number;
  /** True when this exact attempt id had already opened — a transport replay. */
  replay?: boolean;
  /**
   * The epoch REDIS NOW HOLDS for this agent, present only while Postgres has
   * not yet recorded that budget state was established. The caller owes Postgres
   * exactly this value — never a freshly generated one.
   *
   * That distinction is the whole point of the field. Two calls can race the
   * first initialisation, and a call can arrive after a mint whose Postgres
   * write was lost; in both cases an epoch already exists and the correct action
   * is to persist THAT. Persisting anything else makes Postgres and Redis
   * disagree permanently, and the next call refuses on a mismatch the operator
   * cannot explain — an agent bricked by its own first request.
   *
   * Until this lands in Postgres a Redis flush for this agent is not detectable.
   * That window is deliberately the one in which the agent has spent nothing,
   * and it closes when the write lands AND the agent-policy cache is purged.
   */
  epochToPersist?: string;
}

export interface SettleResult {
  /** False when the transition was a no-op: a replay, or no hold at all. */
  applied: boolean;
  appliedTokens: number;
  appliedMicrocents: number;
  /**
   * A settle arrived for an attempt with NO hold record at all — not an open
   * one, not a tombstone. Never produces a delta. Worth counting because it
   * means an attempt settled twice more than 900s apart, or settled against an
   * id that never opened, and both say something is wrong upstream of here.
   */
  anomaly?: boolean;
  /** A transition contradicted immutable attempt state and moved no money. */
  conflict?: boolean;
  /**
   * The hold closed, but this agent's counters were gone, so NOTHING was added
   * to them. The charge is still in the audit row and `appliedTokens` /
   * `appliedMicrocents` still say what it was — the debit is deferred to
   * `rebuildBudgetState`, which sums the ledger. Until an operator runs that
   * rebuild the agent cannot open another hold at all, so this is loud and
   * fail-closed rather than silent; it is a page, not a metric.
   */
  degraded?: boolean;
}

// ── open ─────────────────────────────────────────────────────────────────────
//
// KEYS: reserved, spent, reserved_cost, spent_cost, hold, holds, epoch
// ARGV: 1 tokenCap  2 tokenEstimate  3 costCap  4 costEstimate
//       5 attemptId 6 nowMs          7 expectedEpoch  8 dbEstablished
//       9 mintEpoch 10 provider      11 model
//
// `provider` and `model` are WRITTEN AND NEVER READ by any transition. They are
// there for one reader: the operator resolving a hold that no ending ever
// closed. That case has no agent_logs row and therefore no receipt — the row is
// written by the settlement path, which is exactly the path that did not run —
// and the attempt id appears nowhere else in the product. Without these two
// fields the recovery surface hands a human a uuid, a timestamp and two
// estimates, and asks them to find the matching line on a provider's billing
// dashboard. With them it is a lookup.
//
// Returns { code, reservedTokens, reservedCost, liveEpoch }:
//    1 opened   2 replay   -1 token cap   -2 cost cap   -3 budget state lost
//
// `liveEpoch` is the epoch REDIS ACTUALLY HOLDS, not the one this call offered.
// The caller persists that value and nothing else. Returning the offered mint
// instead was a real defect: on the branch where an epoch already existed but
// Postgres had not recorded it yet, the caller wrote a DIFFERENT uuid to
// Postgres, and every later call then compared that against the live one,
// mismatched, and refused — bricking the agent permanently through an ordinary
// first-init retry.
const OPEN_LUA = `
local tokenCap      = tonumber(ARGV[1])
local tokenEstimate = tonumber(ARGV[2])
local costCap       = tonumber(ARGV[3])
local costEstimate  = tonumber(ARGV[4])
local attemptId     = ARGV[5]
local nowMs         = ARGV[6]
local expectedEpoch = ARGV[7]
local dbEstablished = ARGV[8]
local mintEpoch     = ARGV[9]
local provider      = ARGV[10]
local model         = ARGV[11]
local fmtVersion    = ARGV[12]

-- BUDGET-STATE CHECK FIRST, before the replay short-circuit. State loss is a
-- fact about the agent, not about this attempt, so it must be answered the same
-- way whether or not this particular attempt has been seen before.
--
-- Only for agents that are actually budgeted; the caller passes
-- dbEstablished = '-' for the rest, and an unbudgeted agent has nothing to
-- enforce and no counters worth protecting.
local epochOut = ''
-- The generation this hold belongs to, stamped onto the record so every later
-- transition can be checked against it. Empty for an unbudgeted agent, which
-- has no generation and nothing to fence.
local holdEpoch = ''
if dbEstablished ~= '-' then
  local liveEpoch = redis.call('GET', KEYS[7])
  if dbEstablished == '1' then
    -- Postgres says counters for this agent were established once. So an absent
    -- or disagreeing epoch means they were LOST, and re-seeding from any mirror
    -- would hand back the difference as spendable capacity. Refuse instead; an
    -- operator rebuilds from the audit trail, which is authoritative.
    if liveEpoch == false or liveEpoch ~= expectedEpoch then
      return {-3, 0, 0, ''}
    end
    -- The epoch agreeing proves the generation, not the counters. Eviction
    -- takes keys one at a time, and a counter defaulted to zero on a missing
    -- key is a silent refund of everything the agent had spent. Refuse
    -- instead; an operator recovers explicitly.
    if redis.call('GET', KEYS[8]) ~= fmtVersion then
      -- State written before this format existed, or by a newer one. Either
      -- way this build cannot vouch for what the counters mean.
      return {-3, 0, 0, ''}
    end
    if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 0
       or redis.call('EXISTS', KEYS[3]) == 0 or redis.call('EXISTS', KEYS[4]) == 0 then
      return {-3, 0, 0, ''}
    end
    holdEpoch = liveEpoch
  elseif dbEstablished == '2' then
    -- LEGACY CUTOVER (0057). Postgres records that this agent was already
    -- spending before generations existed: established_at is set and the epoch
    -- is still NULL, a pair no writer produces. So there IS state to protect,
    -- and no generation to compare it against. The rule is therefore: adopt
    -- what is actually here, and refuse if what the caps enforce is gone.
    --
    -- Absent format tag is the pre-0055 state, whose two spend counters carry
    -- exactly the meaning this build reads them with -- that is the only prior
    -- format. A DIFFERENT tag is one it cannot vouch for.
    local liveFmt = redis.call('GET', KEYS[8])
    if liveFmt ~= false and liveFmt ~= fmtVersion then
      return {-3, 0, 0, ''}
    end
    -- Only the dimensions this agent is actually capped on. The cost counters
    -- arrived in 0010, so a token-only agent dormant since before that never
    -- had spent_cost and must not be refused for its absence; an agent WITH a
    -- cost cap and no counter has lost the number that cap is enforced against.
    if tokenCap >= 0 and redis.call('EXISTS', KEYS[2]) == 0 then
      return {-3, 0, 0, ''}
    end
    if costCap >= 0 and redis.call('EXISTS', KEYS[4]) == 0 then
      return {-3, 0, 0, ''}
    end
    if liveEpoch == false then
      redis.call('SET', KEYS[7], mintEpoch)
      epochOut = mintEpoch
      holdEpoch = mintEpoch
    else
      -- The mint landed on an earlier call and Postgres has not read it back.
      -- Report what EXISTS, never what this call offered.
      epochOut = liveEpoch
      holdEpoch = liveEpoch
    end
    -- NX, so the counters found above keep the agent's real history. This only
    -- fills the dimensions the legacy format never wrote, which is what makes
    -- the four-counter presence check safe on every call after this one.
    redis.call('SET', KEYS[1], 0, 'NX')
    redis.call('SET', KEYS[2], 0, 'NX')
    redis.call('SET', KEYS[3], 0, 'NX')
    redis.call('SET', KEYS[4], 0, 'NX')
    redis.call('SET', KEYS[8], fmtVersion)
  elseif liveEpoch == false then
    -- Postgres has no record that state was ever established, so there is
    -- nothing to protect yet and this is a genuine first initialisation. Mint,
    -- and seed both dimensions at zero: an agent newly given a budget starts
    -- enforcement at zero deliberately, whatever its prior agent_logs history.
    -- Enforcement begins when the budget does.
    redis.call('SET', KEYS[7], mintEpoch)
    -- ALL FOUR, not just the two spend counters. The reservation counters used
    -- to spring into existence on the first INCRBY, which left a minted agent
    -- that was refused by its cap holding two of four — indistinguishable from
    -- an agent that had lost two. Seeding here is what makes the presence check
    -- above safe to enforce.
    redis.call('SET', KEYS[1], 0, 'NX')
    redis.call('SET', KEYS[2], 0, 'NX')
    redis.call('SET', KEYS[3], 0, 'NX')
    redis.call('SET', KEYS[4], 0, 'NX')
    redis.call('SET', KEYS[8], fmtVersion)
    epochOut = mintEpoch
    holdEpoch = mintEpoch
  else
    -- An epoch is already here while Postgres still says nothing — the mint
    -- landed and the Postgres write did not, or has not been read back yet.
    -- Report the LIVE value so the caller persists what actually exists. Minting
    -- a second one here, or reporting the one this call offered, is what bricks
    -- the agent.
    --
    -- BUT AN EPOCH BEING HERE MEANS INITIALISATION ALREADY HAPPENED, so this is
    -- no longer a first call and the counters are no longer worthless. The
    -- caller's established flag rides in the agent-policy CACHE, whose purge
    -- after the first call is a fire-and-forget whose result the route ignores —
    -- so a stale 'false' can arrive here for an agent that has been spending for
    -- days. Without the checks below, one evicted counter then read as a zero
    -- balance and the agent got its whole spend back as capacity.
    --
    -- Identical to the established == '1' branch above, deliberately: which
    -- state is protected must not depend on how fresh a cache entry happens to
    -- be. The ONLY thing that decides whether counters are protected is whether
    -- an epoch exists, and it does.
    if redis.call('GET', KEYS[8]) ~= fmtVersion then
      return {-3, 0, 0, ''}
    end
    if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 0
       or redis.call('EXISTS', KEYS[3]) == 0 or redis.call('EXISTS', KEYS[4]) == 0 then
      return {-3, 0, 0, ''}
    end
    epochOut = liveEpoch
    holdEpoch = liveEpoch
  end
end

-- A hold that already exists is a TRANSPORT REPLAY of this same attempt. Return
-- what is there and touch no counter. This is the property that makes the whole
-- client-side retry default (retries ?? 5) harmless.
if redis.call('EXISTS', KEYS[5]) == 1 then
  local rt = tonumber(redis.call('GET', KEYS[1]) or '0')
  local rc = tonumber(redis.call('GET', KEYS[3]) or '0')
  return {2, rt, rc, epochOut}
end

local spentTokens = tonumber(redis.call('GET', KEYS[2]) or '0')
local spentCost   = tonumber(redis.call('GET', KEYS[4]) or '0')
local reservedTokens = tonumber(redis.call('GET', KEYS[1]) or '0') + tokenEstimate
local reservedCost   = tonumber(redis.call('GET', KEYS[3]) or '0') + costEstimate

-- A cap of ZERO refuses unconditionally, including an estimate of zero. A call
-- that is forwarded can always spend, so "you may spend nothing" cannot mean
-- "you may make free calls" — and the arithmetic alone would admit it, since
-- 0 > 0 is false.
-- THE EPOCH RIDES OUT ON A DENIAL TOO. A first call refused by its cap has
-- still minted, and if Postgres never learns that epoch the loss check cannot
-- fire on the calls that follow. The caller persists whatever comes back here
-- regardless of the verdict.
if tokenCap >= 0 and (tokenCap == 0 or (reservedTokens + spentTokens) > tokenCap) then
  return {-1, 0, 0, epochOut}
end
if costCap >= 0 and (costCap == 0 or (reservedCost + spentCost) > costCap) then
  return {-2, 0, 0, epochOut}
end

redis.call('INCRBY', KEYS[1], tokenEstimate)
redis.call('INCRBY', KEYS[3], costEstimate)
-- NO TTL. An open hold outlives everything; only a terminal one gets one.
redis.call('HSET', KEYS[5],
  'st', 'open',
  -- ph is deliberately separate from terminal state. A hold may be open
  -- while dispatch permission has been consumed: it is then ambiguous, so an
  -- operator must never turn it into a not-dispatched release.
  'ph', 'pre_dispatch',
  'et', tokenEstimate,
  'ec', costEstimate,
  'cr', nowMs,
  'ep', holdEpoch,
  'pv', provider,
  'md', model)
redis.call('ZADD', KEYS[6], nowMs, attemptId)
return {1, reservedTokens, reservedCost, epochOut}
`;

// ── settle ───────────────────────────────────────────────────────────────────
//
// KEYS: reserved, spent, reserved_cost, spent_cost, hold, holds
// ARGV: 1 attemptId 2 outcome 3 knownTokens 4 knownMicrocents 5 tombstoneTtl
//       6 token certainty (known|unknown) 7 money certainty (known|unknown)
//
// Returns { code, appliedTokens, appliedMicrocents }:
//    1 applied   0 replay (already terminal)   -1 no hold at all
//   -2 refused (wrong generation, or relabelling a dispatched attempt)
//    3 hold closed but NO counter moved -- this generation's counters are gone.
//      Returned again on every replay, so the caller's ledger write is retryable.
const SETTLE_LUA = `
local attemptId    = ARGV[1]
local outcome      = ARGV[2]
local knownTokens  = tonumber(ARGV[3])
local knownCost    = tonumber(ARGV[4])
local tombstoneTtl = tonumber(ARGV[5])
local tokenCertainty = ARGV[6]
local moneyCertainty = ARGV[7]

local state = redis.call('HGET', KEYS[5], 'st')

-- NO HOLD ⇒ NO DELTA, EVER. Not even a "safe-looking" one: a settle with
-- nothing to settle against cannot know what was reserved, and guessing is how
-- the old code created capacity. The caller counts this as an anomaly.
if state == false then
  return {-1, 0, 0}
end

-- Already terminal ⇒ this is a replay. Return what the first transition applied,
-- so the caller sees the same answer it saw the first time.
if state ~= 'open' then
  local at = tonumber(redis.call('HGET', KEYS[5], 'at') or '0')
  local ac = tonumber(redis.call('HGET', KEYS[5], 'ac') or '0')
  -- A REPLAY OF A DEGRADED SETTLE IS STILL DEGRADED, and saying so is what makes
  -- the caller's ledger write retryable. That write is the only record of this
  -- charge -- the counters it would have moved are gone -- so if it fails, the
  -- operator has to be able to run the same resolve again and have it retried.
  -- Reporting a plain replay here would tell them it was already handled.
  if redis.call('HGET', KEYS[5], 'dg') == '1' then return {3, at, ac} end
  return {0, at, ac}
end

-- THE RELEASE COMES FROM THE STORED ESTIMATE, never from the caller. This is
-- what makes it impossible to settle against an estimate that disagrees with
-- what was reserved — the defect class that let reserved: drift.
local estTokens = tonumber(redis.call('HGET', KEYS[5], 'et') or '0')
local estCost   = tonumber(redis.call('HGET', KEYS[5], 'ec') or '0')

-- THE GENERATION THIS HOLD BELONGS TO MUST STILL BE THE CURRENT ONE. A rebuild
-- writes a new epoch and recomputes both counters from the record; a worker that
-- opened before it and settles after it would otherwise apply a debit against
-- counters that no longer describe its reservation, or release capacity the
-- rebuild has already accounted for.
--
-- An EMPTY stamp is not fenced. Unbudgeted agents have no generation, and holds
-- written before this field existed carry none — refusing those would strand
-- money in holds that could never close, which is the failure this subsystem is
-- supposed to prevent rather than cause.
--
-- A DAMAGED GENERATION IS NOT HEALED HERE, and this is why the same presence
-- check that guards admission has to guard settlement too. DECRBY and INCRBY
-- both CREATE a missing key: a settle against counters that were lost wrote
-- spent: back at what this one attempt cost, and reserved: back at MINUS its
-- estimate. Admission's check then saw four counters present again and let the
-- agent spend its whole cap a second time -- so the guard above it held for
-- exactly as long as it took the in-flight request to finish.
--
-- Only for a stamped hold. An empty stamp means an unbudgeted agent, which was
-- never seeded any counters and whose settle legitimately creates spent: on
-- first use; enforcing presence there would refuse every settle it ever makes.
local degraded = 0
local holdEpoch = redis.call('HGET', KEYS[5], 'ep')
if holdEpoch and holdEpoch ~= false and holdEpoch ~= '' then
  if redis.call('GET', KEYS[7]) ~= holdEpoch then
    return {-2, 0, 0}
  end
  if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 0
     or redis.call('EXISTS', KEYS[3]) == 0 or redis.call('EXISTS', KEYS[4]) == 0 then
    degraded = 1
  end
end

-- Once dispatch permission is consumed, a human or a late error handler cannot
-- relabel the attempt as "never sent". The winner may have reached upstream
-- before its acknowledgement was lost; that ambiguity retains capacity.
if outcome == 'not_dispatched' and redis.call('HGET', KEYS[5], 'ph') ~= 'pre_dispatch' then
  return {-2, 0, 0}
end

local function applied(known, estimate, certainty)
  if certainty == 'known' then return known end
  return known > estimate and known or estimate
end

local appliedTokens, appliedCost, newState
if outcome == 'complete' then
  -- A provider can report complete tokens while the cost cannot be priced (for
  -- example, a custom endpoint). Settling that money dimension at zero would
  -- invent a free call, so certainty is deliberately independent.
  appliedTokens = applied(knownTokens, estTokens, tokenCertainty)
  appliedCost = applied(knownCost, estCost, moneyCertainty)
  newState = 'settled'
elseif outcome == 'usage_unknown' then
  -- UNCERTAINTY FAILS CLOSED. The provider may have billed for work we cannot
  -- measure, so charge the greater of what we saw and what we reserved. A
  -- partial tally must never become a refund of the difference.
  appliedTokens = knownTokens > estTokens and knownTokens or estTokens
  appliedCost   = knownCost   > estCost   and knownCost   or estCost
  newState = 'settled'
elseif outcome == 'not_dispatched' then
  -- Provably never sent upstream. This is the ONLY outcome that releases the
  -- whole hold, and it is reserved for attempts that cannot have been billed.
  appliedTokens, appliedCost, newState = 0, 0, 'released'
else
  appliedTokens, appliedCost, newState = knownTokens, knownCost, 'resolved'
end

-- THE HOLD STILL CLOSES. Refusing the transition instead would leave an open
-- hold that no later call can ever settle -- a rebuild rewrites the epoch, and
-- from then on the fence above refuses this attempt forever, in both operator
-- directions -- which is the money-stranded-in-an-unclosable-hold failure this
-- subsystem exists to prevent. What is skipped is the counter movement, and
-- only that: the charge is in the audit row either way, and rebuild_agent_spend
-- sums the ledger, so the debit is deferred to the recovery rather than lost.
if degraded == 0 then
  redis.call('DECRBY', KEYS[1], estTokens)
  redis.call('DECRBY', KEYS[3], estCost)
  if appliedTokens > 0 then redis.call('INCRBY', KEYS[2], appliedTokens) end
  if appliedCost   > 0 then redis.call('INCRBY', KEYS[4], appliedCost) end
end

redis.call('HSET', KEYS[5],
  'st', newState,
  'kt', knownTokens,
  'kc', knownCost,
  'at', appliedTokens,
  'ac', appliedCost,
  'oc', outcome)
if degraded == 1 then redis.call('HSET', KEYS[5], 'dg', '1') end
redis.call('EXPIRE', KEYS[5], tombstoneTtl)
redis.call('ZREM', KEYS[6], attemptId)
return {degraded == 1 and 3 or 1, appliedTokens, appliedCost}
`;

// ── dispatch permission ────────────────────────────────────────────────────
//
// Opening a hold reserves capacity; it does not license every observer of a
// retried request to send upstream. Exactly one caller atomically changes the
// attempt from pre_dispatch to dispatch_may_have_happened immediately before
// fetch. A lost reply is therefore conservative: the caller cannot know whether
// it won, so it keeps the hold and must not send again.
const DISPATCH_LUA = `
local state = redis.call('HGET', KEYS[1], 'st')
if state == false then return {-1} end
if state ~= 'open' then return {-2} end
if redis.call('HGET', KEYS[1], 'ph') ~= 'pre_dispatch' then return {0} end
redis.call('HSET', KEYS[1], 'ph', 'dispatch_may_have_happened')
return {1}
`;

/**
 * Raise `spent:` toward a floor, never lower it. Both dimensions, one eval.
 *
 * The `max` is done SERVER-SIDE deliberately. A read-then-set from the edge
 * races a concurrent settle and can lower the counter — which is the original
 * bug wearing a different hat. This can only ever recover a settle whose Redis
 * write was lost; it can never create capacity.
 */
// ── rebase (operator rebuild) ────────────────────────────────────────────────
//
// KEYS: epoch, spent, spent_cost, reserved, reserved_cost
// ARGV: 1 epoch 2 spentTokens 3 spentMicrocents 4 seedReserved 5 seedReservedCost
//
// Returns { liveReservedTokens, liveReservedCost, seeded }.
//
// The reserved writes are NX and the spend writes are not. See
// rebuildBudgetState for why that asymmetry is the whole safety property.
const REBASE_LUA = `
local seeded = 0
-- THE FORMAT TAG IS PART OF THE REBUILD, not an afterthought. This is the
-- sanctioned operator recovery from lost accounting; if it wrote counters
-- without the tag, the very next call would see established-but-untagged state
-- and refuse — a recovery path whose output its own admission check rejects.
redis.call('SET', KEYS[6], ARGV[6])
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SET', KEYS[3], ARGV[3])
if redis.call('SET', KEYS[4], ARGV[4], 'NX') then seeded = 1 end
if redis.call('SET', KEYS[5], ARGV[5], 'NX') then seeded = seeded + 2 end
local rt = tonumber(redis.call('GET', KEYS[4]) or '0')
local rc = tonumber(redis.call('GET', KEYS[5]) or '0')
return {rt, rc, seeded}
`;

const RAISE_LUA = `
local floorTokens = tonumber(ARGV[1])
local floorCost   = tonumber(ARGV[2])
-- A MISSING COUNTER IS NOT A ZERO ONE, and this is the one path allowed to
-- write spend. Reading an absent key as zero would make max(0, floor) = floor
-- and WRITE it, establishing lost accounting from a lagged, incomplete
-- agent_logs total. That is exactly what "never initialize from an incomplete
-- audit sum" forbids, arriving through the cron, on a schedule, unnoticed.
if redis.call('EXISTS', KEYS[1]) == 0 or redis.call('EXISTS', KEYS[2]) == 0 then
  return {0, 0, 0}
end
local curTokens = tonumber(redis.call('GET', KEYS[1]) or '0')
local curCost   = tonumber(redis.call('GET', KEYS[2]) or '0')
local raised = 0
if floorTokens > curTokens then redis.call('SET', KEYS[1], floorTokens) raised = 1 end
if floorCost   > curCost   then redis.call('SET', KEYS[2], floorCost)   raised = 1 end
return {raised, curTokens, curCost}
`;

const int = (v: number | null | undefined, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
};

/**
 * Normalise a script's reply to a fixed triple.
 *
 * A TUPLE rather than an array, so destructuring cannot hand a caller
 * `number | undefined` and quietly turn a missing element into `NaN` inside an
 * amount that is about to move money. Redis returns integers here; the coercion
 * is belt-and-braces against a transport that hands back strings.
 */
const codes = (res: unknown): [number, number, number] => {
  const a = Array.isArray(res) ? res : [res];
  return [Number(a[0]) || 0, Number(a[1]) || 0, Number(a[2]) || 0];
};

/**
 * Open a hold for one attempt, or refuse.
 *
 * `attemptId` is the idempotence key and must be unique per ATTEMPT, not per
 * request: a failover makes two attempts under one visa, and they are two
 * separate holds against the same budget.
 */
export async function openHold(params: {
  agentId: string;
  attemptId: string;
  estimate: number;
  estimateMicrocents?: number;
  capTokens: number | null; // null = unlimited
  capMicrocents?: number | null; // null = no cost cap
  /**
   * The agent's budget epoch as Postgres has it, and whether Postgres records
   * that counters were ever established. Both ride in the agent-policy cache
   * the proxy already reads per call, so the check costs no extra round trip
   * and cannot race a concurrent flush — it is evaluated inside the same script
   * that moves the money.
   *
   * Pass `established: false` for an agent Postgres has no record of, which is
   * also the correct posture during the cutover window. Omit the whole object
   * for an unbudgeted agent.
   */
  budgetState?: { epoch: string | null; established: boolean };
  /**
   * What this attempt is about to call. Recorded on the hold and read by nothing
   * in the hot path — see OPEN_LUA. It exists so an operator resolving an
   * abandoned hold can find the call on the provider's own dashboard, which for
   * that population is the only evidence there is.
   */
  provider?: string;
  model?: string;
}): Promise<OpenHoldResult> {
  const tokenCap = params.capTokens == null ? -1 : Math.max(0, Math.floor(params.capTokens));
  const costCap = params.capMicrocents == null ? -1 : Math.max(0, Math.round(params.capMicrocents));
  const tokenEstimate = int(params.estimate);
  const costEstimate = int(params.estimateMicrocents ?? 0);
  const tracksCost = params.estimateMicrocents != null || params.capMicrocents != null;
  // '-' rather than a boolean: the script has to tell "not budgeted, do not
  // check" apart from "budgeted and not yet established", and those two take
  // different branches.
  // '-' not budgeted, nothing to enforce. '0' budgeted and never established:
  // genuine first-init, seed zero. '1' established WITH a generation to fence
  // against. '2' established with none — 0057's cutover marker for an agent
  // that was already spending before generations existed, whose counters are
  // adopted if present and refused if lost.
  const established = params.budgetState
    ? params.budgetState.established
      ? params.budgetState.epoch
        ? "1"
        : "2"
      : "0"
    : "-";
  const mintEpoch = crypto.randomUUID();

  const res = await redis().eval(
    OPEN_LUA,
    [
      k.reserved(params.agentId),
      k.spent(params.agentId),
      k.reservedCost(params.agentId),
      k.spentCost(params.agentId),
      k.hold(params.agentId, params.attemptId),
      k.holds(params.agentId),
      k.epoch(params.agentId),
      k.fmt(params.agentId),
    ],
    [
      String(tokenCap),
      String(tokenEstimate),
      String(costCap),
      String(costEstimate),
      params.attemptId,
      String(Date.now()),
      params.budgetState?.epoch ?? "",
      established,
      mintEpoch,
      params.provider ?? "",
      params.model ?? "",
      ACCT_FORMAT,
    ]
  );

  const [code, reserved, reservedCost] = codes(res);
  // Read before the denials return, because a FIRST call refused by its cap has
  // still minted an epoch and Postgres still has to learn it. Dropping it here
  // is how an agent ends up with live counters that the loss check can never
  // protect, since that check only enforces for agents Postgres calls
  // established.
  const liveEpoch = Array.isArray(res) ? String(res[3] ?? "") : "";
  const denied = (reason: "tokens" | "cost" | "state"): OpenHoldResult =>
    liveEpoch ? { ok: false, reason, epochToPersist: liveEpoch } : { ok: false, reason };
  if (code === -1) return denied("tokens");
  if (code === -2) return denied("cost");
  // A state refusal deliberately carries NO epoch: the whole point is that this
  // build cannot vouch for what is in Redis, so it must not ask Postgres to
  // record any of it. The script returns an empty string on that branch anyway;
  // this says why rather than relying on it.
  if (code === -3) return { ok: false, reason: "state" };

  const out: OpenHoldResult = tracksCost
    ? { ok: true, reserved, reservedMicrocents: reservedCost }
    : { ok: true, reserved };
  if (code === 2) out.replay = true;
  // Straight from the script, so it is what Redis holds rather than what this
  // call offered. Non-empty only while Postgres has yet to record the agent's
  // budget state — see the field's doc comment for why the difference matters.
  if (liveEpoch) out.epochToPersist = liveEpoch;
  return out;
}

async function settle(
  agentId: string,
  attemptId: string,
  outcome: HoldOutcome,
  knownTokens: number,
  knownMicrocents: number,
  tokenCertainty: "known" | "unknown" = outcome === "complete" ? "known" : "unknown",
  moneyCertainty: "known" | "unknown" = outcome === "complete" ? "known" : "unknown"
): Promise<SettleResult> {
  const res = await redis().eval(
    SETTLE_LUA,
    [
      k.reserved(agentId),
      k.spent(agentId),
      k.reservedCost(agentId),
      k.spentCost(agentId),
      k.hold(agentId, attemptId),
      k.holds(agentId),
      k.epoch(agentId),
    ],
    [
      attemptId,
      outcome,
      String(int(knownTokens)),
      String(int(knownMicrocents)),
      String(HOLD_TOMBSTONE_TTL_S),
      tokenCertainty,
      moneyCertainty,
    ]
  );
  const [code, appliedTokens, appliedMicrocents] = codes(res);
  if (code === -1) return { applied: false, appliedTokens: 0, appliedMicrocents: 0, anomaly: true };
  if (code === -2) return { applied: false, appliedTokens: 0, appliedMicrocents: 0, conflict: true };
  // THE FIGURES SURVIVE EVEN THOUGH THE COUNTERS DID NOT, and they have to.
  // Callers write them to the audit row as the enforced amount, and
  // `agent_log_spend_rows` reads `coalesce(enforced_tokens, observed)` — so
  // reporting zero here would record a free call in the one place the rebuild
  // reads, turning lost Redis state into permanently lost money.
  if (code === 3)
    return { applied: false, appliedTokens, appliedMicrocents, degraded: true };
  return { applied: code === 1, appliedTokens, appliedMicrocents };
}

/**
 * The attempt completed and the provider reported its usage. Charge exactly what
 * was reported.
 */
export function settleKnown(params: {
  agentId: string;
  attemptId: string;
  tokens: number;
  microcents: number;
  /** Defaults to known; unpriceable money is settled conservatively instead. */
  tokenCertainty?: "known" | "unknown";
  moneyCertainty?: "known" | "unknown";
}): Promise<SettleResult> {
  return settle(
    params.agentId,
    params.attemptId,
    "complete",
    params.tokens,
    params.microcents,
    params.tokenCertainty,
    params.moneyCertainty
  );
}

export interface DispatchPermissionResult {
  granted: boolean;
  reason?: "already_dispatched" | "terminal" | "missing";
}

/**
 * Atomically consume this attempt's one-use provider-dispatch permission.
 *
 * Call this as the final operation before `fetch`. A `false` reply is never a
 * license to retry the upstream request: the winning caller may already have
 * sent it, even if its response was lost.
 */
export async function consumeDispatchPermission(params: {
  agentId: string;
  attemptId: string;
}): Promise<DispatchPermissionResult> {
  const res = await redis().eval(
    DISPATCH_LUA,
    [k.hold(params.agentId, params.attemptId)],
    [params.attemptId]
  );
  const [code] = codes(res);
  if (code === 1) return { granted: true };
  if (code === 0) return { granted: false, reason: "already_dispatched" };
  if (code === -1) return { granted: false, reason: "missing" };
  return { granted: false, reason: "terminal" };
}

/**
 * The attempt ended without a confirmed accounting — a broken stream, a clean
 * close that never reported usage, a dispatch that got no answer. Charges
 * `max(observed, estimate)` and CLOSES the hold.
 *
 * Closing it is the decision that was taken deliberately: the held capacity
 * stays consumed, which is what protects the budget, while the record stops
 * being an open liability an operator has to resolve by hand. The open-hold path
 * is reserved for attempts where no ending ever ran at all.
 */
export function settleUnknown(params: {
  agentId: string;
  attemptId: string;
  /** What was observed, if anything. The script keeps the greater figure. */
  tokens: number;
  microcents: number;
}): Promise<SettleResult> {
  return settle(params.agentId, params.attemptId, "usage_unknown", params.tokens, params.microcents);
}

/**
 * The attempt provably never reached a provider, so nothing can have been
 * billed. The only full release in the system.
 */
export function releaseUndispatched(params: {
  agentId: string;
  attemptId: string;
}): Promise<SettleResult> {
  return settle(params.agentId, params.attemptId, "not_dispatched", 0, 0);
}

/**
 * An operator's decision about a hold that was never resolved by any ending.
 *
 * Goes through the SAME compare-and-set as every other transition, which is what
 * makes double-refunding structurally impossible rather than procedurally
 * discouraged: only a hold in state `open` moves, and a second call returns the
 * first call's result.
 */
export function resolveHold(params: {
  agentId: string;
  attemptId: string;
  tokens: number;
  microcents: number;
}): Promise<SettleResult> {
  return settle(params.agentId, params.attemptId, "resolved", params.tokens, params.microcents);
}

export interface OpenHoldRecord {
  attemptId: string;
  createdAtMs: number;
  ageMs: number;
  estimateTokens: number;
  estimateMicrocents: number;
  /** What the attempt was about to call. Empty on holds opened before 0055's
   *  recovery surface existed, and on the demo path. */
  provider: string;
  model: string;
  /**
   * True once this attempt consumed its one-use dispatch permission — the
   * gateway may have reached the provider and may have been billed.
   *
   * THIS DECIDES WHETHER A FULL RELEASE IS EVEN AVAILABLE. SETTLE_LUA refuses a
   * `not_dispatched` outcome for any hold past that line, so an operator who
   * cannot see this field learns it only by attempting the release and reading
   * the refusal. False means the attempt provably never left, which is the one
   * case where releasing the whole hold is honest.
   */
  mayHaveDispatched: boolean;
}

/**
 * Every hold still open for one agent, oldest first.
 *
 * Reads the sorted-set index rather than SCANning for keys. SCAN is not a
 * snapshot — it can miss a key that exists throughout the scan and return one
 * twice — which is exactly why the old reservation rebuild raced concurrent
 * reserves. This is a report, never an input to a counter.
 */
export async function listOpenHolds(agentId: string, limit = 200): Promise<OpenHoldRecord[]> {
  const ids = (await redis().zrange<string[]>(k.holds(agentId), 0, limit - 1)) ?? [];
  const now = Date.now();
  const out: OpenHoldRecord[] = [];
  for (const attemptId of ids) {
    const h = await redis().hgetall<Record<string, string>>(k.hold(agentId, attemptId));
    // Indexed but absent: the hold was settled and its tombstone has since
    // expired, while the ZREM was lost. Report nothing rather than a zero-value
    // hold an operator would try to resolve.
    if (!h || !h.st) continue;
    const createdAtMs = Number(h.cr) || 0;
    out.push({
      attemptId,
      createdAtMs,
      ageMs: createdAtMs ? now - createdAtMs : 0,
      estimateTokens: Number(h.et) || 0,
      estimateMicrocents: Number(h.ec) || 0,
      provider: h.pv ? String(h.pv) : "",
      model: h.md ? String(h.md) : "",
      // Anything that is not explicitly still pre-dispatch is treated as
      // possibly dispatched. A hold written before this field existed has no
      // `ph` at all, and the conservative reading of an unknown phase is the
      // one that does not offer a refund.
      mayHaveDispatched: h.ph !== "pre_dispatch",
    });
  }
  return out;
}

/** How many holds are open for an agent. Cheap enough for the cron to report. */
export async function countOpenHolds(agentId: string, client?: Client): Promise<number> {
  return Number(await on(client).zcard(k.holds(agentId))) || 0;
}

/** Both reservation counters, for drift reporting only. Never an input. */
export async function readReserved(
  agentId: string,
  client?: Client
): Promise<{ tokens: number; microcents: number }> {
  const [t, c] = await on(client).mget<[number | null, number | null]>(
    k.reserved(agentId),
    k.reservedCost(agentId)
  );
  return { tokens: Number(t) || 0, microcents: Number(c) || 0 };
}

export interface ReservedBudgetSummary {
  tokens: number;
  microcents: number;
  openHolds: number;
}

/** Read a fleet's live reservations in bounded Redis pipelines. This is a
 * presentation read only; admission and settlement continue to use the atomic
 * scripts above. */
export async function readReservedMany(
  agentIds: readonly string[],
  client?: Client
): Promise<Map<string, ReservedBudgetSummary>> {
  const out = new Map<string, ReservedBudgetSummary>();
  const source = on(client);
  for (let offset = 0; offset < agentIds.length; offset += 200) {
    const ids = agentIds.slice(offset, offset + 200);
    if (!ids.length) continue;
    const pipe = source.pipeline();
    pipe.mget(...ids.flatMap((id) => [k.reserved(id), k.reservedCost(id)]));
    for (const id of ids) pipe.zcard(k.holds(id));
    const replies = await pipe.exec() as unknown[];
    const counters = Array.isArray(replies[0]) ? replies[0] as unknown[] : [];
    ids.forEach((id, index) => {
      out.set(id, {
        tokens: Number(counters[index * 2]) || 0,
        microcents: Number(counters[index * 2 + 1]) || 0,
        openHolds: Number(replies[index + 1]) || 0,
      });
    });
  }
  return out;
}

/**
 * Raise `spent:` to at least these figures. Used by the reconcile cron in place
 * of the unconditional `SET` that erased live spend settled inside its lag
 * window.
 */
export async function raiseSpentFloor(params: {
  agentId: string;
  tokens: number;
  microcents: number;
}, client?: Client): Promise<{ raised: boolean }> {
  const res = await on(client).eval(
    RAISE_LUA,
    [k.spent(params.agentId), k.spentCost(params.agentId)],
    [String(int(params.tokens)), String(int(params.microcents))]
  );
  const [raised] = codes(res);
  return { raised: raised === 1 };
}

/**
 * Read the epoch Redis holds for an agent. Diagnostics and the control plane;
 * the hot path checks it inside the open script instead, where it cannot race.
 */
export async function readEpoch(agentId: string): Promise<string | null> {
  const v = await redis().get<unknown>(k.epoch(agentId));
  return v === null || v === undefined ? null : String(v);
}

export interface RebuildResult {
  /** What `reserved:` actually holds after the rebuild, live from Redis. */
  reservedTokens: number;
  reservedMicrocents: number;
  /** The sum of the estimates on holds still open, computed by this call. */
  computedReservedTokens: number;
  computedReservedMicrocents: number;
  openHolds: number;
  /** True when the counter was absent and this rebuild seeded it. */
  seededReserved: boolean;
  /** More open holds than one read returns; the computed sums are partial. */
  truncated: boolean;
}

/**
 * Point Redis at a known epoch and rebase the counters onto it. THE ONLY
 * SANCTIONED LOWERING OF A SPEND COUNTER IN THE SYSTEM, reachable exclusively
 * from the audited control endpoint.
 *
 * ── Why `reserved:` is seeded and not set ───────────────────────────────────
 *
 * The first version of this read the open holds, summed their estimates, and
 * SET `reserved:` to the total. That is the SCAN-then-write shape the whole
 * plan deleted from lib/reconcile.ts, wearing a rebuild's clothes: a hold that
 * opens between the read and the write has its INCRBY overwritten, and when it
 * later settles the DECRBY takes `reserved:` BELOW ZERO — which widens
 * available capacity, on the one route whose entire justification is that it is
 * the only place capacity may ever be handed back, deliberately, by a human.
 *
 * So the write is NX. `reserved:` moves exclusively through the atomic hold
 * transitions, and INCRBY creates the key, so:
 *
 *   * If any hold is open — including one that opened a microsecond ago — the
 *     key exists, the seed no-ops, and the atomically-maintained value stands.
 *     It is by construction the correct one.
 *   * If the counter was genuinely lost while hold records survived, the key is
 *     absent and this seeds the sum. That is the only case a rebuild can
 *     improve, and it is the case it exists for.
 *
 * Both figures are reported, so an operator can SEE a disagreement rather than
 * having it silently overwritten — the same posture lib/reconcile.ts takes with
 * `reservedDrift`, and for the same reason: a mismatch means an invariant broke,
 * and quietly correcting it is how the original defect stayed invisible.
 *
 * `spent:` is set unconditionally, because that is the lowering this route is
 * for and it has just been computed from the record.
 */
export async function rebuildBudgetState(params: {
  agentId: string;
  epoch: string;
  spentTokens: number;
  spentMicrocents: number;
}): Promise<RebuildResult> {
  const open = await listOpenHolds(params.agentId, REBUILD_HOLD_SCAN_LIMIT);
  const computedReservedTokens = open.reduce((sum, h) => sum + h.estimateTokens, 0);
  const computedReservedMicrocents = open.reduce((sum, h) => sum + h.estimateMicrocents, 0);

  const res = await redis().eval(
    REBASE_LUA,
    [
      k.epoch(params.agentId),
      k.spent(params.agentId),
      k.spentCost(params.agentId),
      k.reserved(params.agentId),
      k.reservedCost(params.agentId),
      k.fmt(params.agentId),
    ],
    [
      params.epoch,
      String(int(params.spentTokens)),
      String(int(params.spentMicrocents)),
      String(computedReservedTokens),
      String(computedReservedMicrocents),
      ACCT_FORMAT,
    ]
  );
  const [reservedTokens, reservedMicrocents, seeded] = codes(res);

  return {
    reservedTokens,
    reservedMicrocents,
    computedReservedTokens,
    computedReservedMicrocents,
    openHolds: open.length,
    seededReserved: seeded !== 0,
    // Reported rather than paged over. A rebuild is a recovery action, and an
    // operator told "1000 open holds" when there are 1200 would seed a counter
    // too LOW and never know. It only affects the seed branch, and the seed only
    // fires when the counter was lost outright.
    truncated: open.length >= REBUILD_HOLD_SCAN_LIMIT,
  };
}

/**
 * Record in Postgres that this agent's hot-path budget counters now exist.
 *
 * The other half of `openHold`'s `epochToPersist`. Until this lands, a Redis
 * flush for the agent is undetectable — so it is written eagerly, on the first
 * budgeted call, rather than lazily.
 *
 * ONLY EVER WRITES A ROW THAT HAS NO EPOCH YET (`is null` on `budget_epoch`).
 * The guard was on the TIMESTAMP until 0057 gave "timestamp set, epoch null" a
 * meaning — the cutover marker for an agent that was spending before
 * generations existed. Such an agent mints an epoch like any other and has to
 * be able to record it; a timestamp guard matched no row and left it minting a
 * fresh epoch on every call, permanently unfenced. Both consequences below hold
 * identically on the epoch:
 *
 *   * Concurrent first-inits converge. Whichever call wins writes the epoch it
 *     read from Redis; the others match no row and change nothing. Since all of
 *     them read the SAME live epoch out of the open script, they would write the
 *     same value anyway — the guard makes that a fact rather than a hope.
 *   * It can never overwrite an established agent's epoch. An overwrite is
 *     exactly what a rebuild is for, and a rebuild is audited; this path is not,
 *     so it must not be able to perform one.
 *
 * THROWS ON A FAILED WRITE, and the caller depends on that. The proxy awaits
 * this and forwards nothing if it rejects: a matching durable generation, or no
 * upstream call. This comment used to say the opposite — "best-effort, it must
 * never fail the request" — which was true of the version that ran inside
 * `waitUntil`, and became false when the call site was hardened around it while
 * this function was left alone.
 *
 * What made the drift invisible is that supabase-js RESOLVES a failed statement
 * with `{ error }` rather than throwing. A statement timeout, an RLS denial or a
 * dead connection all returned normally here, so the caller's catch could not
 * fire and the request went upstream believing the generation was durable. For
 * a first-init that is the whole hole again: Postgres keeps saying "never
 * established", so a later Redis loss is undetectable, and the agent's spend
 * history is handed back as fresh capacity.
 */
export async function establishBudgetState(agentId: string, epoch: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("agents")
    .update({ budget_epoch: epoch, budget_state_established_at: new Date().toISOString() })
    .eq("id", agentId)
    .is("budget_epoch", null);
  // Matching no row is SUCCESS, not failure: it is the guard doing its job on a
  // row that already carries an epoch. Only a real error rejects.
  if (error) {
    throw new Error(`budget state not established: ${error.code ?? "unknown"} ${error.message ?? ""}`.trim());
  }
}
