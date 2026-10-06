import type { ReactNode } from "react";
import Link from "next/link";
import { motionTurnedOff } from "@/lib/motion-preference";
import {
  Activity,
  BarChart3,
  Bot,
  Gauge,
  LogOut,
  MessageSquareWarning,
  Network,
  Plug,
  Settings,
  Stethoscope,
  UserCheck,
} from "lucide-react";
import { signOut } from "@/app/actions/auth";
import { DashboardBrand } from "@/components/dashboard/DashboardBrand";
import { SidebarAccountMenu } from "@/components/dashboard/SidebarAccountMenu";
import { cn } from "@/lib/utils";
import { DashboardCommandPalette } from "@/components/dashboard/DashboardCommandPalette";
import { userClient } from "@/lib/supabase/server";
import { DashboardTimeProvider, TimeZoneToggle } from "@/components/dashboard/DashboardTime";
import { LocalModelsProvider } from "@/components/dashboard/LocalModels";
import { endpointPolicy } from "@/lib/providers/endpoint";
import { GlobalElevationBar, type ActiveElevation } from "@/components/dashboard/GlobalElevationBar";
import { DashboardStickyOffsets } from "@/components/dashboard/DashboardStickyOffsets";
import { readProfile } from "@/lib/profile/manage";
import { serviceClient } from "@/lib/supabase";
import { getCachedMigrationHealth } from "@/lib/system-health/cache";
import { systemOperatorEmails } from "@/lib/system-health/operator";
// `lib/operator-allowlist.ts` SHIPS — it was extracted so Core pages need not
// import hosted beta code, and `showOperatorNav` below is computed in every build.
import { operatorEmails } from "@/lib/operator-allowlist";
import { MigrationBanner } from "@/components/dashboard/MigrationBanner";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { REPORT_PROBLEM_LINK } from "@/lib/report-problem-link";
import type { SystemHealthSnapshot } from "@/lib/system-health";

export type DashboardArea = "overview" | "graph" | "fleet" | "activity" | "spend" | "statements" | "services" | "approvals" | "settings" | "beta" | "operator" | "system" | "report";

const NAV: Array<{
  id: DashboardArea;
  label: string;
  href: string;
  Icon: typeof Gauge;
}> = [
  { id: "overview", label: "Overview", href: "/dashboard#overview", Icon: Gauge },
  { id: "graph", label: "Control graph", href: "/dashboard/graph", Icon: Network },
  { id: "fleet", label: "Fleet", href: "/dashboard#fleet", Icon: Bot },
  { id: "activity", label: "Activity", href: "/dashboard#activity", Icon: Activity },
  { id: "spend", label: "Spend", href: "/dashboard#spend", Icon: BarChart3 },
  // Any-API: the non-LLM services agents reach, and the stop for each.
  { id: "services", label: "Services", href: "/dashboard/services", Icon: Plug },
  // "Ask me first": the service calls waiting for the owner's yes or no.
  { id: "approvals", label: "Approvals", href: "/dashboard/approvals", Icon: UserCheck },
  { id: "settings", label: "Settings", href: "/dashboard/settings", Icon: Settings },
];

function Navigation({ active, mobile = false, showBetaOperator = false, showSystemHealth = false }: { active: DashboardArea; mobile?: boolean; showBetaOperator?: boolean; showSystemHealth?: boolean }) {
  // Operator-only links sit in their own labelled group, so an operator's
  // sidebar reads as a tenant's sidebar plus one clearly separate section.
  const operatorEntries = [
    ...(showSystemHealth ? [{ id: "system" as const, label: "System health", href: "/dashboard/system", Icon: Stethoscope }] : []),
  ];
  const link = ({ id, label, href, Icon }: (typeof NAV)[number] | (typeof operatorEntries)[number]) => (
    <Link
      key={id}
      href={href}
      aria-current={active === id ? "page" : undefined}
      className={cn("pc-nav-link", active === id && "is-active")}
    >
      <Icon aria-hidden="true" />
      <span>{label}</span>
    </Link>
  );
  return (
    <nav aria-label="Control Tower" className={mobile ? "pc-mobile-nav__links" : "pc-sidebar__nav"}>
      {NAV.map(link)}
      {operatorEntries.length ? (
        <>
          <p className="pc-nav-group__label">Operator</p>
          {operatorEntries.map(link)}
        </>
      ) : null}
    </nav>
  );
}

/**
 * Two letters for an operator with no avatar. Falls back to the handle, then to
 * nothing at all — an empty circle is better than a wrong initial.
 */
function operatorInitials(displayName: string | null, handle: string | null): string {
  const source = (displayName ?? handle ?? "").trim();
  if (!source) return "";
  const words = source.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : source.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * What the sidebar account card shows. Cloud reads the operator's profile:
 * display name, @handle and avatar. Core has no profile UI (localhost only,
 * owner 2026-10-05), so it shows the signed-in email, the one name a local
 * install always has.
 */
function accountCard(
  profileRecord: { display_name?: string | null; username?: string | null; avatar_key?: string | null; avatar_path?: string | null } | null,
  email: string | null,
): { avatarSrc: string | null; initials: string; name: string; handle: string } {
  void profileRecord;
  return {
    avatarSrc: null,
    initials: operatorInitials(null, email),
    name: email ?? "Your account",
    handle: "This computer",
  };
}

export async function DashboardShell({
  userId,
  active,
  title,
  eyebrow = "Control Tower",
  description,
  actions,
  children,
  contentClassName,
  showBetaOperator = false,
  migrationHealth,
}: {
  userId: string;
  active: DashboardArea;
  title: string;
  eyebrow?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
  showBetaOperator?: boolean;
  /** Reuse the detailed page's snapshot so its banner cannot disagree. */
  migrationHealth?: SystemHealthSnapshot["migrations"];
}) {
  const db = await userClient();
  const now = new Date().toISOString();
  const [{ data: commandAgents, error: agentError }, { data: grants, error: grantError }, profile, mfa] =
    await Promise.all([
      db
        .from("agents")
        .select("id, name, passport_pubkey")
        .eq("user_id", userId)
        .order("name", { ascending: true }),
      db
        .from("break_glass_grants")
        .select("id, agent_id, expires_at")
        .eq("user_id", userId)
        .is("revoked_at", null)
        .gt("expires_at", now)
        .order("expires_at", { ascending: true }),
      // Joins the existing Promise.all rather than adding a serial round trip.
      // Tolerates a missing row on purpose: nothing creates one at signup, so a
      // freshly signed-up operator legitimately has none and the chip falls
      // back to the deployment label it has always shown.
      readProfile(serviceClient(), userId),
      // This navigation and banner are themselves privileged diagnostics. Use
      // the same strict, signed-AAL gate as the destination page, not merely a
      // verified factor on an aal1 session.
      mfaAuthorizedUser(db),
    ]);
  const profileRecord = profile.ok ? profile.data : null;
  const agentNames = new Map((commandAgents ?? []).map((agent) => [agent.id, agent.name]));
  const elevations: ActiveElevation[] = (grants ?? []).map((grant) => ({
    id: grant.id,
    agentId: grant.agent_id,
    agentName: agentNames.get(grant.agent_id) ?? `Agent …${String(grant.agent_id).slice(-8)}`,
    expiresAt: grant.expires_at,
  }));
  const hasVerifiedTotp = (mfa.ok ? mfa.user.factors ?? [] : []).some(
    (factor) => factor.factor_type === "totp" && factor.status === "verified"
  );
  const showSystemHealth = mfa.ok
    && systemOperatorEmails().has(mfa.user.email?.trim().toLowerCase() ?? "")
    && hasVerifiedTotp;
  /**
   * The operator nav, decided HERE rather than trusted from the caller.
   *
   * The link used to appear on the strength of the email allowlist alone, while
   * every destination behind it requires the full gate: signed AAL2, a verified
   * TOTP factor, and the allowlist. So an allowlisted account without TOTP saw
   * the link, clicked it, bounced through /login/verify and landed back on
   * /dashboard. This makes the link agree with its destination — the same
   * derivation `showSystemHealth` above already uses, off the same `mfa` result,
   * with no second Auth request.
   *
   * The caller's `showBetaOperator` is kept and ANDed rather than removed, so it
   * can only ever NARROW: a page that wants to hide the link still can, and a
   * page that passes `true` cannot conjure one for an account that fails the
   * gate. Widening was the bug; it is now unreachable by any caller.
   *
   * This is a usability fix, NOT an authorization fix (`admin_panel.md §8`).
   * Every destination re-gates independently and always did — hiding a link has
   * never been the control, and must never become one.
   *
   * Deliberately OUTSIDE the hosted-only markers, even though only hosted nav
   * items read it: the two `<Navigation>` call sites below are shared lines, so
   * a curated build that stripped this would reference an identifier it had just
   * deleted and fail a self-hoster's build. Only the nav ITEM and its icons are
   * hosted-only. Caught by building the curated tree, not by reading it.
   */
  const betaOperatorAuthorized = mfa.ok
    && operatorEmails().has(mfa.user.email?.trim().toLowerCase() ?? "")
    && hasVerifiedTotp;
  const showOperatorNav = showBetaOperator && betaOperatorAuthorized;

  // Serial, and only for an operator. It cannot join the Promise.all above
  // because it depends on `auth` resolving first — which is the point: a tenant
  // never pays for this read, and never sees how far behind the instance is.
  // getCachedMigrationHealth is the cheap collector (one bounded query, no Redis ping,
  // no vault probe) precisely so it can sit on every dashboard load.
  const migrations = showSystemHealth
    ? migrationHealth !== undefined ? migrationHealth : await getCachedMigrationHealth()
    : null;

  // Per-request state belongs on this shell and never in app/layout.tsx: calling
  // cookies() or headers() in the root layout opts EVERY route out of static
  // rendering, including the pages this deployment prerenders for people who are
  // not logged in. Every dashboard route is already dynamic because it requires a
  // session, so reading per-request state here costs nothing.
  // The animations switch (lib/motion.ts) is read here for the same reason.
  const motionOff = await motionTurnedOff();

  return (
    <DashboardTimeProvider>
    {/* Whether choosers may offer the `local` provider: only where the operator
        gate is open, so hosted Cloud never lists a provider it refuses. */}
    <LocalModelsProvider enabled={endpointPolicy().kind !== "off"}>
    <div
      className="pc-app min-h-screen bg-background text-foreground"
      data-motion={motionOff ? "off" : undefined}
    >
      <a href="#pc-main" className="pc-skip-link">
        Skip to content
      </a>

      <header className="pc-mobile-bar">
        <Link href="/dashboard" className="pc-brand" aria-label="PassControl overview">
          <DashboardBrand markSize={21} wordmarkSize={15} layout="inline" />
        </Link>
        <details className="pc-mobile-nav">
          <summary aria-label="Open navigation">Menu</summary>
          <div className="pc-mobile-nav__panel">
            <Navigation active={active} mobile showBetaOperator={showOperatorNav} showSystemHealth={showSystemHealth} />
            {REPORT_PROBLEM_LINK.external ? (
              <a href={REPORT_PROBLEM_LINK.href} target="_blank" rel="noreferrer noopener" className="pc-nav-link">
                <MessageSquareWarning aria-hidden="true" />
                <span>Report a problem</span>
              </a>
            ) : (
              <Link href={REPORT_PROBLEM_LINK.href} className="pc-nav-link">
                <MessageSquareWarning aria-hidden="true" />
                <span>Report a problem</span>
              </Link>
            )}
            <form action={signOut}>
              <button type="submit" className="pc-nav-link w-full">
                <LogOut aria-hidden="true" />
                <span>Sign out</span>
              </button>
            </form>
          </div>
        </details>
      </header>

      <div className="pc-shell-grid">
        <aside className="pc-sidebar">
          <Link href="/dashboard" className="pc-sidebar__brand" aria-label="PassControl overview">
            <DashboardBrand markSize={27} wordmarkSize={17} />
          </Link>

          <Navigation active={active} showBetaOperator={showOperatorNav} showSystemHealth={showSystemHealth} />

          {/* Pinned below a nav that scrolls, so Sign out can never be pushed
              off a short screen again (it was, for an owner with the operator
              links). Report a problem stays one click from every page here and
              in the command palette. */}
          <SidebarAccountMenu {...accountCard(profileRecord, mfa.ok ? mfa.user.email ?? null : null)} />
        </aside>

        <div className="pc-workspace">
          <DashboardStickyOffsets />
          <header className="pc-page-header">
            <div className="min-w-0">
              <p className="pc-kicker">{eyebrow}</p>
              <h1>{title}</h1>
              {description ? <div className="pc-page-header__description">{description}</div> : null}
            </div>
            <div className="pc-page-actions">
              <TimeZoneToggle />
              <DashboardCommandPalette agents={commandAgents ?? []} showSystemHealth={showSystemHealth} />
              {actions}
            </div>
          </header>

          <GlobalElevationBar
            elevations={elevations}
            unavailable={Boolean(agentError || grantError)}
            initialNow={Date.parse(now)}
          />

          <main id="pc-main" className={cn("pc-content", contentClassName)}>
            {/* Above the page's own content on purpose: a schema mismatch
                changes how everything below it should be read. */}
            {migrations ? <MigrationBanner migrations={migrations} /> : null}
            {children}
          </main>
        </div>
      </div>
    </div>
    </LocalModelsProvider>
    </DashboardTimeProvider>
  );
}
