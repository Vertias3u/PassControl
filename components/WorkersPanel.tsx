"use client";

import { useState } from "react";
import { formatCost } from "@/lib/verify/receipt-view";
import type { DelegationListing } from "@/lib/delegation/manage";
import { revokeAllDelegationsAction, revokeDelegationAction } from "@/app/dashboard/agents/[id]/delegation-actions";
import { useHydratedNow } from "@/components/dashboard/useHydratedNow";

const BUTTON =
  "inline-flex items-center justify-center rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-semibold text-foreground transition-opacity hover:bg-muted disabled:cursor-wait disabled:opacity-60";

type Status = "active" | "expired" | "revoked" | "checking";

function statusOf(d: DelegationListing, now: number | null): Status {
  if (d.revoked) return "revoked";
  if (now === null) return "checking";
  return Date.parse(d.expires_at) <= now ? "expired" : "active";
}

const STATUS_LABEL: Record<Status, string> = { checking: "Checking expiry", active: "Active", expired: "Expired", revoked: "Revoked" };
const STATUS_CLASS: Record<Status, string> = {
  checking: "text-muted-foreground",
  active: "text-emerald-700 dark:text-emerald-400",
  expired: "text-muted-foreground",
  revoked: "text-amber-600 dark:text-amber-400",
};

/** "anthropic: claude-haiku-5-5, claude-sonnet-5" per scope entry. */
function scopeText(scope: unknown): string {
  if (!Array.isArray(scope)) return "";
  return scope
    .map((s) => {
      const entry = s as { provider?: unknown; models?: unknown };
      const models = Array.isArray(entry.models) ? entry.models.map(String).join(", ") : "";
      return `${String(entry.provider ?? "")}: ${models}`;
    })
    .join(" · ");
}

const when = (iso: string) => iso.slice(0, 16).replace("T", " ");

/** After a revocation: say whether the gateway applied it at once. */
function Applied({ immediate }: { immediate: boolean }) {
  return immediate ? (
    <p className="text-xs text-muted-foreground">Revoked. Its next call is refused.</p>
  ) : (
    <p className="text-xs text-amber-600 dark:text-amber-400">
      Recorded, but the gateway could not apply it at once: a worker holding a current visa can call until it
      expires (5 minutes by default).
    </p>
  );
}

function RevokeOne({ agentId, jti }: { agentId: string; jti: string }) {
  const [state, setState] = useState<{ busy: boolean; done?: boolean; immediate?: boolean; error?: string }>({ busy: false });
  async function revoke() {
    setState({ busy: true });
    const r = await revokeDelegationAction(agentId, jti);
    setState(r.ok ? { busy: false, done: true, immediate: r.immediate } : { busy: false, error: r.error });
  }
  if (state.done) return <Applied immediate={state.immediate !== false} />;
  return (
    <div className="flex flex-col items-end gap-1 text-right">
      <button type="button" onClick={revoke} disabled={state.busy} data-action="revoke-one" className={BUTTON}>
        {state.busy ? "Revoking…" : "Revoke"}
      </button>
      {state.error ? <p className="text-xs text-red-600 dark:text-red-400">{state.error}</p> : null}
    </div>
  );
}

/**
 * Every delegation issued before now, seen or not. Two steps, because it stops
 * every worker of this agent at once and cannot be undone.
 */
function RevokeAll({ agentId }: { agentId: string }) {
  const [state, setState] = useState<{ step: "idle" | "confirm" | "busy" | "done"; immediate?: boolean; error?: string }>({ step: "idle" });
  async function revoke() {
    setState({ step: "busy" });
    const r = await revokeAllDelegationsAction(agentId);
    setState(r.ok ? { step: "done", immediate: r.immediate } : { step: "idle", error: r.error });
  }
  return (
    <div className="flex max-w-sm flex-col items-start gap-2" data-revoke-all={state.step}>
      {state.step === "done" ? (
        <Applied immediate={state.immediate !== false} />
      ) : state.step === "confirm" || state.step === "busy" ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={revoke} disabled={state.step === "busy"} data-action="revoke-all-confirm" className={`${BUTTON} text-red-700 dark:text-red-400`}>
            {state.step === "busy" ? "Revoking…" : "Yes, revoke them all"}
          </button>
          <button type="button" onClick={() => setState({ step: "idle" })} disabled={state.step === "busy"} className={BUTTON}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" onClick={() => setState({ step: "confirm" })} data-action="revoke-all" className={BUTTON}>
          Revoke all before now
        </button>
      )}
      <p className="text-xs text-muted-foreground">
        Stops every delegation this agent signed until now, including ones a worker has never used. Delegations it
        signs afterwards work as usual.
      </p>
      {state.error ? <p className="text-xs text-red-600 dark:text-red-400">{state.error}</p> : null}
    </div>
  );
}

/**
 * An agent's workers (Bet D): the signed delegations they have used. A delegation is
 * signed offline by the agent, so the gateway learns of one only at its first
 * exchange; the panel says so before it lists anything.
 */
export function WorkersPanel({ agentId, delegations }: { agentId: string; delegations: DelegationListing[] | null }) {
  const now = useHydratedNow();
  return (
    <section className="pc-section rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <h2 className="text-lg font-semibold text-foreground">Workers</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Workers this agent delegated to with the SDK, each with a narrower scope, a spending cap and an expiry. Only
        delegations a worker has used appear here: the agent signs them on its own machine, so PassControl learns of
        one when its worker first asks for a visa. Revoking is permanent and stops the delegation and every
        delegation under it; it is also published on this instance&apos;s signed revocation list.
      </p>
      {delegations === null ? (
        <p className="mt-4 text-sm text-muted-foreground" data-state="unavailable">
          Delegations could not be read. If this database predates migration 0081, apply it and reload.
        </p>
      ) : delegations.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground" data-state="empty">
          No worker has used a delegation from this agent yet.
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {delegations.map((d) => {
            const status = statusOf(d, now);
            return (
              <li key={d.jti} className="rounded-lg border border-border p-4" data-delegation={d.jti} data-delegation-status={status}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">
                      <span className={STATUS_CLASS[status]}>{STATUS_LABEL[status]}</span> ·{" "}
                      <code className="break-all text-xs">{d.jti}</code>
                      {d.depth > 1 && d.parent_jti ? (
                        <span className="text-xs font-normal text-muted-foreground"> · under {d.parent_jti}</span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {scopeText(d.scope)} · cap {formatCost(d.cap_microcents).primary}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Worker key <code title={d.worker_key}>{d.worker_key.slice(0, 12)}…</code> · first used {when(d.first_exchanged_at)} ·
                      expires {when(d.expires_at)} UTC
                    </p>
                  </div>
                  {status === "active" ? <RevokeOne agentId={agentId} jti={d.jti} /> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-4 border-t border-border pt-4">
        <RevokeAll agentId={agentId} />
      </div>
    </section>
  );
}
