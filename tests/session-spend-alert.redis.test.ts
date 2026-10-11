import { describe, it, expect, afterEach } from "vitest";
import { redisGate } from "./support/redis-gate";

// Candidate 3 (owner, 2026-10-10): "this session passed $X". The per-session spend
// total that decides when to alert, as real commands on a real Redis through SRH.
// It ALERTS and never refuses, so it lives outside the hold scripts: a lost counter
// can only re-send or miss one alert, never move money.
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
const gate = redisGate({ reachable: await srhReachable(), ci: process.env.CI === "true" || process.env.CI === "1", url: URL_ });
if (gate.fail) throw new Error(gate.fail);
process.env.UPSTASH_REDIS_REST_URL = URL_;
process.env.UPSTASH_REDIS_REST_TOKEN = TOKEN;
const { addSessionSpend, SESSION_SPEND_TTL_S } = await import("../lib/state/redis");
const { redis } = await import("../lib/state/redis");

const used: string[] = [];
afterEach(async () => {
  for (const agid of used.splice(0)) {
    const keys = await redis().keys(`ssp:${agid}:*`);
    if (keys.length) await redis().del(...keys);
  }
});
const agent = () => {
  const id = `test-${crypto.randomUUID()}`;
  used.push(id);
  return id;
};

describe.skipIf(!gate.run)("addSessionSpend", () => {
  it("returns the running total per session, and expires after the idle window", async () => {
    const a = agent();
    expect(await addSessionSpend(a, "s1", 300)).toEqual({ total: 300 });
    expect(await addSessionSpend(a, "s1", 450)).toEqual({ total: 750 });
    expect(await addSessionSpend(a, "s2", 10)).toEqual({ total: 10 });
    expect(await redis().ttl(`ssp:${a}:s1`)).toBeGreaterThan(SESSION_SPEND_TTL_S - 10);
  });

  it("never builds a key from an id the gateway would not accept", async () => {
    const a = agent();
    expect(await addSessionSpend(a, "bad id", 5)).toBeNull();
    expect(await redis().keys(`ssp:${a}:*`)).toEqual([]);
  });
});
