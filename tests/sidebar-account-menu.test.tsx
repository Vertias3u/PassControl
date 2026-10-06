// The sidebar's account menu (owner design, 2026-10-04). The sidebar is exactly
// one viewport tall and did not scroll, so on a laptop the footer was clipped:
// an owner with the three operator links could not reach Sign out at all.
// Now the nav scrolls, the account card is pinned at the bottom and opens a
// menu holding Profile, Verify passport, Report a problem and Sign out.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/app/actions/auth", () => ({ signOut: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...(rest as object)}>{children as never}</a>
  ),
}));

const { SidebarAccountMenu } = await import("@/components/dashboard/SidebarAccountMenu");

const read = (path: string) => readFileSync(path, "utf8");

describe("SidebarAccountMenu", () => {
  const html = renderToStaticMarkup(
    <SidebarAccountMenu avatarSrc={null} initials="KI" name="Kristiyan" handle="@kristiyan" />
  );

  it("is a real menu button, closed until asked", () => {
    expect(html).toMatch(/<button[^>]*aria-haspopup="menu"/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/role="menu"[^>]*data-state="closed"|data-state="closed"[^>]*role="menu"/);
  });

  it("holds what used to crowd the footer, Sign out included", () => {
    expect(html).toContain('href="/verify"');
    expect(html).toContain('href="https://github.com/Vertias3u/PassControl/issues/new/choose"');
    expect(html).toMatch(/<form[^>]*>[\s\S]*role="menuitem"[\s\S]*Sign out/);
    // Core has no Profile item (localhost only): Verify, Report, Sign out.
    expect(html.match(/role="menuitem"/g)).toHaveLength(3);
    expect(html).toContain("Identity crosses the boundary. Secrets do not.");
  });

  it("shows who is signed in on the trigger", () => {
    expect(html).toContain("Kristiyan");
    expect(html).toContain("@kristiyan");
    expect(html).toContain(">KI<");
  });
});

describe("the sidebar can no longer clip Sign out", () => {
  const shell = read("components/dashboard/DashboardShell.tsx");
  const css = read("app/globals.css");

  it("pins the account menu below a nav that scrolls", () => {
    expect(shell).toContain("<SidebarAccountMenu");
    const nav = css.slice(css.indexOf(".pc-sidebar__nav {"));
    const rule = nav.slice(0, nav.indexOf("}"));
    expect(rule).toMatch(/overflow-y:\s*auto/);
    expect(rule).toMatch(/min-height:\s*0/);
  });

  it("groups the operator links under their own label", () => {
    expect(shell).toContain('className="pc-nav-group__label"');
  });

  it("moves with the house curve, fast exit, and honours reduced motion", () => {
    expect(css).toContain("--pc-ease-out: cubic-bezier(0.23, 1, 0.32, 1)");
    const menu = css.slice(css.indexOf(".pc-account-menu {"));
    expect(menu.slice(0, menu.indexOf("}"))).toMatch(/transform-origin:\s*bottom/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.pc-account-menu/);
  });
});
