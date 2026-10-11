// Land an in-page jump that arrived by client navigation (sprint T4).
//
// The dashboard and agent routes have a loading.tsx, so a Link to
// `/dashboard/agents/<id>#agent-policy-lab` first renders the loading skeleton.
// Next looks for the hash target there, finds nothing, and leaves the page at the
// top; the real sections stream in afterwards and nothing scrolls again. A full
// page load is unaffected (the browser scrolls once the element exists).
//
// This runs when the real page mounts. It scrolls the target into view at once
// (its CSS scroll-margin applies), then keeps it there while content above it
// changes the layout, and lets go at the person's first scroll, key or touch, or
// after HOLD_MS. Instant rather than smooth: a smooth animation started before a
// layout shift heads for a position that no longer holds the target.

const HOLD_MS = 2500;
const LET_GO_ON = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

interface Target {
  scrollIntoView(options: { block: "start"; behavior: "instant" }): void;
}

export interface HashLandingWindow {
  location: { hash: string };
  document: { getElementById(id: string): Target | null; body: unknown };
  addEventListener(type: string, listener: () => void, options?: { passive?: boolean }): void;
  removeEventListener(type: string, listener: () => void): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  ResizeObserver?: new (callback: () => void) => { observe(target: unknown): void; disconnect(): void };
}

/** Starts holding the hash target in view; returns the function that stops it. */
export function holdHashTarget(win: HashLandingWindow): () => void {
  let id: string;
  try {
    id = decodeURIComponent(win.location.hash.replace(/^#/, ""));
  } catch {
    return () => {};
  }
  const target = id ? win.document.getElementById(id) : null;
  if (!target) return () => {};

  const align = () => target.scrollIntoView({ block: "start", behavior: "instant" });
  align();

  let stopped = false;
  const observer = win.ResizeObserver ? new win.ResizeObserver(() => !stopped && align()) : null;
  observer?.observe(win.document.body);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    observer?.disconnect();
    for (const type of LET_GO_ON) win.removeEventListener(type, stop);
    win.clearTimeout(timer);
  };
  for (const type of LET_GO_ON) win.addEventListener(type, stop, { passive: true });
  const timer = win.setTimeout(stop, HOLD_MS);
  return stop;
}
