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
