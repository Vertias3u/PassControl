// Public receipt verification.
//
// The sibling of /verify/[passportId]. That page answers "does this agent's
// passport exist and is it valid?"; this one answers "did this specific call
// really happen, and has the record of it been altered?".
//
// The difference in how they work is the interesting part. The passport page
// asks OUR database, so it can only speak for passports we issued. This page
// asks nothing of us at all: verification happens in the visitor's browser
// against keys fetched from whichever issuer the receipt names. That is what
// makes it work for a self-hosted deployment we have never heard of, and it is
// why the page can honestly say the receipt is never sent to Vertias.
//
// A static segment, so Next resolves it ahead of [passportId]. Safe: a passport
// id is a 43-character base64url public key and can never be "receipt".
import type { Metadata } from "next";
import Link from "next/link";
import { VertiasLogo } from "@/components/VertiasLogo";
import { ReceiptVerifier } from "@/components/ReceiptVerifier";

// Reads no database, but must stay dynamic so it carries a per-request nonce —
// it is the one public page in the app that ships JavaScript, and adding it to
// PRERENDERED_PUBLIC_PATHS would opt it into 'unsafe-inline' instead.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Verify a call receipt",
  description:
    "Check a signed PassControl call receipt in your browser. Confirms the call, the verdict and the cost have not been altered since they were signed. No account needed.",
  // Unlike /verify/<id>, nothing private can appear in this URL — it is a paste
  // box, not a per-record page — so it is a legitimate landing page to index.
  robots: { index: true, follow: true },
};

export default function VerifyReceiptPage() {
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-2xl content-start gap-8 px-4 py-12 sm:px-6 sm:py-16">
      <header className="flex items-center gap-3">
        <VertiasLogo size={36} />
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Vertias · PassControl
          </p>
          <h1 className="m-0 text-lg font-bold text-foreground">Receipt verification</h1>
        </div>
      </header>

      <ReceiptVerifier />

      <section className="rounded-xl border border-border bg-secondary/50 p-6 text-sm leading-6 text-muted-foreground sm:p-8">
        <h2 className="m-0 text-base font-bold text-foreground">
          What this page does and does not say
        </h2>
        <ul className="mt-3 mb-0 grid list-disc gap-2 pl-5">
          <li>
            <strong className="text-foreground">It says</strong> that a receipt was signed by
            the issuer it names, using a key that issuer publishes, and that nothing in it has
            changed since — the agent, the call, the verdict, the cost and the time.
          </li>
          <li>
            <strong className="text-foreground">It does not say</strong> that the issuer is
            trustworthy. Anyone can run PassControl and issue receipts about their own agents.
            The signature proves the record is intact; it does not vouch for whoever made it.
          </li>
          <li>
            <strong className="text-foreground">It does not say</strong> what the provider
            replied. A receipt binds the request and the gateway&rsquo;s decision, not the
            response.
          </li>
          <li>
            <strong className="text-foreground">Absence proves nothing.</strong> A call with no
            receipt is not evidence a call did not happen. Receipts are a record, not a ledger
            that is guaranteed complete.
          </li>
        </ul>
      </section>

      <footer className="grid gap-3 border-t border-border pt-6 text-sm text-muted-foreground">
        <p className="m-0">
          Checking is done entirely in your browser, using the same open verification code
          anyone can run themselves. Vertias never receives the receipt.
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Link
            href="/verify"
            className="font-semibold text-primary no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Verify an agent passport instead →
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
