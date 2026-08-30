import type { Metadata } from "next";
import Link from "next/link";
import { SiteLogo, SITE_BRAND_LABEL } from "@/components/SiteBrand";

// The catch-all 404. Until this file existed, every unmatched path rendered the
// stock Next.js error page: ~14.5 KB of framework-fingerprinting HTML, served to
// scanners as readily as to people (hardening/probe-response.md, finding 2).
//
// Two very different visitors land here and the copy has to serve both:
//   - an operator or a stranger who mistyped a real address, and
//   - a scanner walking /wp-admin, /.env, /phpmyadmin.
// So it stays plain and useful. The pointed "why are u trying?" treatment in
// hardening/probe-response.md is deliberately NOT this page — it belongs on a
// hardcoded probe list matched in middleware, because a person typing /dashbord
// must never be told they look like an attacker.
//
// Note on reach: middleware currently redirects anonymous visitors on unmatched
// paths to /login before this renders. It is reached today by authenticated
// users, by misses under the public prefixes (/legal/…, /beta/…, /u/…), and by
// bogus /api/* paths, which the matcher excludes on purpose.
//
// No external assets, no client JS, no version string.
export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-xl content-center gap-8 px-4 py-16 sm:px-6">
      <header className="flex items-center gap-3">
        <SiteLogo size={32} />
        <p className="m-0 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          {SITE_BRAND_LABEL}
        </p>
      </header>

      <section className="grid gap-4">
        <span
          className="inline-flex w-fit rounded-full border border-border bg-secondary px-2.5 py-1 font-mono text-xs font-bold uppercase tracking-[0.1em] text-muted-foreground"
          aria-hidden="true"
        >
          404
        </span>
        <h1 className="m-0 text-2xl font-bold text-foreground sm:text-3xl">
          There is nothing at this address.
        </h1>
        <p className="m-0 text-sm leading-6 text-muted-foreground">
          The page you asked for does not exist. If you followed a link from somewhere in
          PassControl, that link is wrong and we would like to know about it.
        </p>
      </section>

      <nav aria-label="Where to go next" className="flex flex-wrap gap-3">
        <Link
          href="/"
          className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground no-underline transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          PassControl home
        </Link>
        <Link
          href="/dashboard"
          className="inline-flex items-center rounded-lg border border-border bg-secondary px-4 py-2 text-sm font-semibold text-foreground no-underline transition-colors hover:bg-secondary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Control Tower
        </Link>
        <Link
          href="/verify"
          className="inline-flex items-center rounded-lg border border-border bg-transparent px-4 py-2 text-sm font-semibold text-foreground no-underline transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Verify a passport
        </Link>
      </nav>

      <footer className="border-t border-border pt-6 text-sm leading-6 text-muted-foreground">
        <p className="m-0">
          PassControl gives an AI agent a cryptographic passport, so the credentials it uses
          are never the credentials it holds.
        </p>
      </footer>
    </main>
  );
}
