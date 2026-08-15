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
}

/** Cached shape. Short keys because this is written on every cache miss. */
interface CachedPolicy {
  p: unknown;
  s: unknown;
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
        if (isCached(parsed)) return { policy: parsed.p, shadow: parsed.s ?? null };
      } catch {
        // A readable malformed cache value remains malformed policy, not an
        // infrastructure-read failure, so the shared evaluator fails closed.
        return { policy: cached, shadow: null };
      }
    }
  } catch {
    // A cache read failure falls through to the tenant-scoped source of truth.
  }

  // Selecting one column or two costs the same round trip. This is the entire
  // reason shadow mode is free on the hot path, so the two-column read stays
  // FIRST: on a current schema nothing below this line ever runs.
  const both = await db
    .from("agents")
    .select("policy, policy_shadow")
    .eq("user_id", userId)
    .eq("id", agentId)
    .maybeSingle();

  // A deployment running this code against a pre-0020 schema does not get a row
  // with `policy_shadow` missing — PostgREST rejects the WHOLE query with 42703
  // (verified against the local stack: HTTP 400, "column agents.policy_shadow
  // does not exist"). Read as one query, that turns an absent DIAGNOSTIC column
  // into POLICY_UNREADABLE for the LIVE policy, and the proxy's default
  // fail-open posture then permits every call a deny policy was written to
  // refuse. So the live value is read independently: one narrowed retry, which
  // costs a second round trip only on a database that has not caught up yet.
  //
  // Nothing else is retried. Any other error is an infrastructure fault, and
  // the documented fail-open (or POLICY_FAIL_CLOSED) posture handles it —
  // re-querying a database that is already failing would only add load.
  const fallback = isMissingColumn(both.error)
    ? await db
        .from("agents")
        .select("policy")
        .eq("user_id", userId)
        .eq("id", agentId)
        .maybeSingle()
    : null;

  const { data, error } = fallback ?? both;
  if (error || !data || !("policy" in data)) return { policy: POLICY_UNREADABLE, shadow: null };

  const policy = data.policy ?? null;
  // On the fallback path the column does not exist, which is "shadow mode is
  // off" and NOT a failure mode of its own: an unreadable shadow policy simply
  // does not run, exactly as this module's contract says. Diagnostics never get
  // their own way to fail on the credential path.
  const shadow = fallback
    ? null
    : ((data as { policy_shadow?: unknown }).policy_shadow ?? null);

  if (options.cacheOnMiss !== false) {
    waitUntil(
      setCachedAgentPolicy(
        userId,
        agentId,
        JSON.stringify({ p: policy, s: shadow } satisfies CachedPolicy),
        POLICY_CACHE_TTL_S
      )
    );
  }
  return { policy, shadow };
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
