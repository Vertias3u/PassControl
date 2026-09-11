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
  // Credential-BOUND key material. Its own namespace, for the reason the
  // `policy2:` comment below gives at length: the stored shape differs (a bundle
  // naming the credential, not a bare sealed string), and an entry written by one
  // path must never be readable as the other. A bare sealed string read as a
  // bundle would fail to parse — recoverable — but a bundle read as a sealed
  // string would be decrypted into nonsense and sent upstream as a credential.
  credential: (agid: string, provider: string) => `cred:${agid}:${provider}`,
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
  // ── Invalidation fences ────────────────────────────────────────────────────
  //
  // A fence is NOT a cached value. It is a token that changes every time the
  // thing it guards is invalidated, and it lives in its OWN key so that filling
  // the cache cannot erase it. That separation is the entire mechanism: the
  // first version of this put the invalidation marker in the value key, so the
  // first legitimate fill overwrote the marker and every later stale writer
  // sailed through.
  //
  // A fence is never read on a cache HIT. It is read on the miss path, before
  // the authoritative read, and quoted back at fill time — so the hot path pays
  // nothing and the slow path pays one GET it was already going to beat with a
  // database round trip.
  policyFence: (uid: string, agid: string) => `polgen:${uid}:${agid}`,
  credentialFence: (agid: string, provider: string) => `credgen:${agid}:${provider}`,
  // The owner claim is the one whose staleness OUTLIVES the cache: it is copied
  // into a receipt and signed, so a resurrected claim keeps being verifiable
  // after the entry that produced it has expired.
  ownerFence: (uid: string) => `ownergen:${uid}`,
  fallbacksFence: (uid: string, agid: string) => `fbgen:${uid}:${agid}`,
  providerKeysFence: (uid: string) => `pkgen:${uid}`,
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

// ── Invalidation fences ──────────────────────────────────────────────────────
/**
 * How long a fence token is remembered.
 *
 * It has to outlive every cached value it guards, by a wide margin, because a
 * fence that expires while a value is still live would let a pre-change reader's
 * fill match "no fence" and publish. Values live 60 seconds; a day is not a
 * tuning parameter, it is an assertion that this can never be close.
 */
const FENCE_TTL_S = 86_400;

/**
 * A token, not a counter.
 *
 * Nothing compares fences for ORDER — the only question a fill ever asks is
 * "is this still the same one I saw?" — so distinctness is the whole
 * requirement, and a counter would add a property that has to be maintained
 * (INCR on an expired key restarts at 1 and can collide with a 1 observed
 * before) in exchange for nothing.
 */
function newFenceToken(): string {
  return crypto.randomUUID();
}

/**
 * Publish a value only if the fence has not moved since the reader looked.
 *
 * KEYS[1] value · KEYS[2] fence · ARGV[1] value · ARGV[2] ttl · ARGV[3] the
 * fence the reader observed BEFORE its authoritative read, or '' for "there was
 * no fence".
 *
 * The empty-string case is not a wildcard. It asserts the fence was ABSENT, so
 * a fence appearing between the read and the fill still rejects the fill. And a
 * fence that has since vanished (expired, flushed) rejects too: `fence ~= observed`
 * is true when `fence` is false. Both unknowns resolve to "do not publish",
 * which costs one cache window and never costs correctness.
 */
const FENCED_FILL_LUA = `local fence = redis.call('GET', KEYS[2])
local observed = ARGV[3]
if observed == '' then
  if fence then return 0 end
else
  if fence ~= observed then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1`;

/**
 * Move the fence and drop the values it guards, in ONE script.
 *
 * Atomicity here is not decoration. If moving the fence and deleting the value
 * were two round trips, a reader could slip between them, miss the value, read
 * the OLD fence, and publish a stale fill that the fence check would then
 * legitimately accept — the exact defect this exists to remove, reintroduced by
 * operation order. One eval has no order to get wrong.
 *
 * KEYS comes in groups of four: fence, then the three value keys it guards.
 * ARGV[1] is the fence TTL, ARGV[2..] are the new tokens, one per group.
 */
const ROTATE_FENCE_LUA = `local ttl = ARGV[1]
local n = #KEYS / 4
for i = 0, n - 1 do
  redis.call('SET', KEYS[i * 4 + 1], ARGV[i + 2], 'EX', ttl)
  redis.call('DEL', KEYS[i * 4 + 2], KEYS[i * 4 + 3], KEYS[i * 4 + 4])
end
return n`;

/**
 * The policy fence as it stands right now.
 *
 * Call this BEFORE the authoritative database read, never after: the point of
 * the value is that it predates the snapshot it will be quoted alongside.
 * Returns null when no invalidation has ever been recorded for this agent,
 * which is the ordinary state and is a perfectly good thing to quote back.
 */
export async function readPolicyFence(userId: string, agentId: string): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.policyFence(userId, agentId)));
}

/** The owner-claim fence for one tenant. Same rule: read it before the row. */
/**
 * Rotate one fence and drop the single value it guards, in one eval.
 *
 * The three-slot padding is `ROTATE_FENCE_LUA` working in groups of four: these
 * caches have one value key each, so the spare slots repeat it and the extra
 * DELs are no-ops. One script shared with the credential caches beats four
 * scripts that can drift apart.
 */
async function rotateFence(fenceKey: string, valueKey: string): Promise<boolean> {
  try {
    await redis().eval(
      ROTATE_FENCE_LUA,
      [fenceKey, valueKey, valueKey, valueKey],
      [String(FENCE_TTL_S), newFenceToken()]
    );
    return true;
  } catch {
    return false;
  }
}

export async function readOwnerFence(userId: string): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.ownerFence(userId)));
}

/** The failover-list fence for one agent. Same rule: read it before the row. */
export async function readFallbacksFence(userId: string, agentId: string): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.fallbacksFence(userId, agentId)));
}

/** The provider-list fence for one tenant. Same rule: read it before the row. */
export async function readProviderKeysFence(userId: string): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.providerKeysFence(userId)));
}

/** The credential/endpoint fence for one (agent, provider). Same rule: read it first. */
export async function readCredentialFence(
  agentId: string,
  provider: string
): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.credentialFence(agentId, provider)));
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

/**
 * Publish the endpoint for this (agent, provider), unless the credential changed
 * while this reader was reading it.
 *
 * `fence` is what `readCredentialFence` returned before the authoritative read.
 * Without it a rotation or an endpoint reset could purge the cache and then be
 * overwritten by an in-flight read that started earlier — the operator's change
 * lands, the purge succeeds, and the retired address keeps deciding where a
 * credential goes for a full TTL.
 *
 * Returns whether the value was actually published.
 */
export async function setCachedEndpoint(
  agentId: string,
  provider: string,
  endpoint: string,
  ttlSeconds = 60,
  fence: string | null = null
): Promise<boolean> {
  const res = await redis().eval(
    FENCED_FILL_LUA,
    [k.endpoint(agentId, provider), k.credentialFence(agentId, provider)],
    [endpoint, String(ttlSeconds), fence ?? ""]
  );
  return Number(res) === 1;
}

/**
 * Cached key material for this (agent, provider).
 *
 * With `credentialId`, this reads the BOUND namespace, whose value is a bundle
 * naming the credential the secret belongs to. The caller checks that name — see
 * the proxy's step 6 — because a cache entry that does not say which credential
 * it came from is exactly how one credential's secret reached another's address.
 */
export async function getCachedKey(
  agentId: string,
  provider: string,
  credentialId?: string
): Promise<string | null> {
  const cacheKey = credentialId ? k.credential(agentId, provider) : k.key(agentId, provider);
  return asCachedString(await redis().get<unknown>(cacheKey));
}

/**
 * Publish sealed key material, under the same fence as the endpoint above.
 *
 * The two are halves of one answer — which credential, sent where — so they are
 * guarded by ONE fence per (agent, provider). A rotation that moves the fence
 * therefore refuses the stale half of a pair as well as the stale whole.
 */
export async function setCachedKey(
  agentId: string,
  provider: string,
  sealed: string,
  ttlSeconds = 60,
  credentialId?: string,
  fence: string | null = null
): Promise<boolean> {
  const cacheKey = credentialId ? k.credential(agentId, provider) : k.key(agentId, provider);
  const res = await redis().eval(
    FENCED_FILL_LUA,
    [cacheKey, k.credentialFence(agentId, provider)],
    [sealed, String(ttlSeconds), fence ?? ""]
  );
  return Number(res) === 1;
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

/**
 * Fill the policy cache — unless an invalidation happened after this read began.
 *
 * `fence` is what `readPolicyFence` returned BEFORE the caller took its database
 * snapshot. A read that started before a mode change and finished after it is
 * carrying a value that is already wrong, and a plain SET would publish it over
 * the top of the invalidation for a full TTL.
 *
 * Two earlier attempts at this are worth naming, because both looked right:
 *
 *   * A plain DEL leaves nothing behind, so the stale fill lands afterwards and
 *     is served. That is the defect, not the fix.
 *   * A wall-clock TOMBSTONE **in the value key** fails twice over. The first
 *     legitimate fill overwrites the tombstone, so every later stale writer
 *     finds no marker and wins; and comparing `Date.now()` across two edge
 *     invocations makes correctness depend on clock agreement it does not have.
 *
 * The fence is a token in its own key. Fills never write it, so it cannot be
 * erased by the thing it guards, and equality needs no clock.
 *
 * Returns whether the value was published. A dropped fill is not an error: the
 * reader still returns its own value to its own caller, it simply does not
 * publish it, and the next request reads through to the database.
 */
export async function setCachedAgentPolicy(
  userId: string,
  agentId: string,
  serializedPolicy: string,
  ttlSeconds = 60,
  fence: string | null = null
): Promise<boolean> {
  const res = await redis().eval(
    FENCED_FILL_LUA,
    [k.policy(userId, agentId), k.policyFence(userId, agentId)],
    [serializedPolicy, String(ttlSeconds), fence ?? ""]
  );
  return Number(res) === 1;
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
/**
 * Invalidate the policy cache, and say whether it worked.
 *
 * Moves the fence and drops the value in ONE eval. Both halves matter and
 * neither is sufficient: dropping the value alone leaves an in-flight pre-change
 * read free to republish it, and moving the fence alone leaves the current stale
 * value being served until its TTL runs out.
 *
 * Returns false when the invalidation could not be recorded. Callers changing an
 * AUTHENTICATION setting must not report success on a durable database write
 * alone — until this returns true, the old value can still be deciding, and
 * `lib/fleet.ts` turns exactly this boolean into what the operator is told.
 */
export async function purgeAgentPolicy(userId: string, agentId: string): Promise<boolean> {
  return rotateFence(k.policyFence(userId, agentId), k.policy(userId, agentId));
}

export async function getCachedAgentFallbacks(
  userId: string,
  agentId: string
): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.fallbacks(userId, agentId)));
}

/**
 * Publish an agent's failover list, unless the operator changed it mid-read.
 *
 * Failover decides which provider a refused call is re-sent to, so a resurrected
 * list routes traffic to a credential that was deliberately taken out of it.
 */
export async function setCachedAgentFallbacks(
  userId: string,
  agentId: string,
  serializedFallbacks: string,
  ttlSeconds = 60,
  fence: string | null = null
): Promise<boolean> {
  const res = await redis().eval(
    FENCED_FILL_LUA,
    [k.fallbacks(userId, agentId), k.fallbacksFence(userId, agentId)],
    [serializedFallbacks, String(ttlSeconds), fence ?? ""]
  );
  return Number(res) === 1;
}

export async function purgeAgentFallbacks(userId: string, agentId: string): Promise<boolean> {
  return rotateFence(k.fallbacksFence(userId, agentId), k.fallbacks(userId, agentId));
}

// ── Owner-binding cache ──────────────────────────────────────────────────────
// The owner claim on a receipt is read per call, so it is cached like policy.
// Owner bindings change far less often than policy, hence the longer TTL. Not
// secret material — a published owner is public by definition.
export async function getCachedOwner(userId: string): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.owner(userId)));
}

/**
 * Publish the tenant's owner claim, unless it changed while this read was in
 * flight.
 *
 * THE MOST CONSEQUENTIAL OF THESE FENCES, and not because the data is more
 * sensitive than a provider key — it is not secret at all. It is because this
 * value gets SIGNED. `readCurrentOwner` feeds the proxy's `own` claim and
 * `signReceipt` puts it in a receipt, so a claim republished after the operator
 * withdrew or demoted it becomes a cryptographically valid assertion that
 * outlives the cache entry entirely. Meanwhile the public `/verify` profile
 * reads live Postgres. Without this, the product could issue two signed public
 * statements that disagree about the same tenant.
 */
export async function setCachedOwner(
  userId: string,
  serializedOwner: string,
  ttlSeconds = 300,
  fence: string | null = null
): Promise<boolean> {
  const res = await redis().eval(
    FENCED_FILL_LUA,
    [k.owner(userId), k.ownerFence(userId)],
    [serializedOwner, String(ttlSeconds), fence ?? ""]
  );
  return Number(res) === 1;
}

export async function purgeOwnerCache(userId: string): Promise<boolean> {
  return rotateFence(k.ownerFence(userId), k.owner(userId));
}

export async function getCachedProviderKeys(userId: string): Promise<string | null> {
  return asCachedString(await redis().get<unknown>(k.providerKeys(userId)));
}

/** Publish the tenant's provider list, unless a credential changed mid-read. */
export async function setCachedProviderKeys(
  userId: string,
  serializedProviders: string,
  ttlSeconds = 300,
  fence: string | null = null
): Promise<boolean> {
  const res = await redis().eval(
    FENCED_FILL_LUA,
    [k.providerKeys(userId), k.providerKeysFence(userId)],
    [serializedProviders, String(ttlSeconds), fence ?? ""]
  );
  return Number(res) === 1;
}

export async function purgeProviderKeysCache(userId: string): Promise<boolean> {
  return rotateFence(k.providerKeysFence(userId), k.providerKeys(userId));
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
export async function purgeAgentCaches(agentId: string, providers: string[]): Promise<boolean> {
  if (!providers.length) return true;
  // Groups of four, one per provider: the fence first, then the three value keys
  // it guards. Moving the fence is what stops a read that began before this
  // rotation from republishing the retired secret or the retired address after
  // the delete has already succeeded.
  const keys = providers.flatMap((p) => [
    k.credentialFence(agentId, p),
    k.key(agentId, p),
    k.credential(agentId, p),
    k.endpoint(agentId, p),
  ]);
  try {
    await redis().eval(
      ROTATE_FENCE_LUA,
      keys,
      [String(FENCE_TTL_S), ...providers.map(() => newFenceToken())]
    );
    return true;
  } catch {
    return false;
  }
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
