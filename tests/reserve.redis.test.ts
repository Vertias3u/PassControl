import { describe, it, expect, afterEach } from "vitest";

// Budget-reserve integration test — runs the REAL RESERVE_LUA on a REAL Redis
// through SRH (the same @upstash/redis REST path production uses), because the
// atomic reserve is the money boundary and a mocked INCRBY can't catch a
// regression inside the Lua itself (e.g. `cap >= 0` → `cap > 0` silently makes
// a zero-token cap unlimited).
//
// Needs the local stack: `docker compose -f docker/compose.yml up -d`
// (or CI's redis+srh services). Skips — loudly — when unreachable, so the
// unit-test run stays green on machines without Docker; CI always runs it.
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

const live = await srhReachable();
if (!live) {
  // eslint-disable-next-line no-console
  console.warn(
    `[reserve.redis.test] SKIPPED — no SRH at ${URL_}. ` +
      "Start it with: docker compose -f docker/compose.yml up -d"
  );
}

// Point the production client at the test stack BEFORE importing the module
// (redis() lazily calls Redis.fromEnv() on first use).
process.env.UPSTASH_REDIS_REST_URL = URL_;
process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
const { reserveBudget, reconcileBudget, redis } = await import("../lib/state/redis");

const MARKER_TTL = 60;
const usedAgents: string[] = [];

function agent(): { agentId: string; jti: string } {
  const agentId = `test-${crypto.randomUUID()}`;
  usedAgents.push(agentId);
  return { agentId, jti: crypto.randomUUID() };
}

afterEach(async () => {
  const r = redis();
  for (const agid of usedAgents.splice(0)) {
    const markers = await r.keys(`reserve:${agid}:*`);
    const costMarkers = await r.keys(`reserve_cost:${agid}:*`);
    await r.del(
      `reserved:${agid}`,
      `spent:${agid}`,
      `reserved_cost:${agid}`,
      `spent_cost:${agid}`,
      ...markers,
      ...costMarkers
    );
  }
});

describe.skipIf(!live)("reserveBudget — the atomic budget-reserve Lua (real Redis via SRH)", () => {
  it("reserves under the cap and returns the running reservation", async () => {
    const { agentId, jti } = agent();
    const r = await reserveBudget({ agentId, jti, estimate: 40, capTokens: 100, markerTtlSeconds: MARKER_TTL });
    expect(r).toEqual({ ok: true, reserved: 40 });
  });

  it("allows landing exactly ON the cap (reserved + spent == cap)", async () => {
    const { agentId, jti } = agent();
    const r = await reserveBudget({ agentId, jti, estimate: 100, capTokens: 100, markerTtlSeconds: MARKER_TTL });
    expect(r.ok).toBe(true);
  });

  it("rejects over the cap AND rolls the reservation back (no leaked reserve)", async () => {
    const { agentId } = agent();
    const first = await reserveBudget({ agentId, jti: "j1", estimate: 60, capTokens: 100, markerTtlSeconds: MARKER_TTL });
    expect(first.ok).toBe(true);

    const over = await reserveBudget({ agentId, jti: "j2", estimate: 41, capTokens: 100, markerTtlSeconds: MARKER_TTL });
    expect(over.ok).toBe(false);
    // The rejected 41 must be DECRBY'd back out — reserved is still exactly 60…
    expect(Number(await redis().get(`reserved:${agentId}`))).toBe(60);
    // …so the remaining 40 is still reservable.
    const fits = await reserveBudget({ agentId, jti: "j3", estimate: 40, capTokens: 100, markerTtlSeconds: MARKER_TTL });
    expect(fits.ok).toBe(true);
  });

  it("reserves under the cost cap and returns the running cost reservation", async () => {
    const { agentId, jti } = agent();
    const r = await reserveBudget({
      agentId,
      jti,
      estimate: 40,
      estimateMicrocents: 600,
      capTokens: null,
      capMicrocents: 1_000,
      markerTtlSeconds: MARKER_TTL,
    });
    expect(r).toEqual({ ok: true, reserved: 40, reservedMicrocents: 600 });
  });

  it("rejects over the cost cap AND rolls token+cost reservations back atomically", async () => {
    const { agentId } = agent();
    const first = await reserveBudget({
      agentId,
      jti: "j1",
      estimate: 60,
      estimateMicrocents: 600,
      capTokens: 1_000,
      capMicrocents: 1_000,
      markerTtlSeconds: MARKER_TTL,
    });
    expect(first.ok).toBe(true);

    const over = await reserveBudget({
      agentId,
      jti: "j2",
      estimate: 10,
      estimateMicrocents: 401,
      capTokens: 1_000,
      capMicrocents: 1_000,
      markerTtlSeconds: MARKER_TTL,
    });
    expect(over).toEqual({ ok: false, reason: "cost" });
    expect(Number(await redis().get(`reserved:${agentId}`))).toBe(60);
    expect(Number(await redis().get(`reserved_cost:${agentId}`))).toBe(600);

    const fits = await reserveBudget({
      agentId,
      jti: "j3",
      estimate: 40,
      estimateMicrocents: 400,
      capTokens: 1_000,
      capMicrocents: 1_000,
      markerTtlSeconds: MARKER_TTL,
    });
    expect(fits.ok).toBe(true);
  });

  it("counts already-spent micro-cents against the cost cap", async () => {
    const { agentId } = agent();
    await redis().set(`spent_cost:${agentId}`, 900);
    expect(
      (
        await reserveBudget({
          agentId,
          jti: "j1",
          estimate: 1,
          estimateMicrocents: 101,
          capTokens: null,
          capMicrocents: 1_000,
          markerTtlSeconds: MARKER_TTL,
        })
      ).ok
    ).toBe(false);
    expect(
      (
        await reserveBudget({
          agentId,
          jti: "j2",
          estimate: 1,
          estimateMicrocents: 100,
          capTokens: null,
          capMicrocents: 1_000,
          markerTtlSeconds: MARKER_TTL,
        })
      ).ok
    ).toBe(true);
  });

  it("blocks a cost-capped agent while an equivalent token-capped agent still fits", async () => {
    const tokenOnly = agent();
    const costOnly = agent();

    expect(
      (
        await reserveBudget({
          ...tokenOnly,
          estimate: 10,
          estimateMicrocents: 60,
          capTokens: 100,
          capMicrocents: null,
          markerTtlSeconds: MARKER_TTL,
        })
      ).ok
    ).toBe(true);
    expect(
      (
        await reserveBudget({
          ...costOnly,
          estimate: 10,
          estimateMicrocents: 60,
          capTokens: null,
          capMicrocents: 50,
          markerTtlSeconds: MARKER_TTL,
        })
      ).ok
    ).toBe(false);
  });

  it("counts already-spent tokens against the cap", async () => {
    const { agentId } = agent();
    await redis().set(`spent:${agentId}`, 90);
    expect((await reserveBudget({ agentId, jti: "j1", estimate: 11, capTokens: 100, markerTtlSeconds: MARKER_TTL })).ok).toBe(false);
    expect((await reserveBudget({ agentId, jti: "j2", estimate: 10, capTokens: 100, markerTtlSeconds: MARKER_TTL })).ok).toBe(true);
  });

  it("a ZERO cap blocks every reserve (cap=0 is not 'unlimited')", async () => {
    const { agentId, jti } = agent();
    const r = await reserveBudget({ agentId, jti, estimate: 1, capTokens: 0, markerTtlSeconds: MARKER_TTL });
    expect(r.ok).toBe(false);
    expect(Number(await redis().get(`reserved:${agentId}`) ?? 0)).toBe(0);
  });

  it("a null cap is unlimited", async () => {
    const { agentId, jti } = agent();
    const r = await reserveBudget({ agentId, jti, estimate: 10_000_000, capTokens: null, markerTtlSeconds: MARKER_TTL });
    expect(r.ok).toBe(true);
  });

  it("writes the per-jti reserve marker (crash self-heal breadcrumb)", async () => {
    const { agentId, jti } = agent();
    await reserveBudget({
      agentId,
      jti,
      estimate: 25,
      estimateMicrocents: 75,
      capTokens: 100,
      capMicrocents: 1_000,
      markerTtlSeconds: MARKER_TTL,
    });
    expect(Number(await redis().get(`reserve:${agentId}:${jti}`))).toBe(25);
    expect(Number(await redis().get(`reserve_cost:${agentId}:${jti}`))).toBe(75);
  });

  it("reconcileBudget releases the estimate, records actual spend, drops the marker", async () => {
    const { agentId, jti } = agent();
    await reserveBudget({
      agentId,
      jti,
      estimate: 50,
      estimateMicrocents: 500,
      capTokens: 100,
      capMicrocents: 1_000,
      markerTtlSeconds: MARKER_TTL,
    });
    await reconcileBudget({
      agentId,
      jti,
      estimate: 50,
      estimateMicrocents: 500,
      actualTokens: 30,
      actualMicrocents: 450,
    });

    expect(Number(await redis().get(`reserved:${agentId}`))).toBe(0);
    expect(Number(await redis().get(`spent:${agentId}`))).toBe(30);
    expect(Number(await redis().get(`reserved_cost:${agentId}`))).toBe(0);
    expect(Number(await redis().get(`spent_cost:${agentId}`))).toBe(450);
    expect(await redis().exists(`reserve:${agentId}:${jti}`)).toBe(0);
    expect(await redis().exists(`reserve_cost:${agentId}:${jti}`)).toBe(0);
  });
});
