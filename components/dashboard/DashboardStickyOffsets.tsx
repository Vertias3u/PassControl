"use client";

import { useLayoutEffect, useRef } from "react";

function stickyHeight(element: Element | null): number {
  if (!(element instanceof HTMLElement)) return 0;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.position !== "sticky") return 0;
  return element.getBoundingClientRect().height;
}

/**
 * Keeps independently sticky dashboard rows from occupying the same pixels.
 * Header controls can wrap at browser zoom and translated zone labels vary in
 * width, so the offset must follow rendered geometry rather than a breakpoint.
 */
export function DashboardStickyOffsets() {
  const marker = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const workspace = marker.current?.closest<HTMLElement>(".pc-workspace");
    const app = workspace?.closest<HTMLElement>(".pc-app");
    if (!workspace || !app) return;

    const header = workspace.querySelector(":scope > .pc-page-header");
    const mobileBar = app.querySelector(":scope > .pc-mobile-bar");
    let elevation = workspace.querySelector(":scope > .pc-elevation-bar");

    const update = () => {
      const headerOffset = stickyHeight(mobileBar) + stickyHeight(header);
      const stackOffset = headerOffset + stickyHeight(elevation);
      workspace.style.setProperty("--pc-sticky-header-offset", `${headerOffset}px`);
      workspace.style.setProperty("--pc-sticky-stack-offset", `${stackOffset + 15}px`);
    };

    const resizeObserver = new ResizeObserver(update);
    if (header) resizeObserver.observe(header);
    if (mobileBar) resizeObserver.observe(mobileBar);
    if (elevation) resizeObserver.observe(elevation);

    const mutationObserver = new MutationObserver(() => {
      const nextElevation = workspace.querySelector(":scope > .pc-elevation-bar");
      if (nextElevation !== elevation) {
        if (elevation) resizeObserver.unobserve(elevation);
        elevation = nextElevation;
        if (elevation) resizeObserver.observe(elevation);
      }
      update();
    });
    mutationObserver.observe(workspace, { childList: true });
    window.addEventListener("resize", update);
    update();

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", update);
      workspace.style.removeProperty("--pc-sticky-header-offset");
      workspace.style.removeProperty("--pc-sticky-stack-offset");
    };
  }, []);

  return <span ref={marker} hidden aria-hidden="true" />;
}
