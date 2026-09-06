// PAVP — the public agent verification page.
//
// The only page in the app a stranger can reach with no account, no session and
// no invite code. Someone hands you a passport id; this tells you whether we
// issued it and whether it is still valid. Nothing else.
//
// It deliberately does NOT answer "would a call from this agent succeed right
// now". That depends on tenant kill state, budgets and policy — all of which
// are operational, all of which are private, and one of which lives in Redis
// that an unauthenticated page has no business amplifying traffic into. This
// page reads the passport's own lifecycle and stops there. The copy below says
// so out loud so nobody mistakes a green badge for an authorization decision.
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { SiteLogo, SITE_BRAND_LABEL } from "@/components/SiteBrand";
import { serviceClient } from "@/lib/supabase";
import { lookupPublicPassport } from "@/lib/verify/passport";
import { PassportCard } from "./PassportCard";

export const dynamic = "force-dynamic";

function verifierMetadataDescription(): string {
  return "Check whether an AI agent passport was issued by this PassControl instance and whether it is still valid.";
}

export const metadata: Metadata = {
  title: "Verify an agent passport",
  description: verifierMetadataDescription(),
  // Shareable is not the same as indexable. A crawlable index of every passport
  // id anyone has ever linked to is not a feature.
  robots: { index: false, follow: false },
};

/**
 * The first forwarded hop. Behind Vercel this is the client; behind nothing it
 * is empty and every anonymous caller shares one bucket, which is the safe way
 * for that to fail.
 */
async function clientIp(): Promise<string> {
  const header = await headers();
  const forwarded = header.get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0]?.trim() || header.get("x-real-ip")?.trim() || "unknown";
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-2xl content-start gap-8 px-4 py-12 sm:px-6 sm:py-16">
      <header className="flex items-center gap-3">
        <SiteLogo size={36} />
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            {SITE_BRAND_LABEL}
          </p>
          <h1 className="m-0 text-lg font-bold text-foreground">Agent passport verification</h1>
        </div>
      </header>
      {children}
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

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <section className="rounded-xl border border-border bg-card p-6 shadow-sm">
      <h2 className="m-0 text-lg font-bold text-foreground">{title}</h2>
      <p className="mt-2 mb-0 text-sm leading-6 text-muted-foreground">{body}</p>
    </section>
  );
}

export default async function VerifyPassportPage({
  params,
}: {
  params: Promise<{ passportId: string }>;
}) {
  // Next has already percent-decoded the segment. Decoding it a second time
  // would throw URIError on an input like `100%2525` — a stack trace on the only
  // unauthenticated route in the app, reachable by anyone with a URL bar.
  const { passportId } = await params;
  const result = await lookupPublicPassport(serviceClient(), passportId ?? "", await clientIp());

  if (!result.ok && result.reason === "not_found") notFound();

  return (
    <Shell>
      {result.ok ? (
        <PassportCard passport={result.passport} />
      ) : result.reason === "throttled" ? (
        <Notice
          title="Too many lookups"
          body="This address has checked a lot of passports in the last minute. Wait a moment and try again."
        />
      ) : (
        <Notice
          title="Verification is temporarily unavailable"
          body="We could not reach the passport registry, so we cannot say anything about this passport right now. This is not a statement that it is invalid — try again shortly."
        />
      )}
    </Shell>
  );
}
