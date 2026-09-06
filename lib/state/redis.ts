// Upstash Redis (REST, edge-compatible) — nonces, budget counters, key cache,
// suspend set, last-seen. The budget reserve is a single atomic Lua script
// (Tension 2 / S3) so reserve+check+rollback never races across round-trips.
import { Redis } from "@upstash/redis";
import { logFailOpen } from "../observability";

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
  key: (agid: string, provider: string) => `key:${agid}:${provider}`,
  // The endpoint a credential is sent to. Its own key rather than a field on the
  // sealed one above, because it is NOT a secret: it is an address, so it does
  // not go through lib/crypto/aesgcm.ts and a cache read of it decrypts nothing.
  endpoint: (agid: string, provider: string) => `endpoint:${agid}:${provider}`,
  // `policy4` deliberately: the cached row also carries the sender-proof setting
  // and, since 0055, the agent's budget epoch. A policy2 value has no
  // sender-proof setting and must not silently disable it for a full cache
  // window after a deploy.
  //
  // 0049 turned the sender-proof setting from a boolean into a three-state mode
  // and did NOT bump, because lib/state/policy.ts decodes the old shape instead
  // (`true` -> required, `false` -> off). A bump throws away every tenant's
  // cached policy; a decode costs two lines. Bump when the old value cannot be
  // read at all — decode when it can.
  //
  // 0055 IS a bump, and the rule above is why. A policy3 value carries no budget
  // epoch, and the two ways to decode that absence are both wrong: reading it as
  // "not established" would leave a genuinely established agent unprotected for
  // a full cache window — exactly the flush this check exists to catch — while
  // reading it as "unknown, therefore refuse" would deny live traffic for the
  // same window. There is no third reading, so the old value cannot be read at
  // all, and it is discarded. The whole cost is 60 seconds of misses on deploy.
  policy: (uid: string, agid: string) => `policy4:${uid}:${agid}`,
  fallbacks: (uid: string, agid: string) => `fallbacks:${uid}:${agid}`,
  suspended: (agid: string) => `suspended:${agid}`,
  owner: (uid: string) => `owner:${uid}`,
  // Which providers a tenant holds a credential for. Names no secret and no
  // credential id — only the provider list, used to say what an agent could fail
  // over to. Never a decrypt path.
  providerKeys: (uid: string) => `provkeys:${uid}`,
  lastSeen: (agid: string) => `lastseen:${agid}`,
  keyImport: (uid: string, id: string) => `keyimport:${uid}:${id}`,
};

/**
 * Undo the Upstash client's automatic deserialization for a cache that stores a
 * string.
 *
 * `@upstash/redis` serialises a string by passing it through unchanged, then
 * deserialises EVERY response with `JSON.parse`. So a value written as JSON text
 * — which is every structured cache below — comes back as a parsed object, and
 * `redis().get<string>(…)` quietly asserts otherwise: it is a type argument, not
 * a runtime coercion. Every caller then does `JSON.parse(cached)`, which throws
 * on an object, and every caller's catch branch reads that as "the cached value
 * is malformed".
 *
 * For the policy cache that meant `policy:malformed`, which the proxy fails
 * CLOSED on — an agent with no policy at all was refused for the length of every
 * cache window, clearing only on the miss that re-read Postgres. Found in
 * production on 2026-08-16.
 *
 * The fix belongs here rather than in each caller: the callers are written
 * against the declared `string` contract and are correct as written, so this
 * restores the contract instead of teaching four modules about a client
 * behaviour they should never have to know.
 *
 * Not `automaticDeserialization: false` on the client, which would be the same
 * repair with a far wider blast radius: one client serves the atomic budget Lua
 * script, the nonce `set nx`, and the spend counters, and all of their return
 * types would move at once.
 *
 * A non-string round-trips through `JSON.stringify`, which reproduces the exact
 * text that was stored — including the digit-only case, where `parseRecursive`
 * hands back a real number.
 */
function asCachedString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? null;
}

// ── Replay nonces (Flow B) ────────────────────────────────────────────────────
/** Returns true if the nonce was fresh (claimed), false if already seen (replay). */
export async function claimNonce(nonce: string, ttlSeconds = 180): Promise<boolean> {
  const res = await redis().set(k.nonce(nonce), 1, { nx: true, ex: ttlSeconds });
  return res === "OK";
}

// ── Budget accounting lives in lib/state/holds.ts ────────────────────────────
//
// `reserveBudget`, `reconcileBudget`, `seedSpent`, `getSpent`, `setSpent` and
// `setReserved` were all removed here, and the last three had ZERO callers
// anywhere in the tree. They are named in this comment rather than deleted
// silently because they are exactly the shape this work exists to close: a
// non-atomic read here, a write there, and a settlement that trusted whatever
// estimate the caller handed it.
//
// The replacement is one Lua eval per transition, idempotent on an attempt id,
// with the release computed from the estimate the script itself stored. The
// counters `spent:` / `reserved:` are written ONLY by those scripts and, for
// `spent:` alone, by the monotone raise the reconcile cron calls. Nothing else
// may SET them — a plain setter is how a lagged total came to erase live spend.
//
// `readBudgetSnapshot` stays: it only READS, and the decision trace needs to
// show an operator the same four numbers the gate saw.

export interface BudgetSnapshot {
  reservedTokens: number;
  spentTokens: number | null;
  reservedMicrocents: number;
  spentMicrocents: number | null;
}

/**
 * Read the four counters the atomic hold script compares, without changing them.
 *
 * Null spent values are meaningful and are not flattened to 0: they say the
 * counter does not exist, which for a budgeted agent is the difference between
 * "has never spent" and "the state was lost". The hot path answers that question
 * inside the open script; this is for showing a human what was there.
 */
export async function readBudgetSnapshot(agentId: string): Promise<BudgetSnapshot> {
  const values = await redis().mget<[number | null, number | null, number | null, number | null]>(
    k.reserved(agentId),
    k.spent(agentId),
    k.reservedCost(agentId),
    k.spentCost(agentId)
  );
  const numberOr = (value: unknown, fallback: number | null): number | null => {
    if (value === null || value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    reservedTokens: numberOr(values[0], 0) ?? 0,
    spentTokens: numberOr(values[1], null),
    reservedMicrocents: numberOr(values[2], 0) ?? 0,
    spentMicrocents: numberOr(values[3], null),
  };
}

// ── Provider-key cache (stores ciphertext only; see aesgcm.ts) ────────────────
/**
 * The custom endpoint for this (agent, provider), or the empty string for "none".
 *
 * The empty string is a real cached value and not a miss: most credentials have
 * no custom endpoint, and caching that absence is what keeps the common case
 * from paying a database read on every call. `null` means nothing is cached.
 */
export async function getCachedEndpoint(
  agentId: string,
  provider: string
): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.endpoint(agentId, provider)));
}

export async function setCachedEndpoint(
  agentId: string,
  provider: string,
  endpoint: string,
  ttlSeconds = 60
): Promise<void> {
  await redis().set(k.endpoint(agentId, provider), endpoint, { ex: ttlSeconds });
}

export async function getCachedKey(agentId: string, provider: string): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.key(agentId, provider)));
}

export async function setCachedKey(
  agentId: string,
  provider: string,
  sealed: string,
  ttlSeconds = 60
): Promise<void> {
  await redis().set(k.key(agentId, provider), sealed, { ex: ttlSeconds });
}

// ── Agent-policy cache ───────────────────────────────────────────────────────
// Policy is not secret material, so cache its serialized JSON directly. Include
// both tenant and agent identifiers even though agent UUIDs are globally unique:
// tenant isolation must be visible in every hot-path key, not merely assumed.
//
// The key is `policy2:` because the cached SHAPE changed when shadow mode landed:
// it used to be the policy value itself, and is now { p, s } carrying the live
// policy and the shadow candidate from one row read. Reusing `policy:` would
// have made every entry written by the previous deploy parse as a policy object
// with two unknown keys — which parsePolicy rejects, so the gateway would have
// read `policy:malformed` and DENIED live traffic for the length of one cache
// window. There is no invalidation path to keep in sync (the cache is purely
// TTL-driven, which is what "takes effect after at most 60 seconds" means), so
// the whole cost of the rename is 60 seconds of misses on deploy.
export async function getCachedAgentPolicy(
  userId: string,
  agentId: string
): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.policy(userId, agentId)));
}

export async function setCachedAgentPolicy(
  userId: string,
  agentId: string,
  serializedPolicy: string,
  ttlSeconds = 60
): Promise<void> {
  await redis().set(k.policy(userId, agentId), serializedPolicy, { ex: ttlSeconds });
}

/**
 * Drop the cached policy for one agent.
 *
 * One key holds both the live policy and the shadow candidate, so this clears
 * both — which is what promotion needs. Promotion changes ENFORCEMENT, and
 * leaving the old pair cached would mean the operator watches up to 60 seconds
 * of traffic decided by the policy they just replaced. Best-effort at every
 * call site: a failed purge costs one cache window, and must never be the
 * reason a save is reported as failed when the row was in fact written.
 */
export async function purgeAgentPolicy(userId: string, agentId: string): Promise<void> {
  await redis().del(k.policy(userId, agentId));
}

export async function getCachedAgentFallbacks(
  userId: string,
  agentId: string
): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.fallbacks(userId, agentId)));
}

export async function setCachedAgentFallbacks(
  userId: string,
  agentId: string,
  serializedFallbacks: string,
  ttlSeconds = 60
): Promise<void> {
  await redis().set(k.fallbacks(userId, agentId), serializedFallbacks, { ex: ttlSeconds });
}

export async function purgeAgentFallbacks(userId: string, agentId: string): Promise<void> {
  await redis().del(k.fallbacks(userId, agentId));
}

// ── Owner-binding cache ──────────────────────────────────────────────────────
// The owner claim on a receipt is read per call, so it is cached like policy.
// Owner bindings change far less often than policy, hence the longer TTL. Not
// secret material — a published owner is public by definition.
export async function getCachedOwner(userId: string): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.owner(userId)));
}

export async function setCachedOwner(
  userId: string,
  serializedOwner: string,
  ttlSeconds = 300
): Promise<void> {
  await redis().set(k.owner(userId), serializedOwner, { ex: ttlSeconds });
}

export async function purgeOwnerCache(userId: string): Promise<void> {
  await redis().del(k.owner(userId));
}

export async function getCachedProviderKeys(userId: string): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.providerKeys(userId)));
}

export async function setCachedProviderKeys(
  userId: string,
  serializedProviders: string,
  ttlSeconds = 300
): Promise<void> {
  await redis().set(k.providerKeys(userId), serializedProviders, { ex: ttlSeconds });
}

export async function purgeProviderKeysCache(userId: string): Promise<void> {
  await redis().del(k.providerKeys(userId));
}

/**
 * Drop everything cached per (agent, provider) after a credential changes.
 *
 * Both the sealed key AND the endpoint, because they are two halves of one
 * answer — "which credential, sent where". Purging only the key would leave a
 * changed endpoint deciding for a full TTL, which is the same defect the
 * sender-proof mode write had: the write lands and the old value keeps being
 * used. Anything else cached per (agent, provider) belongs in this list too.
 */
export async function purgeAgentCaches(agentId: string, providers: string[]): Promise<void> {
  const keys = providers.flatMap((p) => [k.key(agentId, p), k.endpoint(agentId, p)]);
  if (keys.length) await redis().del(...keys);
}

// ── Per-agent fast revocation ─────────────────────────────────────────────────
export async function isSuspended(agentId: string): Promise<boolean> {
  try {
    return (await redis().exists(k.suspended(agentId))) === 1;
  } catch {
    logFailOpen("suspend_read");
    // Match the Redis-backed kill switch: fail open by default to avoid blocking
    // every agent on a transient Redis read blip; operators can opt into strict
    // fail-closed behavior for revocation reads.
    return process.env.KILL_SWITCH_FAIL_CLOSED === "true";
  }
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

// ── Key-import handoff (dashboard on-ramp) ───────────────────────────────────
// Holds an ALREADY-SEALED provider key between the probe step and the commit
// step. The browser gets only the opaque id, never the material — so the raw
// key, in any form, never leaves the server. Tenant is baked into the key so
// one tenant can never redeem another's handoff even with a guessed id.
export async function stashKeyImport(
  userId: string,
  id: string,
  sealedKey: string,
  ttlSeconds: number
): Promise<void> {
  await redis().set(k.keyImport(userId, id), sealedKey, { ex: ttlSeconds });
}

/**
 * Redeem a handoff EXACTLY once — atomically.
 *
 * `getdel`, not `get` then `del`. This used to be the two-round-trip pair, under
 * a docstring that already claimed "EXACTLY once". It was not: two concurrent
 * redemptions of one id both read before either deleted, and both walked away
 * with the ciphertext. `tests/key-import-atomic.test.ts` reproduces it — eight
 * concurrent callers, eight copies of the sealed key.
 *
 * What that was worth to an attacker is narrow: the id is a `crypto.randomUUID`
 * that lives for a couple of minutes, and `completeKeyImport` re-checks the
 * tenant inside the sealed payload afterwards. But the property was written down
 * and relied on by the caller's own comment, and single-use is the only thing
 * separating "a handoff" from "a bearer token with a TTL".
 *
 * Redis decides it server-side in one call, so concurrency cannot split it. The
 * delete still happens on a miss in the sense that matters — there is nothing
 * left to replay either way.
 *
 * NOT wrapped in a catch. A Redis fault must propagate: reporting a fault as
 * `null` would be indistinguishable from "already redeemed", which is exactly
 * the answer that must stay trustworthy.
 */
export async function takeKeyImport(userId: string, id: string): Promise<string | null> {
  return asCachedString(await redis().getdel<unknown>(k.keyImport(userId, id))) ?? null;
}
