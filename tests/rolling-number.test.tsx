import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { animateNumber, NUMBER_ROLL_DURATION_MS } from "@/lib/motion";
import { RollingNumber } from "@/components/dashboard/RollingNumber";

let reduced = false;
let attribute: string | null = null;
let id = 0;
let frames: Map<number, FrameRequestCallback>;
const write = vi.fn();
beforeEach(() => {
  reduced = false;
  attribute = null;
  id = 0;
  frames = new Map();
  write.mockClear();
  vi.stubGlobal("window", {
    performance: { now: () => 0 },
    matchMedia: () => ({ matches: reduced }),
    requestAnimationFrame: (callback: FrameRequestCallback) => (frames.set(++id, callback), id),
    cancelAnimationFrame: (key: number) => frames.delete(key),
  });
  vi.stubGlobal("document", { querySelector: () => ({ getAttribute: () => attribute }) });
});
afterEach(() => vi.unstubAllGlobals());
const frame = (time: number) => {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(time);
};

describe("number changes", () => {
  it.each([[10, 20], [20, 10]])("moves from %i to %i and lands exactly without overshooting", (from, to) => {
    animateNumber(from, to, write);
    expect(frames.size).toBe(1);
    frame(NUMBER_ROLL_DURATION_MS / 2);
    const middle = write.mock.lastCall?.[0] as number;
    expect(middle).toBeGreaterThan(Math.min(from, to));
    expect(middle).toBeLessThan(Math.max(from, to));
    frame(NUMBER_ROLL_DURATION_MS);
    expect(write).toHaveBeenLastCalledWith(to);
    expect(frames.size).toBe(0);
  });

  it.each(["switch", "system"])("jumps straight to the value when motion is disabled by the %s", (reason) => {
    attribute = reason === "switch" ? "off" : null;
    reduced = reason === "system";
    animateNumber(10, 20, write);
    expect(write).toHaveBeenCalledExactlyOnceWith(20);
    expect(frames.size).toBe(0);
  });

  it.each(["switch", "system"])("stops an in-flight count when the %s disables motion", (reason) => {
    animateNumber(10, 20, write);
    frame(50);
    attribute = reason === "switch" ? "off" : null;
    reduced = reason === "system";
    frame(100);
    expect(write).toHaveBeenLastCalledWith(20);
    expect(frames.size).toBe(0);
  });

  it("cancels its outstanding frame on replacement or unmount", () => {
    const cancel = animateNumber(10, 20, write);
    frame(50);
    const calls = write.mock.calls.length;
    cancel();
    frame(NUMBER_ROLL_DURATION_MS);
    expect(frames.size).toBe(0);
    expect(write).toHaveBeenCalledTimes(calls);
  });

  it("does not schedule a frame for an unchanged value", () => {
    animateNumber(12, 12, write);
    expect(write).toHaveBeenCalledExactlyOnceWith(12);
    expect(frames.size).toBe(0);
  });
});

describe("RollingNumber first paint", () => {
  it.each([[12, "integer", "12"], [2.5, "dollars", "$2.50"]] as const)("renders %s honestly before effects run", (value, format, text) => {
    const out = renderToStaticMarkup(<RollingNumber value={value} format={format} />);
    expect(out).toContain(`class="sr-only">${text}</span>`);
    expect(out).toContain(`data-rolling-value="true">${text}</span>`);
    expect(out).toContain('aria-hidden="true"');
  });
});
