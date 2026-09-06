// Everything the verification page DRAWS, in a module that is not the route.
//
// It lives here for a mechanical reason with a real consequence: Next allows a
// page file to export only its own route exports, so `export function
// PassportCard` from `page.tsx` fails the build with
// `TS2344 … Property 'PassportCard' is incompatible with index signature` —
// against the GENERATED `.next/types` file, which is why `npm test` and a
// curated `tsc` both stayed green while it was broken. The card is exported so
// tests/verify-page-deadlines.test.tsx can assert on what a READER sees rather
// than on what the lookup returned; a green rail beside a true-but-misleading
// sentence is a failure this product has already had once, on the receipt
// inspector. That test is worth a module boundary.
//
// The page keeps what a route owns — metadata, the client IP, the lookup, the
// shell and its two notices. This file keeps the wording, and with it every
// `curate:` marker that names the hosted operator in one tree and the running
// instance in the other. Those markers are why this comment does not name
// either: it is not inside one, so it ships to both.
import { instanceIssuer } from "@/lib/crypto/instanceKey";
import { createPassportSigil } from "@/lib/passport-art";
import type { PublicPassportStatus, PublicPassportView } from "@/lib/verify/passport";

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
  expired: {
    label: "Expired",
    headline: "This passport has expired.",
    detail:
      "Its key was valid and is not any more: the deadline the operator set has passed, so the gateway now refuses it. Nothing here says it was misused — an expiry is the normal end of a key's life, and the operator can issue a replacement.",
    badge: "border-amber-500/40 bg-amber-500/10 text-amber-600",
    rail: "bg-amber-500",
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

function formatIssued(issuedAt: string | null): string {
  if (!issuedAt) return "Not recorded";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(issuedAt));
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
const PROVEN_BY: Record<string, string> = {
  domain: "Verified by control of this domain",
  github: "Verified by control of this GitHub account",
  idv: "Verified by identity check",
};

/**
 * The company line a reader can go and check for themselves.
 *
 * Rendered UNDER the owner and in muted text, worded as an assertion, and
 * carrying the register's own answer rather than ours — because that is exactly
 * what it is. We looked the number up; we did not and cannot show that these
 * passports belong to that company. The value of the line is that the reader can
 * repeat the lookup in the same public register, which is only true if the page
 * says which register and which number.
 *
 * It renders whatever the tier is, including `unverified`. Hiding a checkable
 * fact would be as wrong as promoting an unchecked one, and the sentence above
 * it already says what was and was not proven.
 */
function CompanyLine({ company }: { company: NonNullable<PublicPassportView["owner"]>["company"] }) {
  if (!company) return null;

  return (
    <span className="mt-1 block text-xs leading-5 text-muted-foreground" data-company-state={company.active ? "active" : "inactive"}>
      States it is{" "}
      <span className="font-semibold text-foreground">{company.name ?? "a registered company"}</span>
      {" · "}
      {company.source === "lei" ? "LEI" : "VAT"} {company.id}
      {company.active ? "" : " · not currently active in that register"}
      {company.checkedAt ? ` · looked up ${formatIssued(company.checkedAt)}` : ""}
      {". "}
      <em>Asserted by the operator and confirmed to exist in that register. Not proof that this passport belongs to that company.</em>
    </span>
  );
}

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
        <CompanyLine company={owner.company} />
      </dd>
    );
  }

  return (
    <dd className="mt-1 mb-0">
      <span className="font-semibold text-foreground">{owner.subject}</span>
      <span className="mt-1 block text-xs leading-5 text-muted-foreground">
        {/* Falls back to the weakest true sentence, never to a stronger one. An
            unrecognised tier cannot reach here — normalizeTier resolves drift
            down to `unverified` — but the default keeps that from mattering. */}
        {PROVEN_BY[owner.tier] ?? "Verified"}
        {owner.verifiedAt ? ` · last confirmed ${formatIssued(owner.verifiedAt)}` : ""}
      </span>
      <CompanyLine company={owner.company} />
    </dd>
  );
}

/**
 * The card carries `data-passport-status` and `data-passport-retired` so
 * tests/verify-page-deadlines.test.tsx can assert on what a READER sees rather
 * than on what the SDK returned. That is the reason this module exists at all —
 * see the header.
 */
export function PassportCard({ passport }: { passport: PublicPassportView }) {
  const presentation = STATUS[passport.status];
  const issuer = passportIssuerPresentation();

  return (
    <section
      className="overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      data-passport-status={passport.status}
      data-passport-retired={passport.retired ? "true" : "false"}
    >
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
            {/* Beside the badge, not further down the card. This key can be
                genuinely valid — the gateway still accepts it during the grace
                window — so the badge reads "Valid", and a reader who saw only
                that would think it was the agent's key rather than the one
                being retired. The successor is deliberately not named: it is
                not this key's business, and nobody asked about it. */}
            {passport.retired ? (
              <p className="mt-3 mb-0 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm leading-6 text-amber-700 dark:text-amber-400">
                This key has been <strong>replaced</strong> by rotation. It stops
                authenticating on {formatIssued(passport.retired.notValidAfter)}
                {passport.retired.notValidAfter ? "" : " — a deadline this record does not hold"}.
              </p>
            ) : null}
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
          <div>
            <dt className="m-0 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Expires
            </dt>
            {/* Published rather than only applied. `status` answers "is this
                good now"; a counterparty holding a receipt needs "was it good
                THEN", and only the date lets them work that out. */}
            <dd className="mt-1 mb-0 font-semibold text-foreground">
              {passport.expiresAt ? formatIssued(passport.expiresAt) : "Never expires"}
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
