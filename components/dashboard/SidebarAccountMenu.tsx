"use client";

// The account card pinned to the bottom of the sidebar, and the menu it opens.
//
// It holds what used to sit in the sidebar footer (Report a problem, Verify
// passport, Sign out). The sidebar is one viewport tall, so every row in that
// footer pushed Sign out further toward the clipped edge; an owner with the
// operator links could not reach it at all on a laptop. Pinned here, it never
// moves, and only the nav above scrolls.
//
// Motion (app/globals.css, `.pc-account-menu`): the panel grows out of the card
// it came from (transform-origin at the bottom), on a strong ease-out, and
// leaves faster than it arrives. Opened from the keyboard it appears at once:
// someone navigating by keys wants the menu, not the show.
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import Link from "next/link";
import { ChevronUp, ExternalLink, LogOut, MessageSquareWarning, UserRound } from "lucide-react";

import { signOut } from "@/app/actions/auth";
import { REPORT_PROBLEM_LINK } from "@/lib/report-problem-link";

export function SidebarAccountMenu({
  avatarSrc,
  initials,
  name,
  handle,
}: {
  avatarSrc: string | null;
  initials: string;
  name: string;
  handle: string;
}) {
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Outside press closes. pointerdown, not click, so the menu is gone before
  // whatever was pressed reacts, and a drag that starts outside still counts.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  // Keyboard-opened: focus the first item once the panel is visible.
  useEffect(() => {
    if (open && instant) items()[0]?.focus();
  }, [open, instant]);

  function toggle(event: MouseEvent<HTMLButtonElement>) {
    // detail === 0: the "click" came from Enter or Space, not a pointer.
    setInstant(event.detail === 0);
    setOpen((value) => !value);
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setInstant(true);
      setOpen(true);
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      list[(index + 1) % list.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      list[(index - 1 + list.length) % list.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      list[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      list[list.length - 1]?.focus();
    } else if (event.key === "Tab") {
      close(false);
    }
  }

  return (
    <div className="pc-sidebar__account" ref={rootRef}>
      <div
        ref={menuRef}
        id={menuId}
        role="menu"
        aria-label="Account"
        className="pc-account-menu"
        data-state={open ? "open" : "closed"}
        data-instant={instant ? "" : undefined}
        onKeyDown={onMenuKeyDown}
      >
        <Link href="/verify" role="menuitem" className="pc-account-menu__item" style={{ "--i": 1 } as never} onClick={() => close(false)}>
          <ExternalLink aria-hidden="true" />
          <span>Verify passport</span>
        </Link>
        {REPORT_PROBLEM_LINK.external ? (
          <a href={REPORT_PROBLEM_LINK.href} target="_blank" rel="noreferrer noopener" role="menuitem" className="pc-account-menu__item" style={{ "--i": 2 } as never} onClick={() => close(false)}>
            <MessageSquareWarning aria-hidden="true" />
            <span>Report a problem</span>
          </a>
        ) : (
          <Link href={REPORT_PROBLEM_LINK.href} role="menuitem" className="pc-account-menu__item" style={{ "--i": 2 } as never} onClick={() => close(false)}>
            <MessageSquareWarning aria-hidden="true" />
            <span>Report a problem</span>
          </Link>
        )}
        <div className="pc-account-menu__separator" role="separator" />
        <form action={signOut}>
          <button type="submit" role="menuitem" className="pc-account-menu__item is-signout" style={{ "--i": 3 } as never}>
            <LogOut aria-hidden="true" />
            <span>Sign out</span>
          </button>
        </form>
        <p className="pc-account-menu__motto">Identity crosses the boundary. Secrets do not.</p>
      </div>

      <button
        ref={triggerRef}
        type="button"
        className="pc-account-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="pc-sidebar__operator-avatar" aria-hidden="true">
          {avatarSrc ? (
            // eslint-disable-next-line @next/next/no-img-element -- served from
            // our own origin by app/avatars/[key], keyed on a capability token.
            <img src={avatarSrc} alt="" width={28} height={28} />
          ) : (
            initials
          )}
        </span>
        <span className="pc-account-trigger__who">
          {name}
          <small>{handle}</small>
        </span>
        <ChevronUp className="pc-account-trigger__chevron" aria-hidden="true" />
      </button>
    </div>
  );
}
