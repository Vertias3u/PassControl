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
import { getCachedAgentPolicy, setCachedAgentPolicy } from "./redis";

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
        };
      }
    }
  } catch {
    // A cache read failure falls through to the tenant-scoped source of truth.
  }

  // Selecting one column or three costs the same round trip. This is why shadow
  // mode and the sender-proof opt-in stay free on the hot path. The complete
  // read stays first: on a current schema nothing below it runs.
  const current = await db
    .from("agents")
    .select("policy, policy_shadow, sender_constraint_mode, budget_epoch, budget_state_established_at")
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
  // 0046's boolean is deliberately NOT a rung of its own. It only ever existed
  // between 0046 and 0049, nothing could write to it, so on every schema that
  // lacks the mode column it was false anyway — and `off` is what the next rung
  // already produces. A rung for it would be a round trip spent confirming a
  // value that cannot differ.
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
        .select("policy, policy_shadow")
        .eq("user_id", userId)
        .eq("id", agentId)
        .maybeSingle()
    : null;

  const policyOnly = isMissingColumn(withoutSenderConstraint?.error)
    ? await db
        .from("agents")
        .select("policy")
        .eq("user_id", userId)
        .eq("id", agentId)
        .maybeSingle()
    : null;

  const { data, error } =
    policyOnly ?? withoutSenderConstraint ?? withoutBudgetState ?? current;
  if (error || !data || !("policy" in data)) {
    return {
      policy: POLICY_UNREADABLE,
      shadow: null,
      senderConstraintMode: null,
      budgetState: { epoch: null, established: false },
    };
  }

  const policy = data.policy ?? null;
  // On the oldest fallback the shadow column does not exist, which is "shadow
  // mode is off" and not a failure of its own.
  const shadow = "policy_shadow" in data
    ? ((data as { policy_shadow?: unknown }).policy_shadow ?? null)
    : null;
  // On either fallback the mode column does not exist, which is "off" — see the
  // note above about why 0046's boolean gets no rung of its own.
  const senderConstraintMode = toSenderConstraintMode(
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
        } satisfies CachedPolicy),
        POLICY_CACHE_TTL_S
      )
    );
  }
  return { policy, shadow, senderConstraintMode, budgetState };
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
