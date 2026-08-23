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
import { ProfileSettings } from "@/components/ProfileSettings";
import { AccountLifecycle } from "@/components/AccountLifecycle";
import { RecoveryPanel } from "@/components/RecoveryPanel";
import { readOwner } from "@/lib/owner/manage";
import { readProfile } from "@/lib/profile/manage";
import { serviceClient } from "@/lib/supabase";
import { DashboardShell } from "@/components/dashboard/DashboardShell";
import { SectionHeader } from "@/components/dashboard/SectionHeader";
import { Fingerprint, KeyRound, ShieldCheck, UserRound, Vault } from "lucide-react";
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
  const [{ data: apiKeys }, mfaStatus, owner, profile, publishedAgents, providerCredentials, { data: lastExport }] = await Promise.all([
    db
      .from("api_keys")
      .select("id, name, key_prefix, scope, last_used_at, revoked_at, created_at")
      .order("created_at", { ascending: false }),
    getMfaStatus(),
    readOwner(serviceClient(), user.id),
    // Tolerates a missing row: nothing creates one at signup, so a freshly
    // signed-up operator legitimately has none and the panel renders empty
    // rather than erroring. See ensureProfileRow's note.
    readProfile(serviceClient(), user.id),
    // How many agents this operator has published, for the panel that has to
    // say — accurately — that publishing the profile publishes no agent.
    // `published` is not in the client's column grant, so this is a plain read.
    db.from("agents").select("id", { count: "exact", head: true }).eq("published", true),
    // Metadata only, and that is structural rather than careful: the secret is
    // in Vault and has no column here to select. `is_active` arrives with
    // migration 0027, so this is read tolerantly — a settings page that 500s
    // because a migration has not been applied yet is a worse failure than a
    // list that is briefly missing, and the add form must keep working either way.
    db
      .from("provider_credentials")
      .select("id, provider, label, created_at, is_active")
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
  ]);

  const activeApiKeys = (apiKeys ?? []).filter((key) => !key.revoked_at).length;
  // An error here means 0027 has not been applied (no `is_active` column). The
  // panel says so and still lets a key be stored, rather than taking the page down.
  const credentialList = (providerCredentials.data ?? []).map((row) => ({
    id: String(row.id),
    provider: String(row.provider),
    label: typeof row.label === "string" ? row.label : null,
    created_at: String(row.created_at),
    is_active: row.is_active === true,
  }));
  const credentialListUnavailable = Boolean(providerCredentials.error);
  // Never infer "no credentials" from a failed read. In the exact window the
  // tolerant read exists for — deployed before 0027, so `is_active` does not
  // resolve — an empty list would light the status chip as "Needs a provider
  // key" for a tenant that has several, which reads as a second fault stacked on
  // the first. One extra head query, only on the degraded path.
  const providerCount = credentialListUnavailable
    ? (
        await db.from("provider_credentials").select("id", { count: "exact", head: true })
      ).count ?? 0
    : credentialList.length;
  const ownerRecord = owner.ok ? owner.data : null;
  const profileRecord = profile.ok ? profile.data : null;
  const publishedAgentCount = publishedAgents.count ?? 0;

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
        <a href="#profile" data-state={profileRecord?.profile_public ? "ready" : profileRecord?.username ? "neutral" : "attention"}>
          <UserRound aria-hidden="true" />
          <span><strong>Operator profile</strong><small>{profileRecord?.profile_public ? `Public at /@${profileRecord.username}` : profileRecord?.username ? `@${profileRecord.username} · private` : "No handle yet"}</small></span>
        </a>
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
        <a href="#ownership" data-state={ownerRecord?.published ? "ready" : "neutral"}>
          <Fingerprint aria-hidden="true" />
          <span><strong>Public ownership</strong><small>{ownerRecord?.published ? "Published with receipts" : ownerRecord ? "Declared, not published" : "No owner declared"}</small></span>
        </a>
      </div>

      <div className="pc-settings-layout">
        <nav aria-label="Settings sections" className="pc-settings-nav">
          <a href="#profile">Your profile</a>
          <a href="#provider-credentials">Provider credentials</a>
          <a href="#control-api-keys">Control API keys</a>
          <a href="#account-security">Security and MFA</a>
          <a href="#ownership">Ownership</a>
          <a href="#account-data">Account data</a>
          <a href="#recovery">Recovery</a>
        </nav>

        <div className="pc-settings-sections">
        <section id="profile" className="pc-section scroll-mt-28">
          <SectionHeader
            eyebrow="Operator identity"
            title="Your profile"
            description={<>
            Who you are inside the product, and — only if you choose — on a page at
            <code> /@handle</code> that anyone can read. Publishing the profile publishes
            <strong> no agent</strong>; each one is a separate opt-in on its own page.
            </>}
          />
          <div className="pc-section__body">
            <ProfileSettings profile={profileRecord} publishedAgentCount={publishedAgentCount} />
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
          <ProviderKeysManager
            credentials={credentialList}
            listUnavailable={credentialListUnavailable}
          />
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
