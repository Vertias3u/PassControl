import { afterEach, describe, expect, it } from "vitest";

// Runs the REAL quota Lua through the same Upstash-compatible REST path used in
// production. A mock can assert command ordering, but only Redis can prove that
// an over-cap workspace does not mutate the shared counter.
const URL_ = process.env.TEST_UPSTASH_REDIS_REST_URL ?? "http://localhost:8079";
const TOKEN = process.env.TEST_UPSTASH_REDIS_REST_TOKEN ?? "passcontrol_local_dev_token";

async function srhReachable(): Promise<boolean> {
  try {
    const response = await fetch(URL_, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(["PING"]),
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const live = await srhReachable();
if (!live) {
  // eslint-disable-next-line no-console
  console.warn(
    `[cloud-beta-quota.redis.test] SKIPPED — no SRH at ${URL_}. ` +
      "Start it with: docker compose -f docker/compose.yml up -d"
  );
}

process.env.UPSTASH_REDIS_REST_URL = URL_;
process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
process.env.CLOUD_BETA_WORKSPACE_CALL_LIMIT = "2";
process.env.CLOUD_BETA_GLOBAL_CALL_LIMIT = "3";

const { consumeCloudBetaQuota } = await import("@/lib/cloud-beta-quota");
const { redis } = await import("@/lib/state/redis");

const NOW = new Date("2099-12-15T12:00:00.000Z");
const ATTACKER = `attacker-${crypto.randomUUID()}`;
const VICTIM = `victim-${crypto.randomUUID()}`;
const GLOBAL_KEY = "cloud-beta:2099-12:global";
const workspaceKey = (userId: string) => `cloud-beta:2099-12:workspace:${userId}`;

afterEach(async () => {
  if (!live) return;
  await redis().del(GLOBAL_KEY, workspaceKey(ATTACKER), workspaceKey(VICTIM));
});

describe.skipIf(!live)("Cloud beta quota — real Redis tenant isolation", () => {
  it("does not let an over-cap workspace consume another tenant's shared allowance", async () => {
    await expect(consumeCloudBetaQuota(ATTACKER, NOW)).resolves.toMatchObject({ ok: true });
    await expect(consumeCloudBetaQuota(ATTACKER, NOW)).resolves.toMatchObject({ ok: true });
    await expect(consumeCloudBetaQuota(ATTACKER, NOW)).resolves.toEqual({
      ok: false,
      reason: "workspace",
    });

    expect(Number(await redis().get(GLOBAL_KEY))).toBe(2);
    await expect(consumeCloudBetaQuota(VICTIM, NOW)).resolves.toEqual({
      ok: true,
      workspaceCount: 1,
      globalCount: 3,
    });
  });

  it("does not charge either admitted counter when the shared global cap refuses", async () => {
    await expect(consumeCloudBetaQuota(ATTACKER, NOW)).resolves.toMatchObject({ ok: true });
    await expect(consumeCloudBetaQuota(ATTACKER, NOW)).resolves.toMatchObject({ ok: true });
    await expect(consumeCloudBetaQuota(VICTIM, NOW)).resolves.toMatchObject({ ok: true });

    await expect(consumeCloudBetaQuota(VICTIM, NOW)).resolves.toEqual({
      ok: false,
      reason: "global",
    });
    expect(Number(await redis().get(workspaceKey(VICTIM)))).toBe(1);
    expect(Number(await redis().get(GLOBAL_KEY))).toBe(3);
  });
});
