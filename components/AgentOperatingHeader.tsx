import { AgentSuspendControl } from "@/components/AgentSuspendControl";
import type { PeriodKind } from "@/lib/period";
import { periodLimitSummary, type PeriodUsageView } from "@/lib/period-display";

function formatTtl(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} seconds`;
}

function capLine(label: string, spent: string, cap: string | null): string {
  return cap === null ? `No ${label} cap` : `${spent} of ${cap} ${label} used (cumulative cap)`;
}

/**
 * The agent's operating area — v1 playbook Session 05, requirement 1: whether
 * it is running, what it may reach, what it may spend, how its worker connects,
 * and the control that stops it, without going back to a Fleet row menu.
 *
 * Reuses the shared suspend contract (desired state in, observed state out).
 * Scope-timing copy follows the credential actually used, because the two
 * differ: a Direct Agent Key is checked against current scope on every request,
 * while an already-issued passport work-visa carries its scope until it expires.
 */
export function AgentOperatingHeader({
  agentId,
  agentName,
  status,
  hasPassport,
  activeDirectKeys,
  scopes,
  serviceAccess,
  budgets,
  visaTtlSeconds,
  passportSecretExposedAt = null,
}: {
  agentId: string;
  agentName: string;
  status: string;
  hasPassport: boolean;
  activeDirectKeys: number;
  scopes: readonly { provider: string; models: readonly string[] }[];
  /**
   * Non-LLM services this agent has rules for (any-API), e.g. GitHub: 3 rules.
   * Omitted when unknown; an agent with only services is not "allowed nothing".
   */
  serviceAccess?: readonly { label: string; rules: number }[];
  budgets: {
    tokens: { spentTokens: number; capTokens: number | null };
    cost: { spentCents: number; capCents: number | null };
    period?: { kind: PeriodKind; capCents: number; usage: PeriodUsageView | null } | null;
  };
  visaTtlSeconds: number;
  /**
   * When the gateway proved this agent's CURRENT passport private key was
   * presented to it as an API key (C1 detection). null when not, or unreadable.
   */
  passportSecretExposedAt?: string | null;
}) {
  const state =
    status === "suspended"
      ? "Suspended — its next request is refused."
      : status === "revoked"
        ? "Revoked — its credentials no longer authenticate."
        : "Active — requests within its access are admitted.";
  const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const credentials = [
    activeDirectKeys > 0 ? `Direct Agent Key (${activeDirectKeys} active)` : null,
    hasPassport ? "Passport" : null,
  ].filter(Boolean);

  return (
    <section
      id="agent-operate"
      className="grid scroll-mt-40 gap-4 rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6"
      aria-labelledby="agent-operate-heading"
      data-agent-status={status}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-primary">Operate</p>
          <h2 id="agent-operate-heading" className="mt-2 text-lg font-bold">{state}</h2>
        </div>
        <AgentSuspendControl agentId={agentId} agentName={agentName} status={status} />
      </div>

      {passportSecretExposedAt ? (
        <p
          className="m-0 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm leading-6 text-danger"
          role="alert"
          data-passport-secret-exposed={passportSecretExposedAt}
        >
          <strong>Passport private key exposed — rotate it.</strong> On{" "}
          {new Date(passportSecretExposedAt).toISOString().replace("T", " ").slice(0, 16)} UTC this agent&apos;s
          private passport key was sent to the gateway as an API key, so it has left the agent&apos;s private
          runtime. Rotate the passport below. A client that only takes a static API key needs a Direct Agent Key
          or the local passport sidecar.
        </p>
      ) : null}

      <dl className="m-0 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Access</dt>
          <dd className="m-0 mt-1 break-words" data-operate="access">
            {(() => {
              const services = (serviceAccess ?? []).filter((entry) => entry.rules > 0);
              const serviceText = services
                .map((entry) => `${entry.label}: ${entry.rules} ${entry.rules === 1 ? "rule" : "rules"}`)
                .join(" · ");
              if (scopes.length === 0) {
                return services.length === 0
                  ? "Nothing — no provider, model or service is allowed."
                  : `No model access · ${serviceText}`;
              }
              const models = scopes.map((entry) => `${entry.provider}: ${entry.models.join(", ") || "no models"}`).join(" · ");
              return services.length === 0 ? models : `${models} · ${serviceText}`;
            })()}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Caps</dt>
          <dd className="m-0 mt-1" data-operate="caps">
            {capLine("token", budgets.tokens.spentTokens.toLocaleString("en-US"), budgets.tokens.capTokens === null ? null : budgets.tokens.capTokens.toLocaleString("en-US"))}
            <br />
            {capLine("cost", usd(budgets.cost.spentCents), budgets.cost.capCents === null ? null : usd(budgets.cost.capCents))}
            {budgets.period ? (
              <>
                <br />
                <span
                  data-operate="period-limit"
                  data-period-state={periodLimitSummary(budgets.period.kind, budgets.period.capCents, budgets.period.usage).state}
                >
                  {periodLimitSummary(budgets.period.kind, budgets.period.capCents, budgets.period.usage).text}
                </span>
              </>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Credentials</dt>
          <dd className="m-0 mt-1" data-operate="credentials">{credentials.length ? credentials.join(" · ") : "None active"}</dd>
        </div>
      </dl>

      <div className="grid gap-1 text-xs leading-5 text-muted-foreground" data-operate="scope-timing">
        {activeDirectKeys > 0 ? (
          <p className="m-0">Access changes apply to the Direct Agent Key&apos;s next request.</p>
        ) : null}
        {hasPassport ? (
          <p className="m-0">
            A passport work-visa already issued keeps the access it was issued with for up to {formatTtl(visaTtlSeconds)};
            visas issued after a change carry the new access.
          </p>
        ) : null}
        <p className="m-0">
          Suspend stops this agent. Revoking one installation key stops only that key. The fleet kill switch stops every
          agent in the workspace. None of them recalls a call already sent to the provider.
        </p>
      </div>

      <nav className="flex flex-wrap gap-2 text-sm" aria-label="Agent operations">
        <a className="ghost" href="#agent-access">Edit access</a>
        {activeDirectKeys > 0 ? <a className="ghost" href="#agent-setup">Setup</a> : null}
        <a className="ghost" href="#agent-activity">Activity</a>
      </nav>
    </section>
  );
}
