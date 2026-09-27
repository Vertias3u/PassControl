import { afterEach, describe, expect, it } from "vitest";
import { redisGate } from "./support/redis-gate";

// Session 02: a pre-existing budget is NOT a fresh grant after migration.
// 0055 adds nullable markers with no backfill; 0056 leaves them untouched.
// The populated upgrade fixture independently confirmed an existing budget of
// 10,000,000, checkpoint spend of 1,000,000, and both markers still NULL.
// This reproduces that boundary after legacy Redis loss, using production Lua.
//
// 0057 is the repair, and it changes the classification exactly as this file's
// first version anticipated: an agent with recorded spend gets
// `budget_state_established_at` backfilled while `budget_epoch` stays NULL, so
// the fixtures below pass `{ epoch: null, established: true }` to obtain it.
// The old budget is still an old budget — it is not reinterpreted as a grant.
//
// Needs SRH: `docker compose -f docker/compose.yml up -d`, or CI's redis+srh
// services. Gated exactly like holds.redis.test.ts: skips locally when SRH is
// unreachable, and FAILS on CI, where a skipped money boundary is no evidence.
// It had no gate at all, so it failed every local `npm test` (and so every
// pre-push hook) on a machine without the stack.
const url = process.env.TEST_UPSTASH_REDIS_REST_URL ?? "http://localhost:8079";
const token = process.env.TEST_UPSTASH_REDIS_REST_TOKEN ?? "passcontrol_local_dev_token";

async function srhReachable(): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
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
  url,
});
// Thrown at module load, so the CI lane goes red instead of passing with skips.
if (gate.fail) throw new Error(gate.fail);
if (!gate.run) {
  // eslint-disable-next-line no-console
  console.warn(
    `[holds-legacy-cutover.redis.test] SKIPPED — no SRH at ${url}. ` +
      "Start it with: docker compose -f docker/compose.yml up -d"
  );
}

process.env.UPSTASH_REDIS_REST_URL = url;
process.env.UPSTASH_REDIS_REST_TOKEN = token;
const { openHold } = await import("../lib/state/holds");
const { redis } = await import("../lib/state/redis");

describe.skipIf(!gate.run)("legacy budget state at the holds cutover", () => {
  const agents: string[] = [];
  const agent = () => {
    const id = `test-legacy-cutover-${crypto.randomUUID()}`;
    agents.push(id);
    return id;
  };

  afterEach(async () => {
    for (const agentId of agents.splice(0)) {
      const keys = await redis().keys(`*${agentId}*`);
      if (keys.length) await redis().del(...keys);
    }
  });

  it("refuses lost legacy state instead of restoring an existing budget at cutover", async () => {
    const agentId = agent();
    const existingBudget = 10_000_000;
    const previouslySpent = 1_000_000;
    const estimate = 9_500_000;
    expect(previouslySpent + estimate).toBeGreaterThan(existingBudget);
    // All legacy keys are absent after loss. No writers remain and there are no
    // outstanding holds, so a pause/drain alone cannot repair this schedule.
    expect(await redis().exists(`epoch:${agentId}`, `spent:${agentId}`)).toBe(0);
    const result = await openHold({
      agentId, attemptId: crypto.randomUUID(), estimate, capTokens: existingBudget,
      budgetState: { epoch: null, established: true },
    });
    const state = {
      admitted: result.ok,
      spent: Number(await redis().get(`spent:${agentId}`)),
      reserved: Number(await redis().get(`reserved:${agentId}`)),
    };
    expect(state, "legacy spend must remain protected or admission must be unavailable")
      .toMatchObject({ admitted: false, reserved: 0 });
    expect(result.reason).toBe("state");
    // A refusal this build cannot vouch for must not ask Postgres to record an
    // epoch for the state it just refused to read.
    expect(result.epochToPersist).toBeUndefined();
  });

  it("adopts legacy counters that are still there rather than bricking the agent", async () => {
    // The ordinary cutover, and the one the fix must not break: same agent, same
    // budget, Redis intact. The reservation is refused BY THE CAP, against the
    // 1,000,000 it really spent — which is the proof that the counter was adopted
    // and not re-seeded at zero.
    const agentId = agent();
    await redis().set(`spent:${agentId}`, 1_000_000);
    const result = await openHold({
      agentId, attemptId: crypto.randomUUID(), estimate: 9_500_000, capTokens: 10_000_000,
      budgetState: { epoch: null, established: true },
    });
    expect(result).toMatchObject({ ok: false, reason: "tokens" });
    expect(Number(await redis().get(`spent:${agentId}`))).toBe(1_000_000);
    // Adoption mints the generation this agent never had, and the caller owes
    // Postgres that value — without it the agent stays unfenced forever.
    expect(result.epochToPersist).toBeTruthy();
    expect(await redis().get(`epoch:${agentId}`)).toBe(result.epochToPersist);
    // Both dimensions now exist, which is what makes the four-counter presence
    // check enforceable on every later call.
    expect(await redis().exists(
      `reserved:${agentId}`, `spent:${agentId}`,
      `reserved_cost:${agentId}`, `spent_cost:${agentId}`, `acctfmt:${agentId}`,
    )).toBe(5);
  });

  it("refuses a legacy agent whose cost counter is gone while its cost cap is not", async () => {
    // The asymmetry the adoption rule turns on: a dimension is required only if a
    // cap enforces it. Tokens are present here, cost is not, and the cost cap has
    // nothing left to be enforced against.
    const agentId = agent();
    await redis().set(`spent:${agentId}`, 1_000_000);
    const result = await openHold({
      agentId, attemptId: crypto.randomUUID(), estimate: 10, capTokens: 10_000_000,
      estimateMicrocents: 10, capMicrocents: 500_000,
      budgetState: { epoch: null, established: true },
    });
    expect(result).toMatchObject({ ok: false, reason: "state" });
  });

  it("still first-inits a genuinely new grant at zero", async () => {
    // The population 0055 protected, unchanged: budgeted, never spent, no
    // markers. It must keep working with no operator in the loop.
    const agentId = agent();
    const result = await openHold({
      agentId, attemptId: crypto.randomUUID(), estimate: 10, capTokens: 1_000,
      budgetState: { epoch: null, established: false },
    });
    expect(result).toMatchObject({ ok: true, reserved: 10 });
    expect(Number(await redis().get(`spent:${agentId}`))).toBe(0);
    expect(result.epochToPersist).toBeTruthy();
  });
});
