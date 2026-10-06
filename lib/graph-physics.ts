// Pan and zoom physics for the control graph (components/dashboard/ControlGraph).
//
// From Apple's "Designing Fluid Interfaces" (WWDC 2018), via Emil Kowalski's
// apple-design skill: a released drag keeps the finger's velocity and decays
// like a scroll; dragging past an edge resists progressively instead of
// stopping dead; settling moves on a critically damped spring, which never
// overshoots and always starts from where the view is right now, so it can be
// grabbed again mid-flight. Pure functions: the component drives them per frame
// and skips them entirely when motion is off (lib/motion.ts).

export interface PointerSample {
  x: number;
  y: number;
  /** ms */
  t: number;
}

export interface PanBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Apple's scroll deceleration rate, per millisecond. */
export const DECELERATION_RATE = 0.998;

/** How far back to look when reading the release velocity. */
const VELOCITY_WINDOW_MS = 100;
/** A pointer still for longer than this before letting go was held, not thrown. */
const HOLD_BEFORE_RELEASE_MS = 80;

/**
 * Velocity at release, in view units per ms, from the last stretch of the
 * drag. A pointer that paused before letting go has none: a hold then release
 * must not fling.
 */
export function releaseVelocity(samples: PointerSample[], releasedAt?: number): { vx: number; vy: number } {
  if (samples.length < 2) return { vx: 0, vy: 0 };
  const last = samples[samples.length - 1]!;
  // pointermove stops firing while the pointer is still, so a pause shows up as
  // a gap before the release, not as a sample.
  if (releasedAt !== undefined && releasedAt - last.t > HOLD_BEFORE_RELEASE_MS) return { vx: 0, vy: 0 };
  let first = last;
  for (let i = samples.length - 2; i >= 0; i -= 1) {
    if (last.t - samples[i]!.t > VELOCITY_WINDOW_MS) break;
    first = samples[i]!;
  }
  const dt = last.t - first.t;
  if (dt <= 0) return { vx: 0, vy: 0 };
  return { vx: (last.x - first.x) / dt, vy: (last.y - first.y) / dt };
}

/** One frame of momentum: move at the current velocity, then decay it. */
export function decayStep(x: number, v: number, dtMs: number, rate = DECELERATION_RATE): { x: number; v: number } {
  return { x: x + v * dtMs, v: v * Math.pow(rate, dtMs) };
}

/**
 * Apple's rubber-band: how far the content follows an overshoot of
 * `overshoot` past an edge, for a viewport `dimension` wide. Always less than
 * the overshoot, and proportionally less the further you pull.
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  const sign = Math.sign(overshoot);
  const distance = Math.abs(overshoot);
  return sign * ((distance * dimension * constant) / (dimension + constant * distance));
}

/** Pan limits that keep at least 40% of the content on screen at zoom `k`. */
export function panBounds(width: number, height: number, k: number): PanBounds {
  return {
    minX: width * (0.4 - k),
    maxX: width * 0.6,
    minY: height * (0.4 - k),
    maxY: height * 0.6,
  };
}

export function clampToBounds<T extends { x: number; y: number }>(view: T, bounds: PanBounds): T {
  return {
    ...view,
    x: Math.min(bounds.maxX, Math.max(bounds.minX, view.x)),
    y: Math.min(bounds.maxY, Math.max(bounds.minY, view.y)),
  };
}

/** A raw pan position with rubber-band resistance applied outside the bounds. */
export function resistBeyond(value: number, min: number, max: number, dimension: number): number {
  if (value > max) return max + rubberband(value - max, dimension);
  if (value < min) return min + rubberband(value - min, dimension);
  return value;
}

/**
 * Critically damped spring (damping ratio 1), solved exactly:
 * x(t) = target + (x0 − target + (v0 + ω(x0 − target))·t)·e^(−ωt).
 * ω = 2π / response. `v0` and the returned `v` are in units per second.
 */
export function criticalSpring(
  x0: number,
  v0: number,
  target: number,
  omega: number,
  tSeconds: number
): { x: number; v: number } {
  const d0 = x0 - target;
  const b = v0 + omega * d0;
  const decay = Math.exp(-omega * tSeconds);
  return {
    x: target + (d0 + b * tSeconds) * decay,
    v: (b - omega * (d0 + b * tSeconds)) * decay,
  };
}

/** Apple's default UI spring response, in seconds. */
export const SPRING_RESPONSE = 0.35;
