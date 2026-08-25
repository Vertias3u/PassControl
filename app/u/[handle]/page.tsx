// The public operator profile — /@handle.
//
// Reachable with no account, no session and no invite code, like
// /verify/[passportId], and it follows that page's idiom rather than inventing
// a third: local Shell/Notice components built from Tailwind utilities, outside
// the dashboard's `.pc-app` scope so it inherits none of that CSS.
//
// What it answers: who is this operator, what have they proven about
// themselves, and which agents have they chosen to stand behind publicly.
//
// What it deliberately does NOT answer, and the reasons, because each one is a
// thing somebody will eventually want to add:
//
//   * How many calls they make. 0015 names agent_logs as never-public because
//     call volume is business intelligence about the operator. The count here
//     is of agents they explicitly PUBLISHED — assertions they chose to make,
//     not a measure of what they do.
//   * What any agent is allowed to do, or what it spends. Operational, private.
//   * Anything under an agent's internal name. Internal names are
//     customer-identifying; `acme-prod-billing` on a vendor's page is a
//     customer list. The label shown here is a separate opt-in.
//
// The verified-owner wording is keyed off `tier` and never off `kind`, exactly
// as in app/verify/[passportId]/page.tsx. kind is the method attempted; tier is
// what was proven. 0033 does not even return kind, so it cannot be misread.
import { cache } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { VertiasLogo } from "@/components/VertiasLogo";
import { VerifiedProfileBadge } from "@/components/VerifiedProfileBadge";
import { createPassportSigil } from "@/lib/passport-art";
import {
  lookupPublicProfile,
  type PublicProfileAgentView,
  type PublicProfileResult,
  type PublicProfileView,
} from "@/lib/profile/public";
import { serviceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const BASE = "https://passcontrol.vertias.eu";

/**
 * The first forwarded hop. Behind Vercel this is the client; behind nothing it
 * is empty and every anonymous caller shares one bucket, which is the safe way
 * for that to fail. Same helper as the verify page.
 */
async function clientIp(): Promise<string> {
  const header = await headers();
  const forwarded = header.get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0]?.trim() || header.get("x-real-ip")?.trim() || "unknown";
}

/**
 * generateMetadata and the page body both need the profile, and each render
 * must cost ONE rate-limit token and one pair of queries — not two.
 *
 * cache() is applied here rather than inside lib/profile/public.ts on purpose:
 * `cache` is exported by the React that Next bundles for server components, not
 * by the react 18.3.1 that vitest resolves, so importing it into the library
 * would make that module untestable in node.
 */
const loadProfile = cache(
  async (handle: string): Promise<PublicProfileResult> =>
    lookupPublicProfile(serviceClient(), handle, await clientIp())
);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  const result = await loadProfile(handle ?? "");

  // Nothing identifying in the metadata of a profile that is not public — the
  // title of a 404 must not confirm that an operator exists.
  if (!result.ok) {
    return { title: "Operator profile", robots: { index: false, follow: false } };
  }

  const name = result.profile.displayName ?? `@${result.profile.handle}`;
  return {
    title: `${name} · PassControl operator`,
    description:
      result.profile.bio ??
      `${name} publishes verifiable agent passports through PassControl. Every listed agent can be checked independently.`,
    // /u/<handle> and /@<handle> are the same page; /@ is the address people
    // are given, so it is the one search engines are pointed at. robots.ts
    // disallows /u/ for the same reason.
    alternates: { canonical: `${BASE}/@${result.profile.handle}` },
  };
}

function formatDate(value: string | null): string {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(value));
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-2xl content-start gap-8 px-4 py-12 sm:px-6 sm:py-16">
      <header className="flex items-center gap-3">
        <VertiasLogo size={36} />
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            Vertias · PassControl
          </p>
          <h1 className="m-0 text-lg font-bold text-foreground">Operator profile</h1>
        </div>
      </header>
      {children}
      <footer className="grid gap-3 border-t border-border pt-6 text-sm text-muted-foreground">
        <p className="m-0">
          PassControl gives an AI agent a cryptographic passport, so the credentials it uses are
          never the credentials it holds. Everything on this page was published deliberately by
          its operator.
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

/** Initials, so a profile with no avatar is still a face-shaped thing. */
function initials(profile: PublicProfileView): string {
  const source = profile.displayName ?? profile.handle;
  const words = source.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : source.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * The owner line, worded off `tier`.
 *
 * If this ever rendered a self-attested claim as "verified", the whole
 * verification ladder would be theatre and the page would become a way to
 * launder an unchecked claim through our domain. Same three branches, and the
 * same reasoning, as OwnerValue on the verify page.
 */
function Owner({ owner }: { owner: PublicProfileView["owner"] }) {
  if (!owner) return null;

  const verified = owner.tier === "domain" || owner.tier === "idv";
  return (
    <p
      className={`m-0 inline-flex flex-wrap items-baseline gap-x-2 rounded-full border px-3 py-1 text-xs ${
        verified
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
          : "border-border bg-secondary text-muted-foreground"
      }`}
      data-tier={owner.tier}
    >
      <span className="font-bold">{owner.subject}</span>
      <span>
        {owner.tier === "domain"
          ? "Verified by control of this domain"
          : owner.tier === "idv"
            ? "Verified by identity check"
            : "Self-declared · we have not checked this"}
        {verified && owner.verifiedAt ? ` · ${formatDate(owner.verifiedAt)}` : ""}
      </span>
    </p>
  );
}

function Sigil({ passportId }: { passportId: string }) {
  const sigil = createPassportSigil(passportId);
  return (
    <svg
      className="h-12 w-12 shrink-0 rounded-lg"
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

const AGENT_STATUS: Record<PublicProfileAgentView["status"], { label: string; badge: string }> = {
  active: { label: "Active", badge: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600" },
  suspended: { label: "Suspended", badge: "border-amber-500/40 bg-amber-500/10 text-amber-600" },
  revoked: { label: "Revoked", badge: "border-destructive/40 bg-destructive/10 text-destructive" },
  unknown: { label: "Unrecognised", badge: "border-border bg-secondary text-muted-foreground" },
};

/**
 * One published agent.
 *
 * The whole value of this list is that every row is independently checkable, so
 * each links to /verify/<passport>. A claim on this page that a stranger has to
 * take our word for would be worth nothing.
 */
function AgentRow({ agent }: { agent: PublicProfileAgentView }) {
  const status = AGENT_STATUS[agent.status];
  return (
    <li className="m-0">
      <Link
        href={`/verify/${encodeURIComponent(agent.passportId)}`}
        className="flex items-center gap-4 rounded-xl border border-border bg-card p-4 no-underline transition-colors hover:border-primary/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Sigil passportId={agent.passportId} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold text-foreground">{agent.label}</span>
          <span className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
            {agent.displayId}
          </span>
        </span>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-bold uppercase tracking-[0.1em] ${status.badge}`}
        >
          {status.label}
        </span>
      </Link>
    </li>
  );
}

function ProfileCard({
  profile,
  agents,
}: {
  profile: PublicProfileView;
  agents: PublicProfileAgentView[];
}) {
  return (
    <>
      <section className="rounded-xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <div className="flex flex-wrap items-start gap-5">
          <span
            className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-secondary text-xl font-bold text-muted-foreground"
            aria-hidden="true"
          >
            {profile.avatarKey ? (
              // eslint-disable-next-line @next/next/no-img-element -- served by
              // app/avatars/[key] from our own origin, so `img-src 'self'` in
              // lib/csp.ts is never widened. Bytes are already bounded and
              // re-encoded, so the image optimizer has nothing to add.
              <img
                src={`/avatars/${profile.avatarKey}`}
                alt=""
                width={80}
                height={80}
                className="h-full w-full object-cover"
              />
            ) : (
              initials(profile)
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="m-0 flex items-center gap-1.5 text-xl font-bold leading-7 text-foreground">
              <span>{profile.displayName ?? `@${profile.handle}`}</span>
              <VerifiedProfileBadge verified={profile.verified} />
            </h2>
            <p className="mt-1 mb-0 font-mono text-sm text-muted-foreground">@{profile.handle}</p>
            {profile.company && (
              <p className="mt-2 mb-0 text-sm text-muted-foreground">{profile.company}</p>
            )}
          </div>
        </div>

        {profile.bio && (
          <p className="mt-5 mb-0 text-sm leading-6 text-foreground">{profile.bio}</p>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Owner owner={profile.owner} />
          {profile.websiteUrl && (
            <a
              href={profile.websiteUrl}
              // An operator-controlled outbound link on a page we host. nofollow
              // so a public profile cannot be used to pass ranking to anywhere;
              // ugc because that is what it is; noopener/noreferrer so the
              // destination learns nothing and gets no window handle.
              rel="nofollow ugc noopener noreferrer"
              className="text-sm font-semibold text-primary no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {profile.websiteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗
            </a>
          )}
        </div>

        <p className="mt-5 mb-0 border-t border-border pt-4 text-xs text-muted-foreground">
          Operating through PassControl since {formatDate(profile.memberSince)}.
        </p>
      </section>

      <section className="grid gap-4">
        <div>
          <h2 className="m-0 text-lg font-bold text-foreground">
            Published agents{agents.length ? ` (${agents.length})` : ""}
          </h2>
          <p className="mt-1 mb-0 text-sm leading-6 text-muted-foreground">
            Agents this operator chose to list publicly. Each one is a passport you can check
            yourself — this page is not asking you to take our word for any of it.
          </p>
        </div>

        {agents.length === 0 ? (
          <p className="m-0 rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
            This operator has not published any agents. Publishing a profile does not publish an
            agent — each one is a separate decision.
          </p>
        ) : (
          <ul className="m-0 grid list-none gap-3 p-0">
            {agents.map((agent) => (
              <AgentRow key={agent.passportId} agent={agent} />
            ))}
          </ul>
        )}
      </section>

      <p className="m-0 rounded-lg border border-border bg-secondary px-4 py-3 text-xs leading-5 text-muted-foreground">
        This page reports what an operator has published about themselves and which passports they
        stand behind. It says nothing about what those agents are permitted to do, what they spend,
        or how often they run — all of which stay private to the operator.
      </p>
    </>
  );
}

export default async function OperatorProfilePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  // Next has already percent-decoded the segment. Decoding it a second time
  // would throw URIError on an input like `100%2525` — a stack trace on a route
  // anyone with a URL bar can reach.
  const { handle } = await params;
  const result = await loadProfile(handle ?? "");

  // A profile that has not opted in is indistinguishable from one that does not
  // exist. That is the point: a 404 must not confirm that an operator is here.
  if (!result.ok && result.reason === "not_found") notFound();

  return (
    <Shell>
      {result.ok ? (
        <ProfileCard profile={result.profile} agents={result.agents} />
      ) : result.reason === "throttled" ? (
        <Notice
          title="Too many lookups"
          body="This address has looked up a lot of profiles in the last minute. Wait a moment and try again."
        />
      ) : (
        <Notice
          title="This profile is temporarily unavailable"
          body="We could not reach the operator registry, so we cannot show this profile right now. This is not a statement that it does not exist — try again shortly."
        />
      )}
    </Shell>
  );
}
