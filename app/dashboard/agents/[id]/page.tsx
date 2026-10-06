import { readPassportSecretExposure } from "@/lib/state/redis";
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
import { SenderProofPanel } from "@/components/SenderProofPanel";
import { PassportLifecycle } from "@/components/PassportLifecycle";
import { BreakGlassPanel } from "@/components/BreakGlassPanel";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { StatusPill, type StatusType } from "@/components/StatusPill";
import { DirectAgentKeyPanel } from "@/components/DirectAgentKeyPanel";
import { AgentSetupPanel } from "@/components/AgentSetupPanel";
import { AgentOperatingHeader } from "@/components/AgentOperatingHeader";
import { serviceClient } from "@/lib/supabase";
import { SectionHeader } from "@/components/dashboard/SectionHeader";
import { operatorEmails } from "@/lib/operator-allowlist";
import { redis } from "@/lib/state/redis";
import { readPassportSourceSignals } from "@/lib/passport-source-observation";
import { KeyStoragePanel } from "@/components/KeyStoragePanel";
import {
  readDeclaredKeyStorage,
  toDeclaredKeyStorageView,
} from "@/lib/passport-key-storage";
import { readKeyCustodyExpectation } from "@/lib/key-custody-expectation";
import { AgentServiceAccess } from "@/components/AgentServiceAccess";
import { ServiceLogo } from "@/components/ServiceLogo";
import { readAgentServiceAccess } from "./service-access-data";
import { AgentSectionNav, type AgentNavGroup } from "@/components/dashboard/AgentSectionNav";
import { SERVICE_CATALOG, ruleShapeFor } from "@/lib/services/catalog";
import { DISPLAYED_SERVICES, SERVICE_DISPLAY } from "@/lib/services/display";

export const dynamic = "force-dynamic";

// Neutral on purpose: a Direct Agent Key agent has no passport, and naming the
// tab after one mislabels the identity (CLAUDE.md trust boundary 1).
export const metadata: Metadata = {
  title: "Agent",
  robots: { index: false, follow: false },
};

async function loadPassportSourceSignals(agentId: string) {
  try {
    return await readPassportSourceSignals(redis(), agentId);
  } catch {
    return [];
  }
}

async function loadDeclaredKeyStorage(agentId: string) {
  try {
    return await readDeclaredKeyStorage(redis(), agentId);
  } catch {
    return null;
  }
}

/**
 * The freshest evidence this page has that the agent authenticated, used only
 * to say whether a custody claim has been left behind by later activity. The
 * log-derived time leads because `agents.last_seen_at` lags the reconcile flush
 * by up to a day — which can only under-report staleness, the safe direction.
 */
function latestActivityAt(
  lastEntryAt: string | null,
  recordedAt: string | null | undefined
): string | null {
  const times = [lastEntryAt, recordedAt ?? null]
    .filter((value): value is string => Boolean(value))
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

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
          <div>
            <dt className="font-semibold text-foreground">Output ceiling</dt>
            <dd className="mt-1 text-muted-foreground" data-policy-summary="max_output_tokens">
              {policy.maxOutputTokens === null
                ? "No ceiling"
                : `${policy.maxOutputTokens.toLocaleString()} tokens per request — requests must state a limit at or under it`}
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
  // Supplementary observation only: ownership has already been established,
  // and an unavailable Redis signal must never take down the agent page.
  const sourceSignals = passport.agent.passportId
    ? await loadPassportSourceSignals(passport.agent.id)
    : [];
  // Passport agents only. A Direct Agent Key is a bearer credential with no
  // private key to keep anywhere, so a custody panel on one is a category error.
  const declaredKeyStorage = passport.agent.passportId
    ? await loadDeclaredKeyStorage(passport.agent.id)
    : null;
  // The same line the fleet table marks this agent against. Read on both pages
  // rather than passed down, but through the one function, so the two surfaces
  // cannot end up giving one fact two answers.
  const keyCustodyExpectation = passport.agent.passportId
    ? await readKeyCustodyExpectation(db, user.id)
    : null;
  const passportWithSourceSignals = { ...passport, sourceSignals };
  // Where "Ask me first" questions also go, for what the access editor says.
  // RLS scopes the read; a database without 0078 errors, which reads as unknown.
  const alertRead = await db.from("workspace_alerts").select("destination").maybeSingle();
  const alertKind = (alertRead.data as { destination?: unknown } | null)?.destination;
  const alertDestination = alertRead.error
    ? undefined
    : alertKind === "telegram" || alertKind === "slack" || alertKind === "discord"
      ? alertKind
      : null;
  // Every catalog service, in catalog order (lib/services/display.ts).
  const serviceAccess = await Promise.all(
    DISPLAYED_SERVICES.map(async (service) => ({
      service,
      label: SERVICE_CATALOG[service].label,
      display: SERVICE_DISPLAY[service],
      access: await readAgentServiceAccess(db, user.id, passport.agent.id, service),
    }))
  );
  // C1 detection: the gateway proved this agent's private passport key was sent
  // to it as an API key. Shown only while it names the CURRENT key, so rotating
  // the passport clears it. Best-effort, like the source signals above.
  const secretExposure = passport.agent.passportId ? await readPassportSecretExposure(passport.agent.id) : null;
  const passportSecretExposedAt =
    secretExposure && secretExposure.passportId === passport.agent.passportId ? secretExposure.at : null;
  // The exported card carries real colour values, so the accent has to reach it as
  // data — it cannot read var(--pc-brand) through an image serialisation.
  const firstVisa = passport.visas[0];

  // The section nav's three groups. Operate is the identity's live status, and
  // break glass is temporary access, so neither needs a group of its own.
  const navGroups: AgentNavGroup[] = [
    {
      id: "identity",
      label: "Identity",
      links: [
        { href: "#agent-operate", label: "Status" },
        { href: "#agent-overview", label: "Overview" },
        { href: "#agent-identity", label: "Credentials" },
        ...(passport.directKeys.length > 0 ? [{ href: "#agent-setup" as const, label: "Setup" }] : []),
      ],
    },
    {
      id: "access",
      label: "Access",
      links: [
        { href: "#agent-policy", label: "Policy" },
        ...serviceAccess.map(({ label, display }) => ({
          href: `#${display.sectionId}` as const,
          label,
          ariaLabel: `${label} access`,
        })),
        { href: "#agent-policy-lab", label: "Lab", ariaLabel: "Policy lab" },
        { href: "#agent-emergency", label: "Break glass", ariaLabel: "Temporary access (break glass)" },
      ],
    },
    {
      id: "record",
      label: "Record",
      links: [
        { href: "#agent-activity", label: "Activity" },
        { href: "#agent-trace", label: "Trace", ariaLabel: "Decision trace" },
      ],
    },
  ];

  return (
    <DashboardShell
      userId={user.id}
      showBetaOperator={operatorEmails().has(user.email?.trim().toLowerCase() ?? "")}
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
        {/* Three fixed groups with one sub-row (components/dashboard/AgentSectionNav).
            Every section id is unchanged: refusal messages, the fleet table and
            the services page deep-link to them. */}
        <AgentSectionNav groups={navGroups} />

        <AgentOperatingHeader
          serviceAccess={serviceAccess.map(({ label, access }) => ({
            label,
            rules: access.state === "ok" ? access.allow.length : 0,
          }))}
          agentId={passport.agent.id}
          agentName={passport.agent.name}
          status={passport.agent.status}
          hasPassport={Boolean(passport.agent.passportId)}
          activeDirectKeys={passport.directKeys.filter((key) => !key.revokedAt && !(key.expiresAt && Date.parse(key.expiresAt) <= Date.now())).length}
          scopes={passport.visas}
          budgets={passport.budgets}
          visaTtlSeconds={visaTtlSeconds()}
          passportSecretExposedAt={passportSecretExposedAt}
        />
        <section id="agent-overview" className="scroll-mt-40">
        <div id="agent-identity" className="scroll-mt-40">
        <AgentPassport
          passport={passportWithSourceSignals}
          services={serviceAccess
            .filter(({ access }) => access.state === "ok" && access.allow.length > 0)
            .map(({ label }) => label)}
          visaTtlSeconds={visaTtlSeconds()}
        />
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
        {/* With the key's own lifecycle, not with policy: this is a fact about
            where the private half lives, and — unlike everything around it —
            one this server can only ever repeat, never check. */}
        {passport.agent.passportId ? (
          <KeyStoragePanel
            expectation={keyCustodyExpectation?.expectation ?? null}
            view={toDeclaredKeyStorageView(
              declaredKeyStorage,
              latestActivityAt(
                passport.agent.lastEntryAt,
                passport.lastRecordedAuthentication?.recordedAt
              )
            )}
          />
        ) : null}
        {/* Direct Agent Key agents only: a passport worker connects through the
            SDK or sidecar configured at issuance, which this view does not
            rebuild. Above the key list because reconnecting is the common
            visit and replacing a lost key is the exception. */}
        {passport.directKeys.length > 0 ? (
          <AgentSetupPanel
            agentId={passport.agent.id}
            agentName={passport.agent.name}
            status={passport.agent.status}
            scopes={passport.visas}
            keys={passport.directKeys}
          />
        ) : null}
        <DirectAgentKeyPanel
          agentId={passport.agent.id}
          agentName={passport.agent.name}
          status={passport.agent.status}
          keys={passport.directKeys}
        />
        <div id="agent-policy" className="scroll-mt-40">
        <AgentPolicySummary policy={passport.policy} />
        </div>
        {/* Beside the live policy, but not part of it: these rules ARE the scope
            of a service call, and nothing in the policy above applies to one. */}
        {serviceAccess.map(({ service, label, display, access }) => (
          <section key={service} id={display.sectionId} className="pc-section scroll-mt-40">
            <SectionHeader
              eyebrow="Service access"
              title={`${label} access`}
              icon={<ServiceLogo service={service} />}
              description={display.accessDescription}
            />
            <div className="pc-section__body">
              <AgentServiceAccess
                agentId={passport.agent.id}
                service={service}
                serviceLabel={label}
                ruleShape={ruleShapeFor(service)}
                initialAllow={access.state === "ok" ? access.allow : []}
                initialCap={access.state === "ok" ? access.maxRequestsPerHour : null}
                state={access.state}
                tokenStored={access.state === "unavailable" ? null : access.tokenStored}
                alertDestination={alertDestination}
              />
            </div>
          </section>
        ))}
        {/* Directly below the live policy, because the pair is the point: what
            decides now, and what would decide if you promoted the draft. */}
        <div id="agent-policy-lab" className="scroll-mt-40">
        <PolicyShadowPanel
          agentId={passport.agent.id}
          shadow={passport.shadow}
          liveConfigured={passport.policy.configured}
          liveReadable={passport.policy.valid}
          livePolicy={passport.policyDocument}
        />
        {/* Beside the shadow panel because they are the same idea one boundary
            apart: both check something for real and let the call through, so an
            operator can decide from their own traffic instead of from a guess. */}
        <SenderProofPanel
          agentId={passport.agent.id}
          mode={passport.agent.senderConstraintMode}
          summary={passport.senderProof}
          hasPassport={Boolean(passport.agent.passportId)}
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
