// Current per-agent policy read shared by the proxy and decision trace. Policy
// stays out of visas so owner changes take effect after at most the 60-second
// cache window. Traces may read the same cache but never populate it.
//
// Since shadow mode, this read carries TWO values: the live policy and the
// shadow candidate. They come from one row and one cache entry on purpose — a
// diagnostics feature must not put a second Redis round-trip, or a second
// Postgres query, on the path that resolves a provider credential. The one
// exception is a schema that predates the shadow column, where the live policy
// is re-read alone rather than lost with it; see readCurrentAgentPolicyAndShadow.
import { waitUntil } from "@vercel/functions";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toSenderConstraintMode, type SenderConstraintMode } from "../sender-constraint";
import { POLICY_UNREADABLE } from "../gate";
import { getCachedAgentPolicy, readPolicyFence, setCachedAgentPolicy } from "./redis";

const POLICY_CACHE_TTL_S = 60;

type PolicyDatabase = Pick<SupabaseClient, "from">;

export interface CurrentPolicyReadOptions {
  cacheOnMiss?: boolean;
}

/**
 * The live policy, plus the shadow candidate when the operator has set one.
 *
 * `policy` is `POLICY_UNREADABLE` when the read itself failed — an
 * infrastructure fault, which the shared evaluator treats differently from a
 * malformed value. `shadow` is `null` for "shadow mode is off", and is ALSO null
 * when the read failed: there is no such thing as an unreadable shadow policy,
 * because an unreadable one simply does not run. Diagnostics do not get their
 * own failure mode on the credential path.
 */
export interface CurrentPolicyRead {
  policy: unknown | typeof POLICY_UNREADABLE;
  shadow: unknown | null;
  // null means the source of truth was unreadable. The proxy treats that as an
  // authentication failure for passport calls rather than guessing the mode off.
  senderConstraintMode: SenderConstraintMode | null;
  /**
   * What Postgres knows about this agent's hot-path budget counters.
   *
   * Rides here because this read already happens on every call, so the budget
   * epoch check costs no extra round trip and can be evaluated INSIDE the same
   * Lua script that moves the money — where it cannot race a concurrent flush.
   *
   * `established: false` on a schema that predates 0055, which is correct rather
   * than merely convenient: a deployment whose database cannot record that state
   * was established has nothing to detect the loss of, and must keep behaving
   * exactly as it did before.
   */
  budgetState: { epoch: string | null; established: boolean };
  /**
   * The agent's CURRENT caps, as the row has them right now.
   *
   * A passport visa carries `bt`/`bc` claims minted when it was issued, and the
   * proxy used to gate on those alone — so lowering a cap did nothing to an
   * outstanding visa for up to its full 15-minute life, while `verifyVisa`
   * authenticated the stale number perfectly and the atomic hold enforced it
   * exactly. Atomicity protecting the wrong limit (S3-04).
   *
   * `known: false` means this read could not establish them: an older schema, a
   * cache entry written before this field existed, or a failed read. The caller
   * then keeps the visa claim, which is precisely what it did before — an
   * unknown must not become a new denial path, and must not become "unlimited"
   * either.
   *
   * `cents`, not microcents. The row's units, converted where they are enforced.
   */
  budget:
    | { known: true; tokens: number | null; cents: number | null }
    | { known: false };
}

/** Cached shape. Short keys because this is written on every cache miss. */
interface CachedPolicy {
  p: unknown;
  s: unknown;
  /**
   * The mode. Two legacy shapes are readable, both from entries this deploy did
   * not write. Absent means `off`: decoding a pre-0049 entry as `null` would
   * fail every passport call for a whole cache TTL after a routine deploy. A
   * BOOLEAN is 0046's shape and is translated rather than dropped — see
   * `fromCachedMode`.
   */
  r?: string | boolean;
  /** Budget epoch, and whether Postgres has recorded state as established. */
  be?: string | null;
  bs?: boolean;
  /**
   * The live caps, and a flag saying they were actually read.
   *
   * `bk` is load-bearing and not redundant. `bt: null` is a REAL value meaning
   * "no token cap", and an entry written before this field existed also has no
   * `bt` — so without the flag those two are the same bytes and mean opposite
   * things: one says stop enforcing a cap, the other says fall back to the
   * visa's. Reading a pre-existing entry as "unlimited" would hand every agent
   * holding one an uncapped cache window.
   *
   * NO `policy5` BUMP. The rule this file already follows is: bump when the old
   * value cannot be read at all, decode when it can. It can — an entry without
   * `bk` decodes to `known: false`, which is exactly the behaviour that shipped
   * before this field existed. The whole cost is that such entries keep gating
   * on the visa claim until they expire, 60 seconds at most.
   */
  bk?: boolean;
  bt?: number | null;
  bc?: number | null;
}

/**
 * Decode the cached mode, including the shape 0046 wrote.
 *
 * `true` must become `required`, not `off`. Nothing in the product could set
 * 0046's boolean, so a `true` only exists on a row an operator edited by hand —
 * but that is exactly the operator who has deliberately turned enforcement on,
 * and silently dropping it for a cache TTL is the one direction this may never
 * fail in. Two lines, and it makes 0049 safe across a rolling deploy rather than
 * safe only because the column was unreachable.
 */
function fromCachedMode(value: unknown): SenderConstraintMode {
  if (value === true) return "required";
  if (value === false) return "off";
  return toSenderConstraintMode(value);
}

function isCached(value: unknown): value is CachedPolicy {
  return typeof value === "object" && value !== null && !Array.isArray(value) && "p" in value;
}

/**
 * Postgres reports a selected column that does not exist as 42703
 * (undefined_column) and PostgREST passes that code straight through. The
 * message is matched as well because it is the one part of the response that a
 * PostgREST version bump cannot quietly renumber.
 */
function isMissingColumn(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "42703") return true;
  return typeof message === "string" && /column .* does not exist/i.test(message);
}

export async function readCurrentAgentPolicyAndShadow(
  db: PolicyDatabase,
  userId: string,
  agentId: string,
  options: CurrentPolicyReadOptions = {}
): Promise<CurrentPolicyRead> {
  // The invalidation fence, read BEFORE the database and quoted back at fill
  // time, so an invalidation that lands mid-read rejects this fill: publishing a
  // snapshot taken before a mode change would keep the old mode deciding for a
  // full TTL, which on `required` means admitting unproven calls after the
  // operator was told the change had been made.
  //
  // Only assigned on the miss path below — a cache HIT returns before the fence
  // is ever read, so the hot path pays nothing for this.
  let fence: string | null = null;
  try {
    const cached = await getCachedAgentPolicy(userId, agentId);
    if (cached !== null) {
      try {
        const parsed: unknown = JSON.parse(cached);
        // A cache entry that does not carry the wrapper is not from this code.
        // Treating its contents as a policy would be a guess, and guessing wrong
        // means denying live traffic, so fall through to the source of truth.
        if (isCached(parsed)) {
          return {
            policy: parsed.p,
            shadow: parsed.s ?? null,
            senderConstraintMode: fromCachedMode(parsed.r),
            budgetState: { epoch: parsed.be ?? null, established: parsed.bs === true },
            budget:
              parsed.bk === true
                ? { known: true, tokens: parsed.bt ?? null, cents: parsed.bc ?? null }
                : { known: false },
          };
        }
      } catch {
        // A readable malformed cache value remains malformed policy, not an
        // infrastructure-read failure, so the shared evaluator fails closed.
        return {
          policy: cached,
          shadow: null,
          senderConstraintMode: "off",
          budgetState: { epoch: null, established: false },
          // Unreadable, so the caller keeps the visa's claim. The same posture
          // the rest of this branch takes: a malformed cache entry is malformed
          // POLICY, and must not silently become an absent budget.
          budget: { known: false },
        };
      }
    }
  } catch {
    // A cache read failure falls through to the tenant-scoped source of truth.
  }

  // Before the authoritative read, never after. The value's whole job is to
  // predate the snapshot it will be quoted alongside; reading it afterwards
  // would make it agree with an invalidation it should have been refused by.
  //
  // Best-effort: a fence read that throws leaves this null, which the fill Lua
  // reads as "there was no fence", and a fence that has since appeared will
  // reject the fill anyway. Unavailable Redis costs a cache window, not
  // correctness.
  try {
    fence = await readPolicyFence(userId, agentId);
  } catch {
    fence = null;
  }

  // Selecting one column or three costs the same round trip. This is why shadow
  // mode and the sender-proof opt-in stay free on the hot path. The complete
  // read stays first: on a current schema nothing below it runs.
  const current = await db
    .from("agents")
    .select(
      "policy, policy_shadow, sender_constraint_mode, budget_epoch, budget_state_established_at, budget_tokens, budget_cents"
    )
    .eq("user_id", userId)
    .eq("id", agentId)
    .maybeSingle();

  // A deployment running this code before 0049 (or before 0020) does not get a
  // row with a missing selected column — PostgREST rejects the WHOLE query with
  // 42703. Letting a not-yet-applied opt-in column turn the live policy into
  // POLICY_UNREADABLE would make a diagnostic migration change enforcement.
  // Narrow in deployment order: first drop the 0049 mode, then drop the 0020
  // shadow column. Current schemas still pay exactly one round trip.
  //
  // 0046's boolean IS read on the pre-0049 rung, and the reasoning that once
  // said otherwise was wrong in a way worth recording. It ran: nothing in the
  // product can write that column, so on any schema lacking the mode column it
  // is false, so `off` is already the right answer. True of the PRODUCT, not of
  // the DATABASE. Hand-editing the row was the only way to turn the control on
  // between 0046 and 0049 — the feature shipped with no writer — and 0049's own
  // backfill preserves `true` rows, which is an admission that they exist.
  //
  // The cache decoder below already honours a legacy `r: true` as `required`,
  // added for exactly that case. Skipping the column here made the two halves
  // disagree with each other: a legacy install enforced while its cache entry
  // was warm and dropped to bearer-only the moment it expired. A code-before-
  // migration window must not quietly retire an authentication control.
  //
  // Nothing else is retried. Any other error is an infrastructure fault, and
  // the documented fail-open (or POLICY_FAIL_CLOSED) posture handles it —
  // re-querying a database that is already failing would only add load.
  // A RUNG OF ITS OWN for the 0055 budget-state columns, and it has to be. Added
  // to the rung below instead, a deployment that has not applied 0055 would fall
  // straight past `sender_constraint_mode` as well — silently turning
  // sender-proof enforcement OFF on every call, because a missing mode column
  // decodes as `off`. A budget-accounting migration must not be able to disable
  // an authentication control as a side effect. Current schemas still pay
  // exactly one round trip.
  const withoutBudgetState = isMissingColumn(current.error)
    ? await db
        .from("agents")
        .select("policy, policy_shadow, sender_constraint_mode")
        .eq("user_id", userId)
        .eq("id", agentId)
        .maybeSingle()
    : null;

  const withoutSenderConstraint = isMissingColumn(withoutBudgetState?.error)
    ? await db
        .from("agents")
        .select("policy, policy_shadow, require_sender_constrained_visa")
        .eq("user_id", userId)
        .eq("id", agentId)
        .maybeSingle()
    : null;

  // Older than 0046: the boolean is not there either. Only reached by a schema
  // that has already refused two newer column lists, so current deployments
  // still pay exactly one round trip.
  const withoutLegacyConstraint = isMissingColumn(withoutSenderConstraint?.error)
    ? await db
        .from("agents")
        .select("policy, policy_shadow")
        .eq("user_id", userId)
        .eq("id", agentId)
        .maybeSingle()
    : null;

  const policyOnly = isMissingColumn(withoutLegacyConstraint?.error)
    ? await db
        .from("agents")
        .select("policy")
        .eq("user_id", userId)
        .eq("id", agentId)
        .maybeSingle()
    : null;

  const { data, error } =
    policyOnly ?? withoutLegacyConstraint ?? withoutSenderConstraint ?? withoutBudgetState ?? current;
  if (error || !data || !("policy" in data)) {
    return {
      policy: POLICY_UNREADABLE,
      shadow: null,
      senderConstraintMode: null,
      budgetState: { epoch: null, established: false },
      budget: { known: false },
    };
  }

  const policy = data.policy ?? null;
  // On the oldest fallback the shadow column does not exist, which is "shadow
  // mode is off" and not a failure of its own.
  const shadow = "policy_shadow" in data
    ? ((data as { policy_shadow?: unknown }).policy_shadow ?? null)
    : null;
  // The modern column when it exists; otherwise 0046's boolean, where `true` is
  // `required` and anything else is `off`. A schema with neither reads as `off`.
  // Drift resolves DOWN for an unknown MODE (a value this build does not
  // understand must not become enforcement) but a known legacy `true` is not
  // drift — it is the operator's answer in the only vocabulary their schema had.
  const legacyRequired =
    "require_sender_constrained_visa" in data &&
    (data as { require_sender_constrained_visa?: unknown }).require_sender_constrained_visa === true;
  const senderConstraintMode = legacyRequired
    ? "required"
    : toSenderConstraintMode(
        "sender_constraint_mode" in data
          ? (data as { sender_constraint_mode?: unknown }).sender_constraint_mode
          : "off"
      );
  // On any fallback rung these columns do not exist, which reads as "this
  // database cannot record budget state" — so nothing is enforced, and the
  // gateway behaves exactly as it did before 0055.
  const row = data as { budget_epoch?: unknown; budget_state_established_at?: unknown };
  const budgetState = {
    epoch: typeof row.budget_epoch === "string" ? row.budget_epoch : null,
    // The TIMESTAMP is what establishment means, not the epoch. They are written
    // together, but a null timestamp beside a non-null epoch would mean a
    // half-finished write, and treating that as established would refuse an
    // agent over a row this code has not finished creating.
    established: row.budget_state_established_at != null,
  };

  // The caps as this row has them. `known` is false on any rung below the first,
  // because those exist for schemas missing newer columns and the caller must
  // then keep doing exactly what it did before rather than read an absence as
  // "no cap". A number is taken only when it IS a number: a string or a NaN from
  // a hand-edited row is not a limit, and must not be treated as one.
  // `budget_tokens` is `bigint` (0001) and `budget_cents` is `integer`. Verified
  // against the local stack that both arrive as JSON NUMBERS rather than strings
  // — PostgREST builds its JSON in Postgres, and `row_to_json` on a real row
  // gives `{"budget_tokens":250000,"budget_cents":500}`. That matters because
  // the guard below turns anything non-numeric into null, and null here means
  // NO CAP: a quoted bigint would silently uncap every agent for a cache window,
  // which is the exact direction S3-04 exists to close.
  const budgetNumber = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const budgetRow = row as { budget_tokens?: unknown; budget_cents?: unknown };
  const budget: CurrentPolicyRead["budget"] =
    "budget_tokens" in budgetRow || "budget_cents" in budgetRow
      ? {
          known: true,
          tokens: budgetNumber(budgetRow.budget_tokens),
          cents: budgetNumber(budgetRow.budget_cents),
        }
      : { known: false };

  if (options.cacheOnMiss !== false) {
    waitUntil(
      setCachedAgentPolicy(
        userId,
        agentId,
        JSON.stringify({
          p: policy,
          s: shadow,
          r: senderConstraintMode,
          be: budgetState.epoch,
          bs: budgetState.established,
          ...(budget.known ? { bk: true, bt: budget.tokens, bc: budget.cents } : {}),
        } satisfies CachedPolicy),
        POLICY_CACHE_TTL_S,
        // THE ARGUMENT THAT WAS MISSING. The previous fence had a parameter for
        // this, documented at length, and no call site ever passed it — so the
        // comparison ran against the fill's own clock, always newer than the
        // invalidation, and the fence could not reject anything. Nothing here
        // may read the fence itself: it must be the one captured before the read.
        fence
      )
    );
  }
  return { policy, shadow, senderConstraintMode, budgetState, budget };
}

/**
 * The live policy alone. Kept because most callers have no business knowing
 * shadow mode exists, and a caller that cannot see the shadow value cannot
 * accidentally let it decide something.
 */
export async function readCurrentAgentPolicy(
  db: PolicyDatabase,
  userId: string,
  agentId: string,
  options: CurrentPolicyReadOptions = {}
): Promise<unknown | typeof POLICY_UNREADABLE> {
  return (await readCurrentAgentPolicyAndShadow(db, userId, agentId, options)).policy;
}
