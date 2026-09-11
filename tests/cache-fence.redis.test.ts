import { describe, it, expect, afterEach } from "vitest";
import { redisGate } from "./support/redis-gate";

/**
 * The invalidation fence, run as REAL Lua against a REAL Redis through SRH.
 *
 * THIS FILE EXISTS BECAUSE THE PREVIOUS FENCE SHIPPED BROKEN AND GREEN.
 *
 * `tests/redis-cache-serialization.test.ts` stubs Upstash's `EVAL` endpoint by
 * storing whatever value it is handed. That is right for what it tests — the
 * serialization boundary — and it means it cannot fail on the conditional part
 * of a conditional fill. The first version of this mechanism had a `readAt`
 * parameter that no call site ever passed, so the comparison ran against the
 * fill's own clock and could reject nothing; the suite was green throughout, and
 * an external reviewer found it by reading the argument list.
 *
 * So every assertion here goes through the exported production functions and
 * reads the real keys afterwards. Nothing in this file re-implements a script.
 *
 * Needs the local stack: `docker compose -f docker/compose.yml up -d`.
 * Skips loudly when unreachable, and FAILS in CI rather than skipping.
 */
const URL_ = process.env.TEST_UPSTASH_REDIS_REST_URL ?? "http://localhost:8079";
const TOKEN = process.env.TEST_UPSTASH_REDIS_REST_TOKEN ?? "passcontrol_local_dev_token";

async function srhReachable(): Promise<boolean> {
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(["PING"]),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const gate = redisGate({
  reachable: await srhReachable(),
  ci: process.env.CI === "true" || process.env.CI === "1",
  url: URL_,
});
const live = gate.run;
if (gate.fail) throw new Error(gate.fail);
if (!live) {
  // eslint-disable-next-line no-console
  console.warn(
    `[cache-fence.redis.test] SKIPPED — no SRH at ${URL_}. ` +
      "Start it with: docker compose -f docker/compose.yml up -d"
  );
}

process.env.UPSTASH_REDIS_REST_URL = URL_;
process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
const {
  redis,
  readOwnerFence,
  setCachedOwner,
  getCachedOwner,
  purgeOwnerCache,
  readFallbacksFence,
  setCachedAgentFallbacks,
  getCachedAgentFallbacks,
  purgeAgentFallbacks,
  readProviderKeysFence,
  setCachedProviderKeys,
  getCachedProviderKeys,
  purgeProviderKeysCache,
  readPolicyFence,
  setCachedAgentPolicy,
  getCachedAgentPolicy,
  purgeAgentPolicy,
  readCredentialFence,
  setCachedEndpoint,
  getCachedEndpoint,
  setCachedKey,
  getCachedKey,
  purgeAgentCaches,
} = await import("../lib/state/redis");

const USER = "u-fence";
const used: Array<[string, string]> = [];
function agent(): string {
  const id = `test-${crypto.randomUUID()}`;
  used.push([USER, id]);
  return id;
}

const mode = (r: "off" | "required") => JSON.stringify({ p: {}, s: null, r });

const usedTenants: string[] = [];
function tenant(): string {
  const id = `test-u-${crypto.randomUUID()}`;
  usedTenants.push(id);
  return id;
}

afterEach(async () => {
  const r = redis();
  for (const [uid, agid] of used.splice(0)) {
    const provKeys = await r.keys(`*:${agid}:*`);
    await r.del(`policy4:${uid}:${agid}`, `polgen:${uid}:${agid}`, ...(provKeys.length ? provKeys : []));
  }
  for (const uid of usedTenants.splice(0)) {
    const keys = await r.keys(`*${uid}*`);
    if (keys.length) await r.del(...keys);
  }
});

describe.skipIf(!live)("the policy cache fence", () => {
  it("drops a fill from a read that began before the invalidation", async () => {
    const agid = agent();

    // Reader A looks at the fence, then goes off to read the database.
    const fenceA = await readPolicyFence(USER, agid);

    // The owner turns sender proof on. Value gone, fence moved.
    expect(await purgeAgentPolicy(USER, agid)).toBe(true);
    expect(await getCachedAgentPolicy(USER, agid)).toBeNull();

    // Reader A finally lands, carrying the pre-change snapshot.
    const published = await setCachedAgentPolicy(USER, agid, mode("off"), 60, fenceA);

    expect(published).toBe(false);
    // Nothing was published, so the next request reads through to the database
    // and sees `required` — rather than being served `off` for a full TTL.
    expect(await getCachedAgentPolicy(USER, agid)).toBeNull();
  });

  it("keeps rejecting stale fills after a legitimate one has landed", async () => {
    // THE CASE THE SAME-KEY TOMBSTONE FAILED. The marker used to live in the
    // value key, so the first honest fill erased it and every later stale writer
    // found nothing in its way.
    const agid = agent();

    const fenceA = await readPolicyFence(USER, agid); // reader A, pre-change
    await purgeAgentPolicy(USER, agid);
    const fenceB = await readPolicyFence(USER, agid); // reader B, post-change

    // B is current and publishes.
    expect(await setCachedAgentPolicy(USER, agid, mode("required"), 60, fenceB)).toBe(true);
    expect(await getCachedAgentPolicy(USER, agid)).toBe(mode("required"));

    // A arrives late with the old world in hand. The fence is still there.
    expect(await setCachedAgentPolicy(USER, agid, mode("off"), 60, fenceA)).toBe(false);
    expect(await getCachedAgentPolicy(USER, agid)).toBe(mode("required"));
  });

  it("rejects in both directions, not only when the change is a tightening", async () => {
    // A stale fill that RELAXES enforcement is the security case, but a stale
    // fill that tightens it refuses traffic the owner has just permitted. Both
    // are the cache lying about the row; neither gets a pass.
    for (const [before, after] of [
      ["off", "required"],
      ["required", "off"],
    ] as const) {
      const agid = agent();
      const stale = await readPolicyFence(USER, agid);
      await purgeAgentPolicy(USER, agid);
      const fresh = await readPolicyFence(USER, agid);

      expect(await setCachedAgentPolicy(USER, agid, mode(after), 60, fresh)).toBe(true);
      expect(await setCachedAgentPolicy(USER, agid, mode(before), 60, stale)).toBe(false);
      expect(await getCachedAgentPolicy(USER, agid)).toBe(mode(after));
    }
  });

  it("moves the fence and drops the value in one step, never one without the other", async () => {
    const agid = agent();
    const before = await readPolicyFence(USER, agid);
    await setCachedAgentPolicy(USER, agid, mode("off"), 60, before);
    expect(await getCachedAgentPolicy(USER, agid)).toBe(mode("off"));

    await purgeAgentPolicy(USER, agid);

    // Both halves. Dropping the value alone leaves a pre-change reader free to
    // republish it; moving the fence alone leaves the stale value being served
    // until its TTL runs out.
    expect(await getCachedAgentPolicy(USER, agid)).toBeNull();
    const after = await readPolicyFence(USER, agid);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("publishes normally when nothing has changed", async () => {
    // The fence must not become a cache that never fills. This is the ordinary
    // path and it has to stay ordinary.
    const agid = agent();
    const fence = await readPolicyFence(USER, agid);
    expect(await setCachedAgentPolicy(USER, agid, mode("required"), 60, fence)).toBe(true);
    expect(await getCachedAgentPolicy(USER, agid)).toBe(mode("required"));
  });
});

describe.skipIf(!live)("the credential and endpoint fence", () => {
  const PROVIDER = "openai";

  it("refuses to republish a retired endpoint after a reset", async () => {
    const agid = agent();
    const fence = await readCredentialFence(agid, PROVIDER);

    // The operator removes a custom endpoint they no longer trust.
    expect(await purgeAgentCaches(agid, [PROVIDER])).toBe(true);

    // The read that started before that lands afterwards.
    const published = await setCachedEndpoint(
      agid,
      PROVIDER,
      "cred-1|https://retired.invalid/v1",
      60,
      fence
    );
    expect(published).toBe(false);
    expect(await getCachedEndpoint(agid, PROVIDER)).toBeNull();
  });

  it("refuses to republish a retired secret after a rotation", async () => {
    const agid = agent();
    const fence = await readCredentialFence(agid, PROVIDER);
    await purgeAgentCaches(agid, [PROVIDER]);

    // Both namespaces, because both are filled from an authoritative read and
    // both used to be plain SETs. The bound one is what a custom-endpoint
    // deployment writes; the bare one is what everything else writes.
    expect(
      await setCachedKey(agid, PROVIDER, JSON.stringify({ c: "cred-1", k: "sealed-old" }), 60, "cred-1", fence)
    ).toBe(false);
    expect(await setCachedKey(agid, PROVIDER, "sealed-old", 60, undefined, fence)).toBe(false);

    expect(await getCachedKey(agid, PROVIDER, "cred-1")).toBeNull();
    expect(await getCachedKey(agid, PROVIDER)).toBeNull();
  });

  it("guards the address and the secret with ONE fence, so a rotation invalidates the pair", async () => {
    // They are two halves of one answer — which credential, sent where. A
    // rotation that only invalidated one half is how a new secret reached an old
    // address while both looked individually current.
    const agid = agent();
    const stale = await readCredentialFence(agid, PROVIDER);
    await purgeAgentCaches(agid, [PROVIDER]);
    const fresh = await readCredentialFence(agid, PROVIDER);

    expect(await setCachedEndpoint(agid, PROVIDER, "cred-2|https://current.invalid/v1", 60, fresh)).toBe(true);
    // The old half cannot get back in beside the new one.
    expect(await setCachedKey(agid, PROVIDER, JSON.stringify({ c: "cred-2", k: "sealed-old" }), 60, "cred-2", stale)).toBe(false);
    expect(await getCachedKey(agid, PROVIDER, "cred-2")).toBeNull();
    expect(await getCachedEndpoint(agid, PROVIDER)).toBe("cred-2|https://current.invalid/v1");
  });

  it("rotates every named provider's fence, not just the first", async () => {
    const agid = agent();
    const providers = ["openai", "anthropic", "gemini"];
    const before = await Promise.all(providers.map((p) => readCredentialFence(agid, p)));

    await purgeAgentCaches(agid, providers);

    const after = await Promise.all(providers.map((p) => readCredentialFence(agid, p)));
    for (let i = 0; i < providers.length; i += 1) {
      expect(after[i]).not.toBeNull();
      expect(after[i]).not.toBe(before[i]);
      // Distinct per provider: one shared token would make a rotation on one
      // provider silently invalidate another's in-flight reads, which is not
      // wrong but hides which mutation actually happened.
      expect(after.filter((v) => v === after[i])).toHaveLength(1);
    }
  });
});


/**
 * T4-01 and its two siblings. The first pass fenced the policy cache and the
 * credential caches and stopped there, which left three caches carrying the
 * identical plain-DEL race: the owner claim, an agent's failover list, and the
 * tenant's provider list.
 *
 * The owner one is the worst of the three and not because its data is more
 * sensitive. A resurrected policy value expires in sixty seconds; a resurrected
 * OWNER claim is copied into a receipt and SIGNED, so the stale assertion
 * outlives the cache entry that produced it and keeps being verifiable. And
 * `/verify` reads live Postgres, so the product ends up making two signed public
 * statements that disagree about the same tenant.
 */
describe.skipIf(!live)("the owner-claim fence", () => {
  const published = JSON.stringify({ kind: "domain", subject: "old-owner.example", tier: "domain" });

  it("refuses to republish a withdrawn owner claim", async () => {
    const uid = tenant();
    // A read of the published claim begins.
    const fence = await readOwnerFence(uid);

    // The owner unpublishes it. Row updated, cache cleared.
    expect(await purgeOwnerCache(uid)).toBe(true);

    // The earlier read lands afterwards, carrying the withdrawn claim.
    expect(await setCachedOwner(uid, published, 300, fence)).toBe(false);
    // Nothing to resurrect, so the next call reads Postgres and signs no `own`.
    expect(await getCachedOwner(uid)).toBeNull();
  });

  it("keeps refusing after a fresh claim has been published", async () => {
    const uid = tenant();
    const stale = await readOwnerFence(uid);
    await purgeOwnerCache(uid);
    const fresh = await readOwnerFence(uid);

    const demoted = JSON.stringify({ kind: "domain", subject: "old-owner.example", tier: "self" });
    expect(await setCachedOwner(uid, demoted, 300, fresh)).toBe(true);
    // A demotion is the direction that matters most: the stale entry claims a
    // VERIFIED tier the tenant no longer holds.
    expect(await setCachedOwner(uid, published, 300, stale)).toBe(false);
    expect(await getCachedOwner(uid)).toBe(demoted);
  });

  it("publishes normally when nothing has changed", async () => {
    const uid = tenant();
    const fence = await readOwnerFence(uid);
    expect(await setCachedOwner(uid, published, 300, fence)).toBe(true);
    expect(await getCachedOwner(uid)).toBe(published);
  });
});

describe.skipIf(!live)("the failover-list and provider-list fences", () => {
  it("refuses a failover list read before the operator changed it", async () => {
    // Failover decides WHICH PROVIDER a call is re-sent to. A resurrected list
    // sends traffic to a credential the operator has just removed from it.
    const uid = tenant();
    const agid = `a-${crypto.randomUUID()}`;
    used.push([uid, agid]);
    const fence = await readFallbacksFence(uid, agid);
    expect(await purgeAgentFallbacks(uid, agid)).toBe(true);

    const old = JSON.stringify([{ provider: "groq", model: "llama-3.1-8b" }]);
    expect(await setCachedAgentFallbacks(uid, agid, old, 60, fence)).toBe(false);
    expect(await getCachedAgentFallbacks(uid, agid)).toBeNull();
  });

  it("refuses a provider list read before a credential was removed", async () => {
    const uid = tenant();
    const fence = await readProviderKeysFence(uid);
    expect(await purgeProviderKeysCache(uid)).toBe(true);

    expect(await setCachedProviderKeys(uid, JSON.stringify(["openai", "anthropic"]), 300, fence)).toBe(false);
    expect(await getCachedProviderKeys(uid)).toBeNull();
  });

  it("publishes both normally when nothing has changed", async () => {
    const uid = tenant();
    const agid = `a-${crypto.randomUUID()}`;
    used.push([uid, agid]);
    const list = JSON.stringify([{ provider: "groq", model: "llama-3.1-8b" }]);
    expect(await setCachedAgentFallbacks(uid, agid, list, 60, await readFallbacksFence(uid, agid))).toBe(true);
    expect(await setCachedProviderKeys(uid, JSON.stringify(["openai"]), 300, await readProviderKeysFence(uid))).toBe(true);
  });
});
