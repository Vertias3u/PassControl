import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MOTION_COOKIE, motionAllowedFrom, motionCookieValue } from "@/lib/motion";
import { MotionPreference } from "@/components/dashboard/MotionPreference";
import { coreSource, source } from "./support/curated-source";

// Self-host gets a switch that turns the dashboard's animations off (owner,
// 2026-10-06). One CSS rule set serves both this switch and the operating
// system's "reduce motion" setting; JavaScript motion asks one helper.

describe("the motion switch", () => {
  it("allows motion only when neither the system nor the switch says no", () => {
    expect(motionAllowedFrom(false, null)).toBe(true);
    expect(motionAllowedFrom(false, "on")).toBe(true);
    expect(motionAllowedFrom(false, "off")).toBe(false);
    expect(motionAllowedFrom(true, null)).toBe(false);
  });

  it("stores the choice in a year-long, site-wide cookie", () => {
    expect(MOTION_COOKIE).toBe("pc_motion");
    expect(motionCookieValue(true)).toBe("pc_motion=off; path=/; max-age=31536000; samesite=lax");
    expect(motionCookieValue(false)).toBe("pc_motion=on; path=/; max-age=31536000; samesite=lax");
  });

  it("is read on the dashboard shell, never in the root layout", () => {
    // cookies() in app/layout.tsx would make every prerendered page dynamic.
    const shell = source("components/dashboard/DashboardShell.tsx");
    expect(shell).toContain("await motionTurnedOff()");
    expect(shell).toContain('data-motion={motionOff ? "off" : undefined}');
    expect(source("app/layout.tsx")).not.toContain("motionTurnedOff");
  });

  it("stops CSS motion with the same declarations reduced motion uses", () => {
    const css = source("app/globals.css");
    const block = css.slice(css.indexOf('.pc-app[data-motion="off"] *,'));
    expect(block.length).toBeGreaterThan(0);
    const rule = block.slice(0, block.indexOf("}"));
    // Near-zero, never `none`: transitionend / animationend still fire, so code
    // waiting on them does not hang.
    expect(rule).toContain("animation-duration: 0.01ms !important");
    expect(rule).toContain("transition-duration: 0.01ms !important");
    expect(rule).not.toMatch(/transition:\s*none/);
  });

  it("renders a toggle that says what it does and its state", () => {
    const on = renderToStaticMarkup(<MotionPreference initialOff={false} />);
    expect(on).toContain('aria-pressed="false"');
    expect(on).toContain("Turn animations off");
    const off = renderToStaticMarkup(<MotionPreference initialOff />);
    expect(off).toContain('aria-pressed="true"');
    expect(off).toContain("Turn animations on");
  });

  it("is offered in Core's Settings and not in Cloud's", () => {
    expect(coreSource("app/dashboard/settings/page.tsx")).toContain("<MotionPreference");
  });
});
