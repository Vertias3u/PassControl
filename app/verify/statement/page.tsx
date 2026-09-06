// Public spend-statement verification.
//
// The sibling of /verify/receipt. That page answers "did this specific call
// really happen, and has the record of it been altered?"; this one answers "is
// this issuer's account of a whole day intact, and does it follow the day
// before?".
//
// It asks nothing of us. Verification happens in the visitor's browser against
// keys fetched from whichever issuer the statement names, which is what makes it
// work for a self-hosted deployment we have never heard of.
//
// THIS PAGE SHIPS TO DEPLOYMENTS THAT DO NOT ISSUE STATEMENTS, and that is the
// point rather than an oversight. Operating a statement chain — the nightly job,
// the storage, the inclusion-proof service — is a hosted capability; the FORMAT
// is open, documented in docs/statement-format.md, and checkable by anyone. So
// nothing here may say "your statements" or imply this instance produces them.
// It verifies a statement from whichever issuer signed it, and that is all.
//
// IT ALSO PUBLISHES NOTHING. The visitor supplies the artifact; no workspace's
// statements are reachable from here. A surface that published a tenant's
// statements at an address is a separate, deliberately unbuilt thing, and no
// copy on this page should read as though it exists.
//
// A static segment, so Next resolves it ahead of [passportId]. Safe: a passport
// id is a 43-character base64url public key and can never be "statement".
import type { Metadata } from "next";
import Link from "next/link";
import { SiteLogo, SITE_BRAND_LABEL } from "@/components/SiteBrand";
import { StatementVerifier } from "@/components/StatementVerifier";

// Reads no database, but must stay dynamic so it carries a per-request nonce —
// it ships JavaScript, and adding it to PRERENDERED_PUBLIC_PATHS would opt it
// into 'unsafe-inline' instead. Same reasoning as /verify/receipt.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Verify a spend statement",
  description:
    "Check a signed PassControl spend statement in your browser. Confirms an issuer committed to a fixed set of call receipts for a window and cannot change it now. No account needed.",
  robots: { index: true, follow: true },
};

export default function VerifyStatementPage() {
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-2xl content-start gap-8 px-4 py-12 sm:px-6 sm:py-16">
      <header className="flex items-center gap-3">
        <SiteLogo size={36} />
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            {SITE_BRAND_LABEL}
          </p>
          <h1 className="m-0 text-lg font-bold text-foreground">Statement verification</h1>
        </div>
      </header>

      <p className="m-0 text-sm leading-6 text-muted-foreground">
        A call receipt proves one call happened. A spend statement commits to <em>every</em>{" "}
        receipt in a window at once, and carries the fingerprint of the statement before it — so a
        call cannot be quietly removed from the record afterwards, and neither can a whole day.
      </p>

      <StatementVerifier />

      <footer className="grid gap-3 border-t border-border pt-6 text-sm text-muted-foreground">
        <p className="m-0">
          Checking is done entirely in your browser, using the same open verification code anyone
          can run themselves. The format is documented in full — leaf and node hashing, the
          chain digest, and a test vector — so you can write your own verifier and check it
          against ours rather than taking this page&rsquo;s word for it.
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Link
            href="/verify/receipt"
            className="font-semibold text-primary no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            Verify a single call receipt instead →
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
