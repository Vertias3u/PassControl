import { describe, expect, it } from "vitest";
import {
  clampToBounds,
  criticalSpring,
  decayStep,
  panBounds,
  releaseVelocity,
  rubberband,
} from "@/lib/graph-physics";

// The control graph's pan and zoom physics (apple-design: momentum, rubber-band,
// critically damped springs). Pure functions; ControlGraph drives them per frame.

describe("release velocity", () => {
  it("reads the speed of the last stretch of the drag, in units per ms", () => {
    const v = releaseVelocity([
      { x: 0, y: 0, t: 0 },
      { x: 10, y: 0, t: 40 },
      { x: 30, y: -10, t: 80 },
    ]);
    expect(v.vx).toBeCloseTo(30 / 80);
    expect(v.vy).toBeCloseTo(-10 / 80);
  });

  it("is zero when the pointer paused before letting go", () => {
    expect(releaseVelocity([{ x: 0, y: 0, t: 0 }, { x: 40, y: 0, t: 10 }, { x: 40, y: 0, t: 400 }])).toEqual({ vx: 0, vy: 0 });
    expect(releaseVelocity([])).toEqual({ vx: 0, vy: 0 });
  });

  it("is zero when the pointer was held still before release (no move events fire)", () => {
    const samples = [{ x: 0, y: 0, t: 0 }, { x: 40, y: 0, t: 40 }];
    expect(releaseVelocity(samples, 300)).toEqual({ vx: 0, vy: 0 });
    expect(releaseVelocity(samples, 60).vx).toBeCloseTo(1);
  });
});

describe("momentum", () => {
  it("decays at Apple's scroll rate and travels the projected distance", () => {
    // project(v) = v · d / (1 − d) with d = 0.998 per ms (Designing Fluid Interfaces).
    let x = 0;
    let v = 1; // units per ms
    for (let i = 0; i < 5000; i += 1) ({ x, v } = decayStep(x, v, 1));
    expect(x).toBeCloseTo((1 * 0.998) / (1 - 0.998), -1);
    expect(Math.abs(v)).toBeLessThan(0.0001);
  });
});

describe("rubber-band", () => {
  it("follows less the further past the edge it is dragged, and never reaches the overshoot", () => {
    const small = rubberband(20, 1000);
    const large = rubberband(400, 1000);
    expect(small).toBeLessThan(20);
    expect(large).toBeLessThan(400);
    expect(large / 400).toBeLessThan(small / 20);
    expect(rubberband(-100, 1000)).toBeCloseTo(-rubberband(100, 1000));
  });
});

describe("pan bounds", () => {
  it("keeps at least 40% of the content on screen at any zoom", () => {
    const b = panBounds(1000, 600, 1);
    expect(b).toEqual({ minX: -600, maxX: 600, minY: -360, maxY: 360 });
    expect(clampToBounds({ x: 900, y: -500, k: 1 }, b)).toEqual({ x: 600, y: -360, k: 1 });
  });
});

describe("critically damped spring", () => {
  it("arrives without overshooting, and starts from the current value", () => {
    const omega = (2 * Math.PI) / 0.35;
    let max = 0;
    for (let t = 0; t <= 1; t += 0.01) {
      const { x } = criticalSpring(0, 0, 100, omega, t);
      max = Math.max(max, x);
    }
    expect(max).toBeLessThanOrEqual(100.0001);
    expect(criticalSpring(0, 0, 100, omega, 0).x).toBe(0);
    expect(criticalSpring(0, 0, 100, omega, 1).x).toBeCloseTo(100, 1);
  });

  it("carries an initial velocity instead of cutting it", () => {
    const omega = (2 * Math.PI) / 0.35;
    const still = criticalSpring(0, 0, 100, omega, 0.02).x;
    const moving = criticalSpring(0, 2000, 100, omega, 0.02).x;
    expect(moving).toBeGreaterThan(still);
  });
});
