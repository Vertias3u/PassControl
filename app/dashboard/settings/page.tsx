// Settings — the things you configure once, moved off the Control Tower.
//
// The dashboard is a surface you watch: kill switch, departures, fleet, spend,
// audit. Two-factor enrolment, provider keys and control-plane API keys are
// things you set up and then leave alone, and they were occupying four of the
// eleven sections on the main page — pushing the fleet table, arguably the most
// important thing there, below the fold. They also cost two serial round trips
// on every Control Tower load for panels nobody was looking at.
import { redirect } from "next/navigation";
import Link from "next/link";
import { userClient } from "@/lib/supabase/server";
import { needsMfaStepUp } from "@/lib/mfa";
import { getMfaStatus } from "@/app/dashboard/mfa-actions";
import { MfaManager } from "@/components/MfaManager";
import { ProviderKeysManager } from "@/components/ProviderKeysManager";
import { ApiKeysManager } from "@/components/ApiKeysManager";
import { VertiasLogo, VertiasWordmark } from "@/components/VertiasLogo";
import { signOut } from "@/app/actions/auth";

export const dynamic = "force-dynamic";

export const metadata = { title: "Settings · PassControl" };

export default async function SettingsPage() {
  const db = await userClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");
  // Same step-up gate as the Control Tower — this page holds the provider keys.
  if (await needsMfaStepUp(db)) redirect("/login/verify");

  // Metadata only; key_hash is never selected.
  const [{ data: apiKeys }, mfaStatus] = await Promise.all([
    db
      .from("api_keys")
      .select("id, name, key_prefix, scope, last_used_at, revoked_at, created_at")
      .order("created_at", { ascending: false }),
    getMfaStatus(),
  ]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2">
            <VertiasLogo size={22} />
            <VertiasWordmark size={16} />
            <span className="text-sm text-muted-foreground">/ Settings</span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold text-foreground no-underline hover:bg-secondary/80"
            >
              Control Tower
            </Link>
            <form action={signOut}>
              <button
                type="submit"
                className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-secondary/80"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-6 py-8">
        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-lg font-bold">Provider keys</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            The real vendor keys the gateway injects. Stored in Supabase Vault and readable
            only through the <code>get_provider_key</code> RPC — never by the browser, never
            by an agent.
          </p>
          <ProviderKeysManager />
        </section>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-1 text-lg font-bold">API keys</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Developer keys for the control-plane API (<code>/api/control/v1</code>). Scope
            <code> read</code> or <code>write</code>; shown once, hashed at rest, revocable.
          </p>
          <div className="overflow-x-auto">
            <ApiKeysManager keys={apiKeys ?? []} />
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-1 text-lg font-bold">Security · two-factor auth</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Optional, and a no-op until you enrol. Worth doing if this dashboard is reachable
            from anywhere but your own machine: it is what stands between a stolen session
            cookie and your provider keys plus the kill switch.
          </p>
          <MfaManager status={mfaStatus} />
        </section>
      </main>
    </div>
  );
}
