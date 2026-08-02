import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AgentPassport } from "@/components/AgentPassport";
import { VertiasLogo } from "@/components/VertiasLogo";
import { needsMfaStepUp } from "@/lib/mfa";
import { userClient } from "@/lib/supabase/server";
import { requireAgentPassport } from "./passport-data";
import type { AgentPolicyView } from "@/lib/scope";
import { DecisionTracePanel } from "./DecisionTracePanel";

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

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link
            href="/dashboard"
            className="inline-flex min-w-0 items-center gap-2 text-foreground no-underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
            aria-label="Return to Control Tower"
          >
            <VertiasLogo size={22} />
            <span className="truncate text-sm font-bold">
              Ver<span className="text-primary">tias</span>
              <span className="font-normal text-muted-foreground"> / Control Tower</span>
            </span>
          </Link>
          <Link
            href="/dashboard"
            className="shrink-0 rounded-lg border border-border bg-secondary px-3 py-2 text-xs font-semibold text-foreground no-underline transition-colors hover:bg-secondary/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:text-sm"
          >
            ← Fleet
          </Link>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-4 py-6 sm:px-6 sm:py-8">
        <AgentPassport passport={passport} />
        <AgentPolicySummary policy={passport.policy} />
        <DecisionTracePanel
          agentId={passport.agent.id}
          initialProvider={firstVisa?.provider}
          initialModel={firstVisa?.models[0]}
        />
      </main>
    </div>
  );
}
