import { KeyRound, ShieldCheck } from "lucide-react";

import type { AgentPassportView } from "@/app/dashboard/agents/[id]/passport-data";
import { StatusPill, type StatusType } from "@/components/StatusPill";
import { DirectAgentPassportUpgrade } from "@/components/DirectAgentPassportUpgrade";

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

export function DirectAgentIdentity({ passport }: { passport: AgentPassportView }) {
  return (
    <section className="grid gap-5 rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6" aria-labelledby="direct-agent-identity-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-4">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
            <KeyRound aria-hidden="true" className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-primary">Direct agent identity</p>
            <h2 id="direct-agent-identity-heading" className="mt-2 break-words text-2xl font-bold tracking-tight">{passport.agent.name}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              This agent authenticates with revocable bearer credentials. It has no signing passport yet, and receipts never claim that it does.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={passport.agent.status as StatusType} />
          {passport.agent.status !== "revoked" ? (
            <DirectAgentPassportUpgrade agentId={passport.agent.id} agentName={passport.agent.name} />
          ) : null}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-secondary/35 p-4">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Authentication</span>
          <strong className="mt-2 block text-sm">Direct Agent Key</strong>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Accepted as a bearer secret, not passport proof.</p>
        </div>
        <div className="rounded-xl border border-border bg-secondary/35 p-4">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Token budget</span>
          <strong className="mt-2 block text-sm">
            {passport.budgets.tokens.capTokens === null
              ? "Unlimited"
              : `${passport.budgets.tokens.spentTokens.toLocaleString()} / ${passport.budgets.tokens.capTokens.toLocaleString()}`}
          </strong>
        </div>
        <div className="rounded-xl border border-border bg-secondary/35 p-4">
          <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Cost budget</span>
          <strong className="mt-2 block text-sm">
            {passport.budgets.cost.capCents === null
              ? "Unlimited"
              : `${formatUsd(passport.budgets.cost.spentMicrocents / 100_000_000)} / ${formatUsd(passport.budgets.cost.capCents / 100)}`}
          </strong>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-info/25 bg-info/8 p-4 text-sm leading-6">
        <ShieldCheck aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-info" />
        <p className="m-0">Scopes, policy, suspension, kill switches, and budgets still govern every call. A passport can be added later without replacing this agent&apos;s history or identity.</p>
      </div>
    </section>
  );
}
