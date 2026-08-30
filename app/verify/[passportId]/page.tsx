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
import { instanceIssuer } from "@/lib/crypto/instanceKey";
import { createPassportSigil } from "@/lib/passport-art";
import { serviceClient } from "@/lib/supabase";
import {
  lookupPublicPassport,
  type PublicPassportStatus,
  type PublicPassportView,
} from "@/lib/verify/passport";

export const dynamic = "force-dynamic";

function verifierMetadataDescription(): string {
  return "Check whether an AI agent passport was issued by this PassControl instance and whether it is still valid.";
}

function activePassportDetail(): string {
  return "This PassControl instance issued the passport and it has not been suspended or revoked. The holder can present it to mint short-lived work visas.";
}

function suspendedPassportDetail(): string {
  return "This PassControl instance issued the passport, but its operator has paused it. It cannot mint work visas until it is resumed.";
}

function revokedPassportDetail(): string {
  return "This PassControl instance issued the passport and its operator has permanently withdrawn it. It can no longer mint work visas. Treat anything presenting it as untrusted.";
}

function passportIssuerPresentation() {
  return {
    label: instanceIssuer() ?? "Issuer not configured",
    className: "mt-1 mb-0 break-all font-mono text-[0.8rem] font-semibold text-foreground",
  };
}

export const metadata: Metadata = {
  title: "Verify an agent passport",
  description: verifierMetadataDescription(),
  // Shareable is not the same as indexable. A crawlable index of every passport
  // id anyone has ever linked to is not a feature.
  robots: { index: false, follow: false },
};

interface StatusPresentation {
  label: string;
  headline: string;
  detail: string;
  badge: string;
  rail: string;
}

const STATUS: Record<PublicPassportStatus, StatusPresentation> = {
  active: {
    label: "Valid",
    headline: "This passport is valid.",
    detail: activePassportDetail(),
    badge: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600",
    rail: "bg-emerald-500",
  },
  suspended: {
    label: "Suspended",
    headline: "This passport is suspended.",
    detail: suspendedPassportDetail(),
    badge: "border-amber-500/40 bg-amber-500/10 text-amber-600",
    rail: "bg-amber-500",
  },
  revoked: {
    label: "Revoked",
    headline: "This passport has been revoked.",
    detail: revokedPassportDetail(),
    badge: "border-destructive/40 bg-destructive/10 text-destructive",
    rail: "bg-destructive",
  },
  unknown: {
    label: "Unrecognised",
    headline: "This passport is not in a state we can vouch for.",
    detail:
      "The record exists but its lifecycle state is not one this page recognises. Treat it as not valid and contact the operator.",
    badge: "border-border bg-secondary text-muted-foreground",
    rail: "bg-muted-foreground",
  },
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

function formatIssued(issuedAt: string | null): string {
  if (!issuedAt) return "Not recorded";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(issuedAt));
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

function Sigil({ passportId }: { passportId: string }) {
  const sigil = createPassportSigil(passportId);
  return (
    <svg
      className="h-24 w-24 shrink-0 rounded-xl"
      viewBox="0 0 112 112"
      role="img"
      aria-label="Deterministic sigil derived from this passport's public key"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="112" height="112" rx="12" fill={sigil.background} />
      {sigil.cells.map((cell, index) => (
        <rect
          key={`${cell.x}-${cell.y}-${index}`}
          x={10 + cell.x * 13}
          y={10 + cell.y * 13}
          width="11"
          height="11"
          rx={(cell.x + cell.y + index) % 3 === 0 ? 5.5 : 2.5}
          fill={(cell.x + cell.y) % 3 === 0 ? sigil.accent : sigil.foreground}
        />
      ))}
    </svg>
  );
}

/**
 * The owner row, worded off `tier` and never off `kind`.
 *
 * kind records the method that was attempted; tier records what was actually
 * proven. A self-attested owner is a name somebody typed into a form — if this
 * component ever renders that as "verified", the entire ladder is theatre and
 * the page becomes a way to launder an unchecked claim through our domain.
 */
function OwnerValue({ owner }: { owner: PublicPassportView["owner"] }) {
  if (!owner) {
    return (
      <dd className="mt-1 mb-0 text-muted-foreground">
        Not published. The operator has not bound a public owner to this passport.
      </dd>
    );
  }

  if (owner.tier === "unverified") {
    return (
      <dd className="mt-1 mb-0">
        <span className="font-semibold text-foreground">{owner.subject}</span>
        <span className="mt-1 block text-xs leading-5 text-muted-foreground">
          Self-declared by the operator. We have not verified this claim.
        </span>
      </dd>
    );
  }

  return (
    <dd className="mt-1 mb-0">
      <span className="font-semibold text-foreground">{owner.subject}</span>
      <span className="mt-1 block text-xs leading-5 text-muted-foreground">
        {owner.tier === "domain"
          ? "Verified by control of this domain"
          : "Verified by identity check"}
        {owner.verifiedAt ? ` · last confirmed ${formatIssued(owner.verifiedAt)}` : ""}
      </span>
    </dd>
  );
}

function PassportCard({ passport }: { passport: PublicPassportView }) {
  const presentation = STATUS[passport.status];
  const issuer = passportIssuerPresentation();

  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className={`h-1.5 w-full ${presentation.rail}`} aria-hidden="true" />
      <div className="grid gap-6 p-6 sm:p-8">
        <div className="flex flex-wrap items-start gap-5">
          <Sigil passportId={passport.passportId} />
          <div className="min-w-0 flex-1">
            <span
              className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-[0.1em] ${presentation.badge}`}
            >
              {presentation.label}
            </span>
            <h2 className="mt-3 mb-0 text-xl font-bold leading-7 text-foreground">
              {presentation.headline}
            </h2>
            <p className="mt-2 mb-0 text-sm leading-6 text-muted-foreground">
              {presentation.detail}
            </p>
          </div>
        </div>

        <dl className="grid gap-4 border-t border-border pt-6 text-sm sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Passport ID
            </dt>
            <dd className="mt-1 mb-0 break-all font-mono text-[0.8rem] leading-5 text-foreground">
              {passport.passportId}
            </dd>
          </div>
          <div>
            <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Issuer
            </dt>
            <dd className={issuer.className}>{issuer.label}</dd>
          </div>
          <div>
            <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Issued
            </dt>
            <dd className="mt-1 mb-0 font-semibold text-foreground">
              {formatIssued(passport.issuedAt)}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Owner
            </dt>
            <OwnerValue owner={passport.owner} />
          </div>
        </dl>

        <p className="m-0 rounded-lg border border-border bg-secondary px-4 py-3 text-xs leading-5 text-muted-foreground">
          This page reports issuance, revocation, and any owner the operator has chosen to publish.
          It is not a live authorization decision, and it says nothing about the agent&rsquo;s
          spending, permissions, or call history — those stay private to the operator. The sigil is
          derived from the public key, so the same passport always draws the same mark.
        </p>
      </div>
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
