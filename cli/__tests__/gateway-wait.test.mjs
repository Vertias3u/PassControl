// The readiness wait, tested against a fake clock so a 150-second budget costs
// no wall time. Every probe is injected, so these are assertions about the
// DECISION the wait makes, not about how fast this machine compiles.
import { describe, expect, it } from "vitest";
import { waitForGateway } from "../gateway-wait.mjs";

/** A clock and a scheduler that advance only when the code under test waits. */
function fakeTime() {
  let t = 0;
  return { now: () => t, pause: async (ms) => { t += ms; } };
}

/** Answers `false` for the first `n` polls, then `true`. */
function readyAfter(n) {
  let calls = 0;
  return async () => ++calls > n;
}

describe("waitForGateway", () => {
  it("returns as soon as the gateway answers", async () => {
    const { now, pause } = fakeTime();
    const probeGateway = readyAfter(3);
    expect(await waitForGateway({ probeGateway, now, pause })).toBe(true);
    // It must not keep polling after a success.
    expect(now()).toBeLessThan(2000);
  });

  it("gives up at the base budget when nothing shows a sign of life", async () => {
    const { now, pause } = fakeTime();
    expect(
      await waitForGateway({
        probeGateway: async () => false,
        probePort: async () => false,
        now,
        pause,
        timeoutMs: 30_000,
      })
    ).toBe(false);
    // The point of the base budget: a dead start is reported quickly, not after
    // the long compile budget. Allow one poll interval of overshoot.
    expect(now()).toBeLessThan(31_000);
  });

  it("waits past the base budget while the port is listening", async () => {
    // The actual bug: the server binds the port immediately and then compiles
    // for ~30s. A flat 30s budget expired just before the first compile finished
    // and told a new self-hoster their stack was broken when it was not.
    const { now, pause } = fakeTime();
    const ready = await waitForGateway({
      probeGateway: readyAfter(200), // 200 × 250ms = 50s, past the 30s base
      probePort: async () => true,
      now,
      pause,
      timeoutMs: 30_000,
      compilingMs: 150_000,
    });
    expect(ready).toBe(true);
    expect(now()).toBeGreaterThan(30_000);
  });

  it("still gives up if compilation never finishes", async () => {
    const { now, pause } = fakeTime();
    expect(
      await waitForGateway({
        probeGateway: async () => false,
        probePort: async () => true,
        now,
        pause,
        timeoutMs: 30_000,
        compilingMs: 150_000,
      })
    ).toBe(false);
    expect(now()).toBeGreaterThanOrEqual(150_000);
  });

  it("stops the moment the supervising process is gone", async () => {
    // A crashed `next dev` frees nobody by being waited on. Without this the
    // extended budget would make a genuine failure SLOWER to report than the
    // bug it fixes — the whole reason the budget is conditional.
    const { now, pause } = fakeTime();
    let alive = true;
    const ready = await waitForGateway({
      probeGateway: async () => false,
      probePort: async () => true,
      processAlive: () => { const was = alive; alive = false; return was; },
      now,
      pause,
      timeoutMs: 30_000,
      compilingMs: 150_000,
    });
    expect(ready).toBe(false);
    expect(now()).toBeLessThan(2_000);
  });

  it("announces the extended wait exactly once", async () => {
    // Sitting silent for two minutes reads as a hang. Saying it every poll is
    // 600 lines of noise.
    const { now, pause } = fakeTime();
    let announced = 0;
    await waitForGateway({
      probeGateway: readyAfter(200),
      probePort: async () => true,
      onCompiling: () => { announced += 1; },
      now,
      pause,
      timeoutMs: 30_000,
      compilingMs: 150_000,
    });
    expect(announced).toBe(1);
  });
});
