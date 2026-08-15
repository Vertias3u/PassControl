"use client";
// Break glass: widen an agent's reach for a bounded time, on the record.
//
// This is a deliberate hole in the capability model, and the UI's job is to make
// that feel like what it is. It looks different from the scope editor on
// purpose: the scope editor changes what this agent IS allowed, permanently and
// quietly. This opens something temporarily and tells people about it.
//
// ── Four things this panel must not let an operator misunderstand ───────────
//
// 1. IT WIDENS SCOPE AND NOTHING ELSE. The kill switch, suspend, policy deny
//    rules and budgets all still apply. Someone reaching for this because a
//    policy is blocking them needs to know it will not help.
// 2. ENDING IT IS NOT INSTANT. The proxy gates on the scope snapshot inside the
//    visa and never re-reads the grant, which is what keeps this feature off
//    the credential path. So a visa already minted keeps the elevation until it
//    expires. A revoke control that reads as instant when it is not is the
//    failure this feature can least afford.
// 3. IT LAPSES ON ITS OWN. Nothing has to run, and nothing can fail to run.
//    That is the reason this design was chosen over widening the stored scope
//    and scheduling a revert.
// 4. THE REASON IS NOT A FORMALITY. It is the whole justification for the
//    feature existing, and it is required by the database, not just the form.
import { useState, useTransition } from "react";

import { PROVIDERS, type ProviderId } from "@/lib/providers";
import {
  MAX_BREAK_GLASS_TTL_S,
  MIN_BREAK_GLASS_TTL_S,
  BREAK_GLASS_REASON_MAX,
  type BreakGlassGrant,
} from "@/lib/break-glass";
import {
  takeBreakGlass,
  endBreakGlass,
} from "@/app/dashboard/agents/[id]/break-glass-actions";
import { useDashboardTime } from "@/components/dashboard/DashboardTime";
import { prospectiveBreakGlassChange } from "@/lib/impact-preview";
import { ImpactPreview } from "@/components/ImpactPreview";

/** Bounded by what fleet.grantBreakGlass will actually accept. */
const DURATIONS = [
  { label: "15 minutes", seconds: 15 * 60 },
  { label: "30 minutes", seconds: 30 * 60 },
  { label: "1 hour", seconds: MAX_BREAK_GLASS_TTL_S },
] as const;

function Remaining({ until }: { until: string }) {
  const ms = Date.parse(until) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return <span>less than a minute</span>;
  const minutes = Math.ceil(ms / 60_000);
  return (
    <span className="font-mono tabular-nums">
      {minutes} minute{minutes === 1 ? "" : "s"}
    </span>
  );
}

export function BreakGlassPanel({
  agentId,
  status,
  grant,
  visaTtlSeconds,
}: {
  agentId: string;
  status: string;
  grant: BreakGlassGrant | null;
  visaTtlSeconds: number;
}) {
  const [opening, setOpening] = useState(false);
  const [provider, setProvider] = useState<ProviderId>(PROVIDERS[0]);
  const [models, setModels] = useState("");
  const [reason, setReason] = useState("");
  const [seconds, setSeconds] = useState<number>(15 * 60);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { format } = useDashboardTime();

  const active = status === "active";
  const modelList = models
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  const ready = modelList.length > 0 && reason.trim().length > 0;
  const projectedExpiry = new Date(Date.now() + seconds * 1000).toISOString();
  const preview = ready
    ? prospectiveBreakGlassChange(
        [{ provider, models: modelList }],
        projectedExpiry,
        reason.trim()
      )
    : null;

  const take = () => {
    setError(null);
    startTransition(async () => {
      const result = await takeBreakGlass(agentId, {
        scopes: [{ provider, models: modelList }],
        reason: reason.trim(),
        ttlSeconds: seconds,
      });
      if (result.error) setError(result.error);
      else {
        setOpening(false);
        setModels("");
        setReason("");
      }
    });
  };

  const end = () => {
    setError(null);
    startTransition(async () => {
      const result = await endBreakGlass(agentId);
      if (result.error) setError(result.error);
    });
  };

  return (
    <section
      className="grid gap-4 rounded-xl border p-5 shadow-sm sm:p-6"
      aria-labelledby="break-glass-heading"
      data-state={grant ? "elevated" : "closed"}
      style={
        grant
          ? {
              borderColor: "var(--warning)",
              background: "color-mix(in srgb, var(--warning) 8%, transparent)",
            }
          : { borderColor: "var(--border)", background: "var(--card)" }
      }
    >
      <div>
        <p
          className="m-0 text-xs font-semibold uppercase tracking-[0.16em]"
          style={{ color: grant ? "var(--warning)" : "var(--muted-foreground)" }}
        >
          Deliberate exception
        </p>
        <h2 id="break-glass-heading" className="mt-2 text-lg font-bold text-foreground">
          Break glass
        </h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          Widen what this agent may reach, for a bounded time, without changing what it is normally
          allowed. The stored scope is untouched — so nothing has to be put back, and nothing can be
          forgotten in the open position.
        </p>
      </div>

      {grant ? (
        <div className="grid gap-3 rounded-lg border border-border bg-background/60 p-4" data-state="live">
          <p className="m-0 text-sm font-semibold" style={{ color: "var(--warning)" }}>
            This agent is elevated for another <Remaining until={grant.expiresAt} />, until{" "}
            {format(grant.expiresAt, "short")}.
          </p>
          <dl className="grid gap-2 text-sm">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Also allowed</dt>
              <dd className="m-0 mt-1 text-foreground">
                {grant.scopes.map((s) => `${s.provider}: ${s.models.join(", ")}`).join(" · ")}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">Reason given</dt>
              <dd className="m-0 mt-1 break-words text-foreground">{grant.reason}</dd>
            </div>
          </dl>
          <p className="m-0 text-xs leading-5 text-muted-foreground">
            It lapses on its own — no job has to run, and none can fail to run. Ending it early
            stops any <em>new</em> visa carrying the elevation; one already issued keeps it until it
            expires, up to {Math.round(visaTtlSeconds / 60)} minutes. To stop this agent entirely
            and immediately, suspend it.
          </p>
          {error ? (
            <p role="alert" className="m-0 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end">
            <button type="button" disabled={pending} onClick={end}>
              {pending ? "Ending…" : "End the elevation"}
            </button>
          </div>
        </div>
      ) : opening ? (
        <form
          className="grid gap-4 rounded-lg border border-border bg-secondary/40 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            take();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
            <label className="grid gap-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Provider</span>
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value as ProviderId)}
                className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Models — comma separated
              </span>
              <input
                value={models}
                onChange={(e) => setModels(e.target.value)}
                placeholder="claude-opus-4-*"
                spellCheck={false}
                className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
              />
            </label>
          </div>

          <label className="grid gap-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Why — required, and recorded
            </span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={BREAK_GLASS_REASON_MAX}
              placeholder="incident 412 — reprocessing the overnight backlog"
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
            />
            <span className="text-right text-[0.68rem] text-muted-foreground">
              {reason.length}/{BREAK_GLASS_REASON_MAX} characters
            </span>
          </label>

          {modelList.length ? (
            <div className="pc-break-glass-scopes" aria-label="Temporary capability to add">
              {modelList.map((model) => <code key={model}>{provider}/{model}</code>)}
            </div>
          ) : null}

          <fieldset className="m-0 grid gap-2 border-0 p-0">
            <legend className="p-0 text-xs uppercase tracking-wide text-muted-foreground">
              For how long
            </legend>
            <div className="flex flex-wrap gap-3">
              {DURATIONS.map((d) => (
                <label key={d.seconds} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="ttl"
                    checked={seconds === d.seconds}
                    onChange={() => setSeconds(d.seconds)}
                  />
                  {d.label}
                </label>
              ))}
            </div>
          </fieldset>

          {preview ? <ImpactPreview change={preview} title="Temporary-scope impact" /> : null}

          {/* Point 1: the thing an operator reaching for this most needs to hear. */}
          <div className="rounded-lg border border-border bg-background p-3">
            <p className="m-0 text-xs font-semibold text-foreground">
              This widens scope. It does not widen anything else.
            </p>
            <p className="m-0 mt-1 text-xs leading-5 text-muted-foreground">
              The kill switch, this agent&rsquo;s suspension, its policy deny rules and its budgets
              all still apply and will still block calls. If a policy rule is what is stopping you,
              change the policy — that is a reviewable act, and this is not a way around it.
            </p>
          </div>

          <p className="m-0 text-xs leading-5 text-muted-foreground">
            Between {Math.round(MIN_BREAK_GLASS_TTL_S / 60)} minute and{" "}
            {Math.round(MAX_BREAK_GLASS_TTL_S / 60)} minutes. It lapses on its own. Taking one
            raises a critical alert and writes an audit row naming you, the scope and the reason.
          </p>

          <div className="pc-break-glass-review">
            <p className="pc-kicker">Elevation review</p>
            <dl>
              <div><dt>Agent</dt><dd><code>{agentId}</code></dd></div>
              <div><dt>Adds</dt><dd>{modelList.length} {provider} model pattern{modelList.length === 1 ? "" : "s"}</dd></div>
              <div><dt>Expires</dt><dd>{format(Date.now() + seconds * 1000, "short")} · lapses automatically</dd></div>
              <div><dt>Still enforced</dt><dd>Policy, budgets, suspension, and kill switch</dd></div>
            </dl>
          </div>

          {error ? (
            <p role="alert" className="m-0 text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="ghost"
              disabled={pending}
              onClick={() => {
                setError(null);
                setOpening(false);
              }}
            >
              Cancel
            </button>
            <button type="submit" disabled={pending || !ready}>
              {pending ? "Opening…" : "Break glass"}
            </button>
          </div>
        </form>
      ) : (
        <>
          {error ? (
            <p role="alert" className="m-0 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="ghost"
              disabled={pending || !active}
              onClick={() => setOpening(true)}
            >
              Break glass…
            </button>
          </div>
          <p className="m-0 text-xs leading-5 text-muted-foreground">
            {active
              ? "Nothing is elevated. Widening scope permanently is the scope editor above; this is for the one-off you do not want to forget to undo."
              : `Only an active agent can be elevated. This one is ${status}.`}
          </p>
        </>
      )}
    </section>
  );
}
