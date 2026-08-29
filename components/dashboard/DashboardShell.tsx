import type { ReactNode } from "react";
import Link from "next/link";
import {
  Activity,
  BarChart3,
  Bot,
  ExternalLink,
  Gauge,
  LogOut,
  MessageSquareWarning,
  Network,
  Settings,
  Stethoscope,
  UsersRound,
} from "lucide-react";
import { signOut } from "@/app/actions/auth";
import { VertiasLogo, VertiasWordmark } from "@/components/VertiasLogo";
import { cn } from "@/lib/utils";
import { DashboardCommandPalette } from "@/components/dashboard/DashboardCommandPalette";
import { userClient } from "@/lib/supabase/server";
import { DashboardTimeProvider, TimeZoneToggle } from "@/components/dashboard/DashboardTime";
import { GlobalElevationBar, type ActiveElevation } from "@/components/dashboard/GlobalElevationBar";
import { DashboardStickyOffsets } from "@/components/dashboard/DashboardStickyOffsets";
import { instanceLabel } from "@/lib/instance-label";
import { readProfile } from "@/lib/profile/manage";
import { serviceClient } from "@/lib/supabase";
import { getCachedMigrationHealth } from "@/lib/system-health/cache";
import { systemOperatorEmails } from "@/lib/system-health/operator";
import { MigrationBanner } from "@/components/dashboard/MigrationBanner";
import { mfaAuthorizedUser } from "@/lib/mfa";
import type { SystemHealthSnapshot } from "@/lib/system-health";

export type DashboardArea = "overview" | "graph" | "fleet" | "activity" | "spend" | "settings" | "beta" | "system" | "report";

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
  { id: "settings", label: "Settings", href: "/dashboard/settings", Icon: Settings },
];

function Navigation({ active, mobile = false, showBetaOperator = false, showSystemHealth = false }: { active: DashboardArea; mobile?: boolean; showBetaOperator?: boolean; showSystemHealth?: boolean }) {
  const entries = [
    ...NAV,
    ...(showSystemHealth ? [{ id: "system" as const, label: "System health", href: "/dashboard/system", Icon: Stethoscope }] : []),
  ];
  return (
    <nav aria-label="Control Tower" className={mobile ? "pc-mobile-nav__links" : "pc-sidebar__nav"}>
      {entries.map(({ id, label, href, Icon }) => (
        <Link
          key={id}
          href={href}
          aria-current={active === id ? "page" : undefined}
          className={cn("pc-nav-link", active === id && "is-active")}
        >
          <Icon aria-hidden="true" />
          <span>{label}</span>
        </Link>
      ))}
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
  const showSystemHealth = mfa.ok
    && systemOperatorEmails().has(mfa.user.email?.trim().toLowerCase() ?? "")
    && (mfa.user.factors ?? []).some((factor) => factor.factor_type === "totp" && factor.status === "verified");

  // Serial, and only for an operator. It cannot join the Promise.all above
  // because it depends on `auth` resolving first — which is the point: a tenant
  // never pays for this read, and never sees how far behind the instance is.
  // getCachedMigrationHealth is the cheap collector (one bounded query, no Redis ping,
  // no vault probe) precisely so it can sit on every dashboard load.
  const migrations = showSystemHealth
    ? migrationHealth !== undefined ? migrationHealth : await getCachedMigrationHealth()
    : null;

  return (
    <DashboardTimeProvider>
    <div className="pc-app min-h-screen bg-background text-foreground">
      <a href="#pc-main" className="pc-skip-link">
        Skip to content
      </a>

      <header className="pc-mobile-bar">
        <Link href="/dashboard" className="pc-brand" aria-label="PassControl overview">
          <VertiasLogo size={21} />
          <VertiasWordmark size={15} />
          <span>/ PassControl</span>
        </Link>
        <details className="pc-mobile-nav">
          <summary aria-label="Open navigation">Menu</summary>
          <div className="pc-mobile-nav__panel">
            <Navigation active={active} mobile showBetaOperator={showBetaOperator} showSystemHealth={showSystemHealth} />
            <Link href="/dashboard/report" className="pc-nav-link">
              <MessageSquareWarning aria-hidden="true" />
              <span>Report a problem</span>
            </Link>
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
            <VertiasLogo size={27} />
            <span>
              <VertiasWordmark size={17} />
              <small>PassControl</small>
            </span>
          </Link>

          {/* Who is signed in, then WHICH deployment. The order is the change:
              this block used to show the deployment label alone, so the one
              thing it never answered was "whose session is this" — the question
              that matters most on a screen with a kill switch on it. The
              deployment label keeps its place on the second line, because an
              operator with a local stack and a production tab open needs both. */}
          <Link href="/dashboard/settings#profile" className="pc-sidebar__operator">
            <span className="pc-sidebar__operator-avatar" aria-hidden="true">
              {profileRecord?.avatar_key && profileRecord.avatar_path ? (
                // eslint-disable-next-line @next/next/no-img-element -- served
                // from our own origin by app/avatars/[key], keyed on a
                // capability token rather than the tenant id.
                <img src={`/avatars/${profileRecord.avatar_key}`} alt="" width={28} height={28} />
              ) : (
                operatorInitials(profileRecord?.display_name ?? null, profileRecord?.username ?? null)
              )}
            </span>
            <span>
              {profileRecord?.display_name ?? (profileRecord?.username ? `@${profileRecord.username}` : "Your profile")}
              <small>{profileRecord?.username ? `@${profileRecord.username}` : "Set a handle"}</small>
            </span>
          </Link>

          <div className="pc-sidebar__instance">
            <span className="pc-live-dot" aria-hidden="true" />
            <span>
              {instanceLabel()}
              <small>Operator session</small>
            </span>
          </div>

          <Navigation active={active} showBetaOperator={showBetaOperator} showSystemHealth={showSystemHealth} />

          <div className="pc-sidebar__footer">
            {/*
              Reachable from every page on purpose: people report where they got
              stuck, not from a support page they went looking for. A plain Link
              rather than a modal, so the shell — which renders on every
              dashboard route — pays nothing for it.
            */}
            <Link href="/dashboard/report" className="pc-nav-link">
              <MessageSquareWarning aria-hidden="true" />
              <span>Report a problem</span>
            </Link>
            <Link href="/verify" className="pc-nav-link">
              <ExternalLink aria-hidden="true" />
              <span>Verify passport</span>
            </Link>
            <form action={signOut}>
              <button type="submit" className="pc-nav-link w-full">
                <LogOut aria-hidden="true" />
                <span>Sign out</span>
              </button>
            </form>
            <p>Identity crosses the boundary. Secrets do not.</p>
          </div>
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
    </DashboardTimeProvider>
  );
}
