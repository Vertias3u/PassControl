import { describe, it, expect } from "vitest";
import { redisGate } from "./support/redis-gate";

/**
 * THE MONEY LANE MUST NOT PASS BY SKIPPING.
 *
 * `tests/holds.redis.test.ts` is the only place the reserve/settle/dispatch Lua
 * runs as itself, against a real Redis. It skips when SRH is unreachable, which
 * is right on a developer's machine — nobody should need Docker up to run the
 * unit suite — and completely wrong in CI, where a skipped money boundary is a
 * green build that proved nothing about the money boundary. The playbook says
 * so in as many words: a skip there "is not acceptable release evidence".
 *
 * The decision is extracted here because it is the thing worth testing. Testing
 * it inside the suite it gates is circular: if the gate is broken the suite does
 * not run, so nothing fails.
 */
describe("the real-Redis gate", () => {
  const url = "http://localhost:8079";

  it("runs when SRH is reachable, wherever it is", () => {
    expect(redisGate({ reachable: true, ci: false, url })).toEqual({ run: true });
    expect(redisGate({ reachable: true, ci: true, url })).toEqual({ run: true });
  });

  it("skips locally when SRH is not up", () => {
    const gate = redisGate({ reachable: false, ci: false, url });
    expect(gate.run).toBe(false);
    expect(gate.fail).toBeUndefined();
  });

  it("FAILS in CI when SRH is not up, rather than skipping", () => {
    const gate = redisGate({ reachable: false, ci: true, url });
    expect(gate.run).toBe(false);
    expect(gate.fail).toBeTruthy();
    // The message has to name the missing prerequisite, or a red lane in six
    // months' time reads as a broken test rather than a missing service.
    expect(gate.fail).toContain(url);
  });
});
