// 1.9.0 loop breaker: the counting script, as REAL Lua on a REAL Redis through SRH.
// One eval per call: refuse while paused, count this fingerprint inside the window,
// and trip the pause on the Nth repeat, atomically, so exactly one caller sees "tripped"
// (and sends the one alert) however many arrive at once.
import { afterEach, describe, expect, it } from "vitest";
import { redisGate } from "./support/redis-gate";

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
  console.warn(`[loop-breaker.redis.test] SKIPPED — no SRH at ${URL_}.`);
}

process.env.UPSTASH_REDIS_REST_URL = URL_;
process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;

const { checkLoop } = await import("@/lib/state/runaway");
const { redis } = await import("@/lib/state/redis");

const AGENT = `loop-test-${crypto.randomUUID()}`;
const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);

afterEach(async () => {
  if (!live) return;
  await redis().del(`loop:pause:${AGENT}`, `loop:fp:${AGENT}:${FP_A}`, `loop:fp:${AGENT}:${FP_B}`);
});

describe.runIf(live)("checkLoop on real Redis", () => {
  it("lets N-1 repeats through, trips on the Nth, then refuses every call while paused", async () => {
    for (let i = 0; i < 2; i++) expect(await checkLoop(AGENT, FP_A, 3)).toMatchObject({ state: "ok" });
    const tripped = await checkLoop(AGENT, FP_A, 3);
    expect(tripped).toMatchObject({ state: "tripped" });
    expect(tripped!.retryAfterS).toBe(900);
    // The pause covers the agent, not only the repeated request.
    const other = await checkLoop(AGENT, FP_B, 3);
    expect(other).toMatchObject({ state: "paused" });
    expect(other!.retryAfterS).toBeGreaterThan(890);
    expect(other!.retryAfterS).toBeLessThanOrEqual(900);
  });

  it("counts each fingerprint on its own", async () => {
    for (let i = 0; i < 2; i++) {
      expect(await checkLoop(AGENT, FP_A, 3)).toMatchObject({ state: "ok" });
      expect(await checkLoop(AGENT, FP_B, 3)).toMatchObject({ state: "ok" });
    }
  });

  it("forgets repeats older than the window", async () => {
    expect(await checkLoop(AGENT, FP_A, 2, { windowMs: 150, pauseMs: 60_000 })).toMatchObject({ state: "ok" });
    await new Promise((r) => setTimeout(r, 300));
    expect(await checkLoop(AGENT, FP_A, 2, { windowMs: 150, pauseMs: 60_000 })).toMatchObject({ state: "ok" });
  });

  it("lifts the pause by itself when it runs out", async () => {
    await checkLoop(AGENT, FP_A, 2, { windowMs: 60_000, pauseMs: 200 });
    expect(await checkLoop(AGENT, FP_A, 2, { windowMs: 60_000, pauseMs: 200 })).toMatchObject({ state: "tripped" });
    await new Promise((r) => setTimeout(r, 350));
    expect(await checkLoop(AGENT, FP_B, 2, { windowMs: 60_000, pauseMs: 200 })).toMatchObject({ state: "ok" });
  });

  it("trips exactly once under a burst, so one alert is sent", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () => checkLoop(AGENT, FP_A, 4)));
    expect(results.filter((r) => r?.state === "tripped")).toHaveLength(1);
    expect(results.filter((r) => r?.state === "ok")).toHaveLength(3);
    expect(results.filter((r) => r?.state === "paused")).toHaveLength(8);
  });
});

describe("checkLoop when Redis cannot answer", () => {
  it("returns null, which the proxy reads as fail open", async () => {
    const down = () => ({ eval: async () => { throw new Error("down"); } });
    expect(await checkLoop("agent-x", FP_A, 3, { redisClient: down as never })).toBeNull();
  });
});
