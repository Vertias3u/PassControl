import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AgentPassport } from "@/components/AgentPassport";
import { needsMfaStepUp } from "@/lib/mfa";
import { userClient } from "@/lib/supabase/server";
import { requireAgentPassport } from "./passport-data";
import type { AgentPolicyView } from "@/lib/scope";
import { visaTtlSeconds } from "@/lib/auth/visa";
import { DecisionTracePanel } from "./DecisionTracePanel";
import { PolicyShadowPanel } from "@/components/PolicyShadowPanel";
import { PassportLifecycle } from "@/components/PassportLifecycle";
import { BreakGlassPanel } from "@/components/BreakGlassPanel";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { StatusPill, type StatusType } from "@/components/StatusPill";
import { DirectAgentKeyPanel } from "@/components/DirectAgentKeyPanel";
import { AgentPublicListing } from "@/components/AgentPublicListing";
import { readProfile } from "@/lib/profile/manage";
import { serviceClient } from "@/lib/supabase";
import { SectionHeader } from "@/components/dashboard/SectionHeader";
import { betaOperatorEmails } from "@/lib/beta-launch";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agent Passport",
  robots: { index: false, follow: false },
};

function AgentPolicySummary({ policy }: { policy: AgentPolicyView }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            Capability controls
          </p>
          <h2 className="mt-2 text-lg font-bold text-foreground">Policy rules</h2>
        </div>
        <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-xs font-semibold text-muted-foreground">
          Read-only
        </span>
      </div>

      {!policy.valid ? (
        <p className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          This policy is malformed. The gateway fails closed and blocks calls until it is corrected.
        </p>
      ) : !policy.configured ? (
        <p className="mt-4 text-sm text-muted-foreground">
          No extra policy rules. Visa scope, endpoint controls, and budgets still apply.
        </p>
      ) : (
        <dl className="mt-4 grid gap-4 text-sm">
          <div>
            <dt className="font-semibold text-foreground">Denied models</dt>
            <dd className="mt-1 text-muted-foreground">
              {policy.deny.length ? (
                <ul className="m-0 grid list-none gap-1 p-0">
                  {policy.deny.map((rule, index) => (
                    <li key={`${rule.provider}-${index}`}>
                      {rule.provider}: {rule.models.join(", ") || "No model patterns"}
                    </li>
                  ))}
                </ul>
              ) : (
                "None"
              )}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">Allowed windows</dt>
            <dd className="mt-1 text-muted-foreground">
              {policy.windows.length ? (
                <ul className="m-0 grid list-none gap-1 p-0">
                  {policy.windows.map((window, index) => (
                    <li key={`${window.start}-${window.end}-${index}`}>
                      {window.days.join(", ")} · {window.start}–{window.end} {window.tz}
                    </li>
                  ))}
                </ul>
              ) : (
                "Any time"
              )}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">Hourly request cap</dt>
            <dd className="mt-1 text-muted-foreground">
              {policy.maxRequestsPerHour === null
                ? "No additional cap"
                : `${policy.maxRequestsPerHour.toLocaleString()} requests per agent`}
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}

export default async function AgentPassportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();

  if (!user) redirect("/login");
  if (await needsMfaStepUp(db)) redirect("/login/verify");

  const passport = await requireAgentPassport(db, user.id, id);
  const firstVisa = passport.visas[0];
  // The listing panel has to name whichever of the two opt-ins is still
  // missing, so it needs the operator's own profile state. Tolerates null: a
  // freshly signed-up operator has no row, and the panel then says the profile
  // is not public, which is true.
  const profile = await readProfile(serviceClient(), user.id);
  const profileRecord = profile.ok ? profile.data : null;

  return (
    <DashboardShell
      userId={user.id}
      showBetaOperator={betaOperatorEmails().has(user.email?.trim().toLowerCase() ?? "")}
      active="fleet"
      eyebrow="Agent workspace"
      title={passport.agent.name || "Unnamed agent"}
      description={
        <span className="pc-agent-header-meta">
          <StatusPill status={passport.agent.status as StatusType} />
          {passport.agent.passportId ? (
            <code title={passport.agent.passportId}>{passport.agent.passportId.slice(0, 18)}…</code>
          ) : (
            <code>Direct Agent Key identity</code>
          )}
          {passport.breakGlass ? <strong>Temporary elevation active</strong> : null}
        </span>
      }
      actions={
        <Link href="/dashboard#fleet" className="pc-back-link">
          ← Back to fleet
        </Link>
      }
      contentClassName="pc-agent-content"
    >
        <nav className="pc-agent-subnav" aria-label="Agent sections">
          <a href="#agent-overview">Overview</a>
          <a href="#agent-identity">Identity</a>
          <a href="#agent-public">Public listing</a>
          <a href="#agent-policy">Live policy</a>
          <a href="#agent-policy-lab">Policy lab</a>
          <a href="#agent-activity">Activity</a>
          <a href="#agent-emergency">Emergency access</a>
          <a href="#agent-trace">Decision trace</a>
        </nav>

        <section id="agent-overview" className="scroll-mt-40">
        <div id="agent-identity" className="scroll-mt-40">
        <AgentPassport passport={passport} visaTtlSeconds={visaTtlSeconds()} />
        </div>
        </section>
        {/* Directly under the passport itself: expiry and rotation are facts
            about this key, not about what it is allowed to reach. */}
        {passport.agent.passportId ? <div id="agent-lifecycle" className="scroll-mt-40">
        <PassportLifecycle
          agentId={passport.agent.id}
          status={passport.agent.status}
          expiresAt={passport.agent.expiresAt}
          previousPassportId={passport.agent.previousPassportId}
          previousValidUntil={passport.agent.previousValidUntil}
          currentPassportId={passport.agent.passportId}
          visaTtlSeconds={visaTtlSeconds()}
        />
        </div> : null}
        <DirectAgentKeyPanel
          agentId={passport.agent.id}
          agentName={passport.agent.name}
          status={passport.agent.status}
          keys={passport.directKeys}
        />
        {/* With identity, not with policy, and deliberately NOT a toggle in the
            fleet table: a row-level switch in a list makes publishing something
            you do by accident, and this is the one control on the dashboard
            whose effect strangers can see. */}
        <section id="agent-public" className="pc-section scroll-mt-40">
          <SectionHeader
            eyebrow="Public identity"
            title="Public listing"
            description={<>
            Whether this agent appears on your public profile. It is the second of two
            opt-ins — publishing your profile lists <strong>no agent</strong> by itself.
            </>}
          />
          <div className="pc-section__body">
            <AgentPublicListing
              agentId={passport.agent.id}
              agentName={passport.agent.name}
              published={passport.agent.published}
              publicLabel={passport.agent.publicLabel}
              hasPassport={Boolean(passport.agent.passportId)}
              profileHandle={profileRecord?.username ?? null}
              profilePublic={profileRecord?.profile_public === true}
            />
          </div>
        </section>
        <div id="agent-policy" className="scroll-mt-40">
        <AgentPolicySummary policy={passport.policy} />
        </div>
        {/* Directly below the live policy, because the pair is the point: what
            decides now, and what would decide if you promoted the draft. */}
        <div id="agent-policy-lab" className="scroll-mt-40">
        <PolicyShadowPanel
          agentId={passport.agent.id}
          shadow={passport.shadow}
          liveConfigured={passport.policy.configured}
          livePolicy={passport.policyDocument}
        />
        </div>
        {/* Below the policy it cannot widen, and above the trace that now
            accounts for it. */}
        <div id="agent-emergency" className="scroll-mt-40">
        <BreakGlassPanel
          agentId={passport.agent.id}
          status={passport.agent.status}
          grant={passport.breakGlass}
          visaTtlSeconds={visaTtlSeconds()}
        />
        </div>
        <div id="agent-trace" className="scroll-mt-40">
        <DecisionTracePanel
          agentId={passport.agent.id}
          initialProvider={firstVisa?.provider}
          initialModel={firstVisa?.models[0]}
        />
        </div>
    </DashboardShell>
  );
}
