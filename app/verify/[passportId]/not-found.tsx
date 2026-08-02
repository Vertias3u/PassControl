import Link from "next/link";
import { VertiasLogo } from "@/components/VertiasLogo";

// An unknown id and a malformed id land here identically. Whether a passport
// exists is exactly what a stranger is entitled to learn, so this page is
// plain — but it says "we did not issue this", not "this is invalid", because
// those are different claims and only the first one is ours to make.
export default function VerifyPassportNotFound() {
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

      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="h-1.5 w-full bg-muted-foreground" aria-hidden="true" />
        <div className="grid gap-3 p-6 sm:p-8">
          <span className="inline-flex w-fit rounded-full border border-border bg-secondary px-2.5 py-1 text-xs font-bold uppercase tracking-[0.1em] text-muted-foreground">
            No record
          </span>
          <h2 className="m-0 text-xl font-bold text-foreground">
            Vertias did not issue this passport.
          </h2>
          <p className="m-0 text-sm leading-6 text-muted-foreground">
            No passport with that identifier exists in our registry. Check the identifier for a
            typo — passport IDs are base64url public keys and are case-sensitive.
          </p>
        </div>
      </section>

      <footer className="grid gap-3 border-t border-border pt-6 text-sm text-muted-foreground">
        <p className="m-0">
          PassControl gives an AI agent a cryptographic passport, so the credentials it uses are
          never the credentials it holds.
        </p>
        <Link
          href="/"
          className="font-semibold text-primary no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          What is PassControl? →
        </Link>
      </footer>
    </main>
  );
}
