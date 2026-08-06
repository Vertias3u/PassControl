// The entry point a stranger lands on: paste a passport id, get an answer.
//
// A plain GET form that redirects to /verify/<id>. No client component and no
// JavaScript at all — which is not minimalism for its own sake, it is what lets
// the page work under the strict CSP with nothing to nonce, and it keeps the
// only unauthenticated surface in the app as small as it can be.
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { VertiasLogo } from "@/components/VertiasLogo";
import { SEEDED_DEMO_PASSPORT_ID } from "@/lib/demo/identity";
import { isPassportIdShape } from "@/lib/verify/passport";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Verify an agent passport",
  description:
    "Check whether an AI agent passport was issued by Vertias and whether it is still valid.",
  robots: { index: true, follow: true },
};

export default async function VerifyIndexPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string | string[] }>;
}) {
  const { id } = await searchParams;
  const submitted = (Array.isArray(id) ? id[0] : id)?.trim() ?? "";

  // Only a well-formed id becomes a redirect. Anything else falls through to the
  // form with an inline complaint, so a typo never costs a database round trip.
  if (submitted && isPassportIdShape(submitted)) {
    redirect(`/verify/${encodeURIComponent(submitted)}`);
  }

  return (
    <main className="mx-auto grid min-h-screen w-full max-w-2xl content-start gap-8 px-4 py-12 sm:px-6 sm:py-16">
      <header className="flex items-center gap-3">
        <VertiasLogo size={36} />
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Vertias · PassControl
          </p>
          <h1 className="m-0 text-lg font-bold text-foreground">Agent passport verification</h1>
        </div>
      </header>

      <section className="rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <h2 className="m-0 text-xl font-bold text-foreground">
          Was this agent&rsquo;s passport issued by Vertias?
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          An AI agent that runs through PassControl carries an Ed25519 passport. Paste its public
          identifier below to see whether we issued it and whether it is still valid. No account
          needed.
        </p>

        <form method="get" action="/verify" className="mt-6 grid gap-3">
          <label
            htmlFor="passport-id"
            className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground"
          >
            Passport ID
          </label>
          <input
            id="passport-id"
            name="id"
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            defaultValue={submitted}
            placeholder="kZCFp7d2x4VDruiulJ21gogYbczBDAGZa-OuwR3qgh8"
            aria-describedby={submitted ? "passport-id-error" : undefined}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          {submitted ? (
            <p
              id="passport-id-error"
              className="m-0 text-sm text-destructive"
              role="alert"
            >
              That is not a passport identifier. Passport IDs are base64url public keys — letters,
              digits, hyphen and underscore only.
            </p>
          ) : null}
          <button
            type="submit"
            className="w-fit rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Verify passport
          </button>
        </form>

        <p className="mt-6 mb-0 text-sm text-muted-foreground">
          No passport to hand? Try the{" "}
          <Link
            href={`/verify/${SEEDED_DEMO_PASSPORT_ID}`}
            className="font-semibold text-primary no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            public demo passport
          </Link>
          .
        </p>
      </section>

      <section className="rounded-xl border border-border bg-secondary/50 p-6 text-sm leading-6 text-muted-foreground sm:p-8">
        <h2 className="m-0 text-base font-bold text-foreground">What this page does and does not say</h2>
        <ul className="mt-3 mb-0 grid list-disc gap-2 pl-5">
          <li>
            <strong className="text-foreground">It says</strong> whether Vertias issued a passport
            with this identifier, when, and whether it is active, suspended, or revoked.
          </li>
          <li>
            <strong className="text-foreground">It does not say</strong> who owns the agent, what it
            is allowed to do, what it has spent, or what it has called. That stays private to the
            operator.
          </li>
          <li>
            <strong className="text-foreground">It is not</strong> a live authorization decision. A
            valid passport still has to pass scope, policy, and budget checks on every single call.
          </li>
        </ul>
      </section>

      <footer className="grid gap-3 border-t border-border pt-6 text-sm text-muted-foreground">
        <p className="m-0">
          Been handed a signed <strong className="text-foreground">receipt</strong> for a
          particular call rather than a passport? That is checked on its own page — in your
          browser, without sending it to us.
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Link
            href="/verify/receipt"
            className="font-semibold text-primary no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Verify a call receipt →
          </Link>
          <Link
            href="/"
            className="font-semibold text-primary no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            What is PassControl? →
          </Link>
        </div>
      </footer>
    </main>
  );
}
