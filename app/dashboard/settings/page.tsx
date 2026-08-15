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
import { ApiKeysManager } from "@/components/ApiKeysManager";
import { OwnerBinding } from "@/components/OwnerBinding";
import { AccountLifecycle } from "@/components/AccountLifecycle";
import { readOwner } from "@/lib/owner/manage";
import { serviceClient } from "@/lib/supabase";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { SectionHeader } from "@/components/dashboard/SectionHeader";
import { Fingerprint, KeyRound, ShieldCheck, Vault } from "lucide-react";
import { betaOperatorEmails } from "@/lib/beta-launch";

export const dynamic = "force-dynamic";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  // Same step-up gate as the Control Tower — this page holds the provider keys.
  if (await needsMfaStepUp(db)) redirect("/login/verify");

  // Metadata only; key_hash is never selected.
  // agent_owners is SELECT-only for `authenticated` (0017) and readOwner filters
  // on user_id explicitly, so the service-role client here is the same tenant
  // boundary the control route uses — enforced in code, not by RLS.
  const [{ data: apiKeys }, mfaStatus, owner, providerCredentialCount] = await Promise.all([
    db
      .from("api_keys")
      .select("id, name, key_prefix, scope, last_used_at, revoked_at, created_at")
      .order("created_at", { ascending: false }),
    getMfaStatus(),
    readOwner(serviceClient(), user.id),
    db.from("provider_credentials").select("id", { count: "exact", head: true }),
  ]);

  const activeApiKeys = (apiKeys ?? []).filter((key) => !key.revoked_at).length;
  const providerCount = providerCredentialCount.count ?? 0;
  const ownerRecord = owner.ok ? owner.data : null;

  return (
    <DashboardShell
      userId={user.id}
      showBetaOperator={betaOperatorEmails().has(user.email?.trim().toLowerCase() ?? "")}
      active="settings"
      eyebrow="Administration"
      title="Settings"
      description="Credentials, operator access, account security, and public ownership."
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
          <span><strong>Account security</strong><small>{mfaStatus.enrolled ? `MFA on · ${mfaStatus.recoveryRemaining} recovery codes` : "MFA is not enabled"}</small></span>
        </a>
        <a href="#ownership" data-state={ownerRecord?.published ? "ready" : "neutral"}>
          <Fingerprint aria-hidden="true" />
          <span><strong>Public ownership</strong><small>{ownerRecord?.published ? "Published with receipts" : ownerRecord ? "Declared, not published" : "No owner declared"}</small></span>
        </a>
      </div>

      <div className="pc-settings-layout">
        <nav aria-label="Settings sections" className="pc-settings-nav">
          <a href="#provider-credentials">Provider credentials</a>
          <a href="#control-api-keys">Control API keys</a>
          <a href="#account-security">Security and MFA</a>
          <a href="#ownership">Ownership</a>
          <a href="#account-data">Account data</a>
        </nav>

        <div className="pc-settings-sections">
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
          <ProviderKeysManager />
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

        <section id="ownership" className="pc-section scroll-mt-28">
          <SectionHeader
            eyebrow="Public identity"
            title="Owner binding"
            description={<>
            Who your passports belong to. A passport already proves it was issued here and is
            still valid; this is what lets a stranger holding one know who stands behind it.
            Nothing is shown to anyone until you publish it.
            </>}
          />
          <div className="pc-section__body">
          <OwnerBinding owner={ownerRecord} />
          </div>
        </section>

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
        </div>
      </div>
    </DashboardShell>
  );
}
