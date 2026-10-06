// Settings — the things you configure once, moved off the Control Tower.
//
// The dashboard is a surface you watch: kill switch, departures, fleet, spend,
// audit. Two-factor enrolment, provider keys and control-plane API keys are
// things you set up and then leave alone, and they were occupying four of the
// eleven sections on the main page — pushing the fleet table, arguably the most
// important thing there, below the fold. They also cost two serial round trips
// on every Control Tower load for panels nobody was looking at.
import { redirect } from "next/navigation";
import { userClient } from "@/lib/supabase/server";
import { needsMfaStepUp } from "@/lib/mfa";
import { getMfaStatus } from "@/app/dashboard/mfa-actions";
import { MfaManager } from "@/components/MfaManager";
import { ProviderKeysManager } from "@/components/ProviderKeysManager";
import { LocalModelsSetup } from "@/components/LocalModelsSetup";
import { endpointPolicy } from "@/lib/providers/endpoint";
import { OLLAMA_ENDPOINT } from "@/lib/providers/local-server";
import { ServiceTokensManager } from "@/components/ServiceTokensManager";
import { SERVICE_CATALOG, isServiceProviderId } from "@/lib/services/catalog";
import { DISPLAYED_SERVICES, SERVICE_DISPLAY } from "@/lib/services/display";
import { toCredentialListItem } from "@/lib/provider-credential-list";
import { ApiKeysManager } from "@/components/ApiKeysManager";
import { AccountLifecycle } from "@/components/AccountLifecycle";
import { RecoveryPanel } from "@/components/RecoveryPanel";
import { serviceClient } from "@/lib/supabase";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { SectionHeader } from "@/components/dashboard/SectionHeader";
import { Fingerprint, KeyRound, ShieldCheck, UserRound, Vault } from "lucide-react";
import { operatorEmails } from "@/lib/operator-allowlist";
import { KeyCustodyExpectation } from "@/components/KeyCustodyExpectation";
import { WorkspaceAlerts } from "@/components/WorkspaceAlerts";
import { readKeyCustodyExpectation } from "@/lib/key-custody-expectation";
import { MotionPreference } from "@/components/dashboard/MotionPreference";
import { motionTurnedOff } from "@/lib/motion-preference";

export const dynamic = "force-dynamic";

export const metadata = { title: "Settings" };

const SETTINGS_DESCRIPTION = "Credentials, operator access, and account security.";

// The animations switch is a self-host setting (owner, 2026-10-06): Cloud's
// copy of these two helpers renders nothing, and the mirror's renders the
// section. Statement-level on purpose: a public-only block inside JSX would be
// read as text.
function motionNavLink() {
  return <a href="#motion">Animations</a>;
}

async function motionSection() {
  const off = await motionTurnedOff();
  return (
    <section id="motion" className="pc-section scroll-mt-28">
      <SectionHeader
        eyebrow="Display"
        title="Animations"
        description="Turn the dashboard's motion off if you would rather it stood still. Nothing else changes."
      />
      <div className="pc-section__body">
        <MotionPreference initialOff={off} />
      </div>
    </section>
  );
}

export default async function SettingsPage() {
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  // Same step-up gate as the Control Tower — this page holds the provider keys.
  if (await needsMfaStepUp(db)) redirect("/login/verify");

  // Metadata only; key_hash is never selected.
  const [
    { data: apiKeys },
    mfaStatus,
    providerCredentials,
    { data: lastExport },
    keyCustodyExpectation,
    alertSettings,
  ] = await Promise.all([
    db
      .from("api_keys")
      .select("id, name, key_prefix, scope, last_used_at, revoked_at, created_at")
      .order("created_at", { ascending: false }),
    getMfaStatus(),
    // Metadata only, and that is structural rather than careful: the secret is
    // in Vault and has no column here to select. `is_active` arrives with
    // migration 0027, so this is read tolerantly — a settings page that 500s
    // because a migration has not been applied yet is a worse failure than a
    // list that is briefly missing, and the add form must keep working either way.
    db
      .from("provider_credentials")
      .select("id, provider, label, created_at, is_active, endpoint_base_url")
      .order("created_at", { ascending: false }),
    // When this workspace last had a configuration export taken, from either
    // surface. The plain user client is enough: admin_audit's select policy is
    // `user_id = (select auth.uid())` (0003), so RLS scopes this for us and
    // there is nothing here the operator may not read about themselves.
    db
      .from("admin_audit")
      .select("created_at")
      .eq("action", "workspace.export")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Its own query and its own tolerant reader: migration 0051 is the owner's
    // to apply, so a build carrying this code will run against a database
    // without the column. Kept out of readProfile's select list on purpose —
    // PostgREST fails the whole request for an unknown column, which would take
    // the profile panels down alongside this one.
    readKeyCustodyExpectation(db, user.id),
    // RLS scopes this to the operator's own row (0078). Only the service and
    // the hint: the webhook URL is in Vault and has no column here to select.
    // A missing table (0078 not applied) is shown as such, not as an error page.
    db.from("workspace_alerts").select("destination, hint, events").maybeSingle(),
  ]);
  const alertsState: "ready" | "unmigrated" | "unavailable" = !alertSettings.error
    ? "ready"
    : ["42P01", "PGRST205"].includes(String(alertSettings.error.code))
      ? "unmigrated"
      : "unavailable";
  const alertDestination = alertSettings.data
    ? {
        kind: String(alertSettings.data.destination),
        hint: String(alertSettings.data.hint),
        events: Array.isArray(alertSettings.data.events) ? alertSettings.data.events.map(String) : [],
      }
    : null;

  const activeApiKeys = (apiKeys ?? []).filter((key) => !key.revoked_at).length;
  // An error here means 0027 has not been applied (no `is_active` column). The
  // panel says so and still lets a key be stored, rather than taking the page down.
  const allCredentials = (providerCredentials.data ?? []).map(toCredentialListItem);
  // Service tokens (`svc:github`, 0074) are listed under Services, never among
  // the LLM provider keys, and never counted as one.
  const credentialList = allCredentials.filter((c) => !isServiceProviderId(c.provider));
  const credentialListUnavailable = Boolean(providerCredentials.error);
  // Never infer "no credentials" from a failed read. In the exact window the
  // tolerant read exists for — deployed before 0027, so `is_active` does not
  // resolve — an empty list would light the status chip as "Needs a provider
  // key" for a tenant that has several, which reads as a second fault stacked on
  // the first. One extra head query, only on the degraded path.
  const providerCount = credentialListUnavailable
    ? (
        await db
          .from("provider_credentials")
          .select("id", { count: "exact", head: true })
          .not("provider", "like", "svc:%")
      ).count ?? 0
    : credentialList.length;

  return (
    <DashboardShell
      userId={user.id}
      showBetaOperator={operatorEmails().has(user.email?.trim().toLowerCase() ?? "")}
      active="settings"
      eyebrow="Administration"
      title="Settings"
      description={SETTINGS_DESCRIPTION}
    >
      <div className="pc-settings-status" aria-label="Settings status">
        <a href="#provider-credentials" data-state={providerCount ? "ready" : "attention"}>
          <Vault aria-hidden="true" />
          <span><strong>Provider credentials</strong><small>{providerCount ? `${providerCount} stored in Vault` : "Needs a provider key"}</small></span>
        </a>
        <a href="#control-api-keys" data-state={activeApiKeys ? "ready" : "neutral"}>
          <KeyRound aria-hidden="true" />
          <span><strong>Control API</strong><small>{activeApiKeys ? `${activeApiKeys} active key${activeApiKeys === 1 ? "" : "s"}` : "No active keys"}</small></span>
        </a>
        <a href="#account-security" data-state={mfaStatus.enrolled ? "ready" : "attention"}>
          <ShieldCheck aria-hidden="true" />
          <span><strong>Account security</strong><small>{mfaStatus.enrolled ? (mfaStatus.recoveryRemaining === null ? "MFA on" : `MFA on · ${mfaStatus.recoveryRemaining} recovery codes`) : "MFA is not enabled"}</small></span>
        </a>
      </div>

      <div className="pc-settings-layout">
        <nav aria-label="Settings sections" className="pc-settings-nav">
          <a href="#key-custody">Key custody</a>
          <a href="#provider-credentials">Provider credentials</a>
          <a href="#services">Services</a>
          <a href="#alerts">Alerts</a>
          <a href="#control-api-keys">Control API keys</a>
          <a href="#account-security">Security and MFA</a>
          {motionNavLink()}
          <a href="#account-data">Account data</a>
          <a href="#recovery">Recovery</a>
        </nav>

        <div className="pc-settings-sections">


        {/* Deliberately NOT next to the kill switch or any other control that
            acts on an agent. This one acts on people: it is a line the operator
            states, and the fleet table marks who is not on it. */}
        <section id="key-custody" className="pc-section scroll-mt-28">
          <SectionHeader
            eyebrow="Agent key hygiene"
            title="Key custody"
            description={<>
            Where you expect agents to keep their passport private keys. A stated
            expectation, <strong>never an enforced one</strong> — the key lives on the
            agent&rsquo;s machine and this server has never seen it, so nothing here can
            move a key or refuse a call.
            </>}
          />
          <div className="pc-section__body">
            <KeyCustodyExpectation
              state={keyCustodyExpectation.state}
              expectation={keyCustodyExpectation.expectation}
            />
          </div>
        </section>

        <section id="provider-credentials" className="pc-section scroll-mt-28">
          <SectionHeader
            eyebrow="Credential vault"
            title="Provider credentials"
            description={<>
            The real vendor keys the gateway injects. Stored in Supabase Vault and readable
            only through the <code>get_provider_key</code> RPC — never by the browser, never
            by an agent.
            </>}
          />
          <div className="pc-section__body">
          {/* Only where the operator gate admits a local address: on hosted
              Cloud it is off, and a setup that can only fail is not offered. */}
          {endpointPolicy().kind !== "off" ? (
            <LocalModelsSetup
              connected={credentialList.some(
                (credential) => credential.provider === "local" && credential.endpoint_base_url === OLLAMA_ENDPOINT
              )}
            />
          ) : null}
          <ProviderKeysManager
            credentials={credentialList}
            listUnavailable={credentialListUnavailable}
          />
          </div>
        </section>

        <section id="services" className="pc-section scroll-mt-28">
          <SectionHeader
            eyebrow="Credential vault"
            title="Services"
            description={<>
            Tokens for APIs other than model providers. Stored in Vault like provider keys and
            injected by the gateway, so an agent never holds one. A token grants nothing by
            itself: each agent&apos;s access is set on its own page, by method and path. Some
            GitHub writes, such as deleting a repository or adding a webhook, are never allowed.
            To stop a service for every agent, or see who can reach it, open{" "}
            <a href="/dashboard/services">Services</a>.
            </>}
          />
          <div className="pc-section__body pc-service-token-list">
          {DISPLAYED_SERVICES.map((service) => (
            <ServiceTokensManager
              key={service}
              service={service}
              serviceLabel={SERVICE_CATALOG[service].label}
              tokens={allCredentials.filter((c) => c.provider === SERVICE_CATALOG[service].credentialProvider)}
              listUnavailable={credentialListUnavailable}
              hint={SERVICE_DISPLAY[service].settingsHint}
            />
          ))}
          </div>
        </section>

        <section id="alerts" className="pc-section scroll-mt-28">
          <SectionHeader
            eyebrow="Notifications"
            title="Alerts"
            description={<>
            Messages in your own Slack, Discord or Telegram chat when an agent is refused, runs out of
            budget, or has a security change.
            </>}
          />
          <div className="pc-section__body">
            <WorkspaceAlerts state={alertsState} destination={alertDestination} />
          </div>
        </section>

        <section id="control-api-keys" className="pc-section scroll-mt-28">
          <SectionHeader
            eyebrow="Automation access"
            title="Control API keys"
            description={<>
            Developer keys for the control-plane API (<code>/api/control/v1</code>). Scope
            <code> read</code> or <code>write</code>; shown once, hashed at rest, revocable.
            </>}
          />
          <div className="pc-section__body">
            <ApiKeysManager keys={apiKeys ?? []} />
          </div>
        </section>

        <section id="account-security" className="pc-section scroll-mt-28">
          <SectionHeader
            eyebrow="Operator protection"
            title="Security and two-factor authentication"
            description={<>
            Optional, and a no-op until you enrol. Worth doing if this dashboard is reachable
            from anywhere but your own machine: it is what stands between a stolen session
            cookie and your provider keys plus the kill switch.
            </>}
          />
          <div className="pc-section__body">
          <MfaManager status={mfaStatus} />
          </div>
        </section>

        {await motionSection()}


        <section id="account-data" className="pc-section scroll-mt-28">
          <SectionHeader
            eyebrow="Data and account"
            title="Account lifecycle"
            description="Take a portable copy of your account data or permanently erase the workspace and its stored credentials."
          />
          <div className="pc-section__body">
            <AccountLifecycle />
          </div>
        </section>

        <section id="recovery" className="pc-section scroll-mt-28">
          <SectionHeader
            eyebrow="Backup and recovery"
            title="Recovery"
            description="What PassControl can restore, what it cannot, and what you would have to re-enter by hand. Worth reading before you need it."
          />
          <div className="pc-section__body">
            <RecoveryPanel lastExportAt={lastExport?.created_at ?? null} />
          </div>
        </section>
        </div>
      </div>
    </DashboardShell>
  );
}
