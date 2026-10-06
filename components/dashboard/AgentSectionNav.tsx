"use client";

// The agent page's section nav (owner, 2026-10-06; Emil Kowalski / apple-design).
//
// Three fixed segments — Identity, Access, Record — that never move, so a
// target is never pulled out from under the pointer. A pill slides to the
// active segment using Emil's clip-path tabs: a highlighted copy of the row,
// clipped to the active segment, so the colour change is exact at every frame
// and only clip-path animates. Below them, one sub-row holding only the active
// group's links, entering from the side you moved toward (Apple: things leave
// and arrive along the same path).
//
// It also follows the page: scroll into a group's sections and the pill moves
// there by itself (Apple's "where am I?"). Keyboard switching is instant
// (Emil: never animate keyboard actions); reduced motion and the self-host
// Animations switch make all of it instant through the shared CSS rule.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";

export interface AgentNavLink {
  href: `#${string}`;
  label: string;
  ariaLabel?: string;
}

export interface AgentNavGroup {
  id: "identity" | "access" | "record";
  label: string;
  links: AgentNavLink[];
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function AgentSectionNav({ groups }: { groups: AgentNavGroup[] }) {
  const [active, setActive] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [instant, setInstant] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);
  const [clip, setClip] = useState<{ left: number; right: number } | null>(null);
  const segmentsRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeRef = useRef(active);
  activeRef.current = active;

  const select = useCallback((index: number, viaKeyboard: boolean) => {
    if (index === activeRef.current) return;
    setDirection(index > activeRef.current ? 1 : -1);
    setInstant(viaKeyboard);
    setActive(index);
  }, []);

  // Measure the active segment so the highlight can be clipped to it.
  const measure = useCallback(() => {
    const row = segmentsRef.current;
    const tab = tabRefs.current[activeRef.current];
    if (!row || !tab) return;
    const left = tab.offsetLeft;
    setClip({ left, right: row.clientWidth - (left + tab.offsetWidth) });
  }, []);

  useIsomorphicLayoutEffect(() => {
    measure();
  }, [active, measure]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  // Follow the page: the topmost section in view decides the group.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const owner = new Map<string, number>();
    groups.forEach((group, index) => group.links.forEach((link) => owner.set(link.href.slice(1), index)));
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        // The section that started most recently among those in the band is
        // the one being read. Sections nest (Activity sits inside the overview
        // area), so "highest on screen" would pick the outer one. Positions are
        // re-read now; the ones stored at intersection time go stale on scroll.
        let topId: string | null = null;
        let topY = -Infinity;
        for (const id of visible) {
          const y = document.getElementById(id)?.getBoundingClientRect().top ?? -Infinity;
          if (y > topY) { topY = y; topId = id; }
        }
        if (!topId) return;
        setCurrent(topId);
        const group = owner.get(topId);
        if (group !== undefined) select(group, false);
      },
      { rootMargin: "-170px 0px -55% 0px" }
    );
    for (const id of owner.keys()) {
      const section = document.getElementById(id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, [groups, select]);

  const onTabClick = (index: number) => (event: MouseEvent<HTMLButtonElement>) => {
    // detail is 0 when a click came from Enter/Space rather than a pointer.
    select(index, event.detail === 0);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const jump = event.key === "Home" ? 0 : event.key === "End" ? groups.length - 1 : null;
    if (!step && jump === null) return;
    event.preventDefault();
    const next = jump ?? (activeRef.current + step + groups.length) % groups.length;
    select(next, true);
    tabRefs.current[next]?.focus();
  };

  const group = groups[active] ?? groups[0]!;
  const clipStyle = clip
    ? ({ "--pc-nav-clip-l": `${clip.left}px`, "--pc-nav-clip-r": `${clip.right}px` } as CSSProperties)
    : undefined;

  return (
    <nav
      className="pc-agent-subnav"
      aria-label="Agent sections"
      data-instant={instant ? "" : undefined}
    >
      <div className="pc-agent-nav__segments" ref={segmentsRef} style={clipStyle} data-measured={clip ? "" : undefined}>
        <div role="tablist" aria-label="Section groups" className="pc-agent-nav__row" onKeyDown={onTabKeyDown}>
          {groups.map((item, index) => (
            <button
              key={item.id}
              ref={(node) => { tabRefs.current[index] = node; }}
              type="button"
              role="tab"
              id={`pc-agent-nav-tab-${item.id}`}
              aria-selected={index === active}
              aria-controls="pc-agent-nav-links"
              tabIndex={index === active ? 0 : -1}
              className="pc-agent-nav__tab"
              onClick={onTabClick(index)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {/* The highlighted copy, clipped to the active segment. */}
        <div className="pc-agent-nav__row pc-agent-nav__highlight" aria-hidden="true">
          {groups.map((item) => (
            <span key={item.id} className="pc-agent-nav__tab">{item.label}</span>
          ))}
        </div>
      </div>

      <div
        key={group.id}
        id="pc-agent-nav-links"
        role="tabpanel"
        aria-labelledby={`pc-agent-nav-tab-${group.id}`}
        className="pc-agent-nav__links"
        data-direction={direction === 1 ? "forward" : "back"}
      >
        {group.links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            aria-label={link.ariaLabel}
            aria-current={current === link.href.slice(1) ? "location" : undefined}
          >
            {link.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
