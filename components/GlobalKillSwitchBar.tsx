"use client";
import { useState } from "react";
import { observeMasterKill, setMasterKill, type KillObservation } from "@/app/dashboard/actions";
import { CheckCircle2, AlertTriangle, HelpCircle, Loader2, RefreshCw, ShieldOff } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";

export type KillSwitchPhase = "disarmed" | "arming" | "armed" | "disarming" | "checking" | "unknown" | "unconfirmed";
type KillBusy = { kind: "apply"; next: boolean } | { kind: "refresh" } | null;

/**
 * What the bar may claim. A readback is the truth, even when it is not what
 * was asked for. A LOST response is different: the change may have landed, so
 * the last observation is stale and the bar stops asserting it — Session 07
 * saw an arm apply (calls refused) while the bar still read "DISARMED · Fleet
 * operational". Work in progress is named from the intent, not inferred from
 * that stale observation.
 */
export function killSwitchPhase({
  busy,
  tenant,
  lost,
}: {
  busy: KillBusy;
  tenant: boolean | null;
  lost: boolean;
}): KillSwitchPhase {
  if (busy?.kind === "apply") return busy.next ? "arming" : "disarming";
  if (busy?.kind === "refresh") return "checking";
  if (lost) return "unconfirmed";
  if (tenant === null) return "unknown";
  return tenant ? "armed" : "disarmed";
}

export function killSwitchPresentation(phase: KillSwitchPhase, failClosed: boolean) {
  return {
    disarmed: { color: "var(--success)", Icon: CheckCircle2, label: "DISARMED", desc: "Fleet operational" },
    arming: { color: "var(--warning)", Icon: Loader2, label: "ARMING…", desc: "Applying tenant-wide refusal" },
    disarming: { color: "var(--warning)", Icon: Loader2, label: "DISARMING…", desc: "Restoring governed access" },
    checking: { color: "var(--warning)", Icon: Loader2, label: "CHECKING…", desc: "Reading the kill switch" },
    armed: { color: "var(--danger)", Icon: AlertTriangle, label: "ARMED", desc: "New calls are refused tenant-wide" },
    unknown: {
      color: "var(--warning)",
      Icon: HelpCircle,
      label: "STATE UNREADABLE",
      desc: failClosed
        ? "PassControl cannot read the fleet kill switch right now, and refuses every call until it can"
        : "PassControl cannot read the fleet kill switch right now, and lets calls through while it cannot",
    },
    unconfirmed: {
      color: "var(--warning)",
      Icon: HelpCircle,
      label: "NOT CONFIRMED",
      desc: "The last change may or may not have applied, so the state shown before it is no longer known. Refresh to read what the gateway enforces",
    },
  }[phase];
}

/**
 * The fleet kill switch, showing what was OBSERVED rather than what was last
 * asked for (v1 playbook Contract C). Three facts are kept apart: the tenant
 * flag this operator controls, PassControl's platform stop (visible, not
 * theirs to change), and a read that failed. A failed read is never shown as
 * "Fleet operational": it says what the gateway is doing about it, which
 * depends on the deployment's configured posture.
 */
export function GlobalKillSwitchBar({
  initial,
  failClosed,
}: {
  initial: { tenant: boolean | null; platform: boolean | null };
  /** KILL_SWITCH_FAIL_CLOSED on this deployment — how the gateway treats an unreadable read. */
  failClosed: boolean;
}) {
  const [observed, setObserved] = useState(initial);
  const [showConfirm, setShowConfirm] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState<{ requested: boolean; lost: boolean } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // Plain state, not a React transition. On a production build a transition started
  // on /dashboard never commits (router.refresh and a server action's
  // revalidated tree both stay pending — see tests/agent-operating-surface), so
  // state set inside one was never shown: the bar sat on ARMING… after the
  // switch had applied. The readback commits on its own, as
  // AgentSuspendControl's does.
  const [busy, setBusy] = useState<KillBusy>(null);
  const pending = busy !== null;

  const phase = killSwitchPhase({ busy, tenant: observed.tenant, lost: unconfirmed?.lost ?? false });

  const settle = (result: KillObservation) => {
    setObserved({ tenant: result.tenant, platform: result.platform });
    setUnconfirmed(result.confirmed ? null : { requested: result.requested, lost: false });
    setAnnouncement(
      !result.confirmed
        ? "Could not confirm the kill-switch change."
        : result.requested
          ? "Global kill switch armed. New calls for every agent in this tenant are now refused."
          : "Global kill switch disarmed. Eligible agents can make governed calls again."
    );
  };

  // Desired state in; a retry resends the same intent.
  const apply = async (next: boolean) => {
    setBusy({ kind: "apply", next });
    try {
      settle(await setMasterKill(next));
    } catch {
      setUnconfirmed({ requested: next, lost: true });
      setAnnouncement("Could not confirm the kill-switch change.");
    } finally {
      setBusy(null);
    }
  };

  const refresh = async (requested: boolean) => {
    setBusy({ kind: "refresh" });
    try {
      settle(await observeMasterKill(requested));
    } catch {
      // A failed re-read after a lost change leaves it lost; a failed read
      // of an unreadable switch leaves it unreadable. Neither becomes a claim.
      setUnconfirmed((prev) => (prev ? { ...prev, lost: true } : prev));
    } finally {
      setBusy(null);
    }
  };

  const { color, Icon, label, desc } = killSwitchPresentation(phase, failClosed);

  return (
    <>
      <div
        className="pc-kill-switch"
        data-state={phase}
        style={{ borderColor: color, background: phase === "armed" ? "rgba(239,68,68,0.08)" : "var(--card)" }}
      >
        <div className="pc-kill-switch__state">
          <Icon className={pending ? "animate-spin" : ""} style={{ color }} aria-hidden="true" />
          <div>
            <div className="pc-kill-switch__label" style={{ color }}>
              Fleet safety · {label}
            </div>
            <div className="pc-kill-switch__description">
              {desc}. Per-agent suspension is independent and is not changed by this switch.
            </div>
          </div>
        </div>
        {phase === "unknown" || phase === "unconfirmed" ? (
          <button
            className="ghost"
            disabled={pending}
            onClick={() => void refresh(unconfirmed?.requested ?? false)}
            data-control="refresh-kill"
          >
            <RefreshCw aria-hidden="true" /> Refresh status
          </button>
        ) : null}
        {phase === "unconfirmed" || phase === "checking" ? null : phase === "armed" || phase === "disarming" ? (
          <button
            className="ghost"
            disabled={pending}
            onClick={() => void apply(false)}
          >
            <ShieldOff aria-hidden="true" />
            {phase === "disarming" ? "Disarming…" : "Disarm fleet"}
          </button>
        ) : (
          <button
            className="danger"
            disabled={pending}
            onClick={() => setShowConfirm(true)}
          >
            {phase === "arming" ? "Arming…" : "Engage kill switch"}
          </button>
        )}
      </div>

      {observed.platform === true ? (
        <p role="status" className="pc-inline-error" data-kill-layer="platform">
          PassControl has stopped all traffic platform-wide. This switch cannot override it, and disarming it
          will not resume calls until the platform stop is lifted.
        </p>
      ) : null}
      {unconfirmed ? (
        <div role="alert" className="pc-inline-error" data-kill-result={unconfirmed.lost ? "lost" : "unconfirmed"}>
          Could not confirm that the kill switch is {unconfirmed.requested ? "armed" : "disarmed"}
          {unconfirmed.lost ? ": the request may or may not have applied." : "."} Nothing has been undone.{" "}
          <button type="button" className="ghost" disabled={pending} onClick={() => void apply(unconfirmed.requested)}>
            Retry {unconfirmed.requested ? "arm" : "disarm"}
          </button>{" "}
          <button type="button" className="ghost" disabled={pending} onClick={() => void refresh(unconfirmed.requested)}>
            Refresh status
          </button>
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <Dialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        title="Arm the fleet kill switch?"
        description="This is a tenant-wide operational stop, not an individual agent suspension."
      >
          <div className="grid gap-4 p-5 pt-4">
            {/* "Suspends every agent" was the wording here, and it was wrong in the
                way that matters: it names the per-agent control, which this switch
                deliberately does not touch (lib/fleet.ts:729-731 — disarming a
                tenant must never resume an agent somebody suspended on purpose).
                It also contradicted the bar's own description two elements up. */}
            <p className="m-0 text-sm leading-6 text-muted-foreground">
              This immediately blocks new API calls for <strong>every agent in your fleet</strong>,
              until you disarm. It does not change any agent&rsquo;s own suspended or active state,
              so disarming resumes exactly the agents that were running before.
            </p>
            <div className="pc-critical-notice">
              <AlertTriangle aria-hidden="true" />
              <span>
                <strong>New calls stop when this succeeds.</strong>
                Already-running upstream calls cannot be recalled.
              </span>
            </div>
            <div className="flex justify-end gap-3">
              <button
                className="ghost"
                onClick={() => setShowConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="danger"
                onClick={() => {
                  setShowConfirm(false);
                  void apply(true);
                }}
              >
                Confirm — arm
              </button>
            </div>
          </div>
      </Dialog>
    </>
  );
}
