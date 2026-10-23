// Whether the dashboard may animate. Two things can say no, and either one is
// enough: the operating system's "reduce motion" setting, and the self-host
// switch in Settings (owner, 2026-10-06), which stores `pc_motion=off` and puts
// `data-motion="off"` on the dashboard root (components/dashboard/DashboardShell).
//
// CSS motion is stopped by one rule set in app/globals.css. JavaScript motion
// (springs, momentum) must ask `motionAllowed()` before it starts.
// Browser-safe: no server imports here (see lib/motion-preference.ts).

export const MOTION_COOKIE = "pc_motion";

export function motionAllowedFrom(prefersReducedMotion: boolean, motionAttribute: string | null | undefined): boolean {
  return !prefersReducedMotion && motionAttribute !== "off";
}

/** In the browser: may this element's surroundings animate right now? */
export function motionAllowed(element?: Element | null): boolean {
  if (typeof window === "undefined") return false;
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const root = element?.closest("[data-motion]") ?? document.querySelector(".pc-app");
  return motionAllowedFrom(reduced, root?.getAttribute("data-motion"));
}

export function motionCookieValue(off: boolean): string {
  return `${MOTION_COOKIE}=${off ? "off" : "on"}; path=/; max-age=31536000; samesite=lax`;
}

export const NUMBER_ROLL_DURATION_MS = 400;

/** Interpolate a changed number; either motion preference can stop it mid-flight. */
export function animateNumber(
  from: number,
  to: number,
  write: (value: number) => void,
  element?: Element | null
): () => void {
  if (from === to || !Number.isFinite(from) || !Number.isFinite(to) || !motionAllowed(element)) {
    write(to);
    return () => {};
  }
  const started = window.performance.now();
  let frame: number | undefined;
  let cancelled = false;
  const tick = (now: number) => {
    if (cancelled) return;
    if (!motionAllowed(element)) {
      write(to);
      frame = undefined;
      return;
    }
    const progress = Math.max(0, Math.min(1, (now - started) / NUMBER_ROLL_DURATION_MS));
    const eased = 1 - (1 - progress) ** 3;
    write(progress === 1 ? to : from + (to - from) * eased);
    frame = progress < 1 ? window.requestAnimationFrame(tick) : undefined;
  };
  frame = window.requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    if (frame !== undefined) window.cancelAnimationFrame(frame);
  };
}
