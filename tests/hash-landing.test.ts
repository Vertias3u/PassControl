// In-page jumps that arrive by client navigation (sprint T4, owner 2026-10-09:
// `/dashboard/agents/<id>#agent-policy-lab` landed on "Expiry and rotation").
//
// The dashboard and agent routes have a loading.tsx. On a Link click Next renders
// the loading skeleton, looks for the hash target there, does not find it, and
// leaves the page at the top; the real sections stream in afterwards and nothing
// scrolls again. Measured headless on 2026-10-09: every #agent-* anchor reached by
// client navigation stayed at the top, at 1280 and 390 px, while a full page load
// of the same URL landed correctly.
//
// `holdHashTarget` runs when the real page mounts: it scrolls the target into view
// (its scroll-margin applies), keeps it there while late content above it changes
// the layout, and lets go as soon as the person scrolls or after a short window.
import { describe, expect, it } from "vitest";
import { holdHashTarget } from "@/lib/hash-landing";

function env(hash: string, ids: string[] = ["agent-policy-lab"]) {
  const calls: string[] = [];
  const listeners = new Map<string, () => void>();
  let observerCallback: (() => void) | null = null;
  let disconnected = false;
  const timers: (() => void)[] = [];
  const elements = new Map(ids.map((id) => [id, { scrollIntoView: (o: unknown) => calls.push(`${id}:${JSON.stringify(o)}`) }]));
  const win = {
    location: { hash },
    document: { getElementById: (id: string) => elements.get(id) ?? null, body: {} },
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    setTimeout: (fn: () => void) => (timers.push(fn), timers.length),
    clearTimeout: () => {},
    ResizeObserver: class {
      constructor(cb: () => void) {
        observerCallback = cb;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
  };
  return {
    win,
    calls,
    listeners,
    shift: () => observerCallback?.(),
    expire: () => timers.forEach((t) => t()),
    disconnected: () => disconnected,
  };
}

describe("holdHashTarget", () => {
  it("scrolls the hash target into view at once, without a smooth animation", () => {
    const e = env("#agent-policy-lab");
    holdHashTarget(e.win as never);
    expect(e.calls).toEqual(['agent-policy-lab:{"block":"start","behavior":"instant"}']);
  });

  it("keeps it there while content above it changes the layout", () => {
    const e = env("#agent-policy-lab");
    holdHashTarget(e.win as never);
    e.shift();
    e.shift();
    expect(e.calls).toHaveLength(3);
  });

  it.each(["wheel", "touchstart", "keydown", "pointerdown"])("lets go when the person acts (%s)", (event) => {
    const e = env("#agent-policy-lab");
    holdHashTarget(e.win as never);
    e.listeners.get(event)!();
    e.shift();
    expect(e.calls).toHaveLength(1);
    expect(e.disconnected()).toBe(true);
    expect(e.listeners.size).toBe(0);
  });

  it("lets go after its window", () => {
    const e = env("#agent-policy-lab");
    holdHashTarget(e.win as never);
    e.expire();
    e.shift();
    expect(e.calls).toHaveLength(1);
    expect(e.disconnected()).toBe(true);
  });

  it("is undone by its cleanup", () => {
    const e = env("#agent-policy-lab");
    const stop = holdHashTarget(e.win as never);
    stop();
    e.shift();
    expect(e.calls).toHaveLength(1);
  });

  it.each([
    ["no hash", ""],
    ["a bare #", "#"],
    ["a hash with no element", "#nowhere"],
    ["a malformed escape", "#%E0%A4%A"],
  ])("does nothing for %s", (_label, hash) => {
    const e = env(hash);
    holdHashTarget(e.win as never)();
    expect(e.calls).toEqual([]);
    expect(e.listeners.size).toBe(0);
  });

  it("decodes an escaped id", () => {
    const e = env("#agent%2Dpolicy-lab");
    holdHashTarget(e.win as never);
    expect(e.calls).toHaveLength(1);
  });

  it("still lands once where there is no ResizeObserver", () => {
    const e = env("#agent-policy-lab");
    const win = { ...e.win, ResizeObserver: undefined };
    holdHashTarget(win as never)();
    expect(e.calls).toHaveLength(1);
  });
});
