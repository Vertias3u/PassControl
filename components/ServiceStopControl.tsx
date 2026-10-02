"use client";
// One service's stop for the whole workspace ("stop all GitHub access, keep
// Claude"), any-API phase 2.
//
// Shows what was OBSERVED, as the fleet kill switch does: a read-back after
// every change, "could not confirm" when it disagrees or is lost, and an
// unreadable state described by what the gateway does about it, which depends
// on this deployment's configured posture. Stopping asks once; resuming does
// not, because a stop that is slow to reach is worse than one that is easy.
import { useState } from "react";
import { AlertTriangle, CheckCircle2, HelpCircle, Loader2, PauseCircle, PlayCircle, RefreshCw } from "lucide-react";
import {
  observeServiceKillAction,
  setServiceKill,
  type ServiceKillObservation,
} from "@/app/dashboard/service-actions";

export type ServiceStopPhase = "running" | "stopped" | "stopping" | "resuming" | "checking" | "unknown" | "unconfirmed";

export function serviceStopPhase({
  busy,
  stopped,
  unconfirmed,
}: {
  busy: { kind: "apply"; next: boolean } | { kind: "refresh" } | null;
  stopped: boolean | null;
  unconfirmed: boolean;
}): ServiceStopPhase {
  if (busy?.kind === "apply") return busy.next ? "stopping" : "resuming";
  if (busy?.kind === "refresh") return "checking";
  if (unconfirmed) return "unconfirmed";
  if (stopped === null) return "unknown";
  return stopped ? "stopped" : "running";
}

export function ServiceStopControl({
  service,
  serviceLabel,
  initialStopped,
  failClosed,
}: {
  service: string;
  serviceLabel: string;
  initialStopped: boolean | null;
  /** KILL_SWITCH_FAIL_CLOSED on this deployment: how an unreadable stop is treated. */
  failClosed: boolean;
}) {
  const [stopped, setStopped] = useState<boolean | null>(initialStopped);
  const [busy, setBusy] = useState<{ kind: "apply"; next: boolean } | { kind: "refresh" } | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<{ requested: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phase = serviceStopPhase({ busy, stopped, unconfirmed: unconfirmed !== null });

  const settle = (result: ServiceKillObservation) => {
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    setStopped(result.armed);
    setUnconfirmed(result.confirmed ? null : { requested: result.requested });
  };

  const apply = async (next: boolean) => {
    setConfirming(false);
    setBusy({ kind: "apply", next });
    try {
      settle(await setServiceKill(service, next));
    } catch {
      setUnconfirmed({ requested: next });
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy({ kind: "refresh" });
    try {
      settle(await observeServiceKillAction(service, unconfirmed?.requested ?? stopped === true));
    } catch {
      // Still unconfirmed; the operator can try again.
    } finally {
      setBusy(null);
    }
  };

  const view = {
    running: { color: "var(--success)", Icon: CheckCircle2, label: "RUNNING", desc: `Agents' ${serviceLabel} calls are checked against their rules` },
    stopped: { color: "var(--danger)", Icon: AlertTriangle, label: "STOPPED", desc: `Every ${serviceLabel} call from every agent in this workspace is refused. Model calls are not affected` },
    stopping: { color: "var(--warning)", Icon: Loader2, label: "STOPPING…", desc: `Refusing ${serviceLabel} calls` },
    resuming: { color: "var(--warning)", Icon: Loader2, label: "RESUMING…", desc: `Restoring ${serviceLabel} access` },
    checking: { color: "var(--warning)", Icon: Loader2, label: "CHECKING…", desc: "Reading the stop switch" },
    unknown: {
      color: "var(--warning)",
      Icon: HelpCircle,
      label: "STATE UNREADABLE",
      desc: failClosed
        ? `PassControl cannot read this stop right now, and refuses every call until it can`
        : `PassControl cannot read this stop right now, and lets ${serviceLabel} calls through their rules while it cannot`,
    },
    unconfirmed: {
      color: "var(--warning)",
      Icon: HelpCircle,
      label: "NOT CONFIRMED",
      desc: "The last change may or may not have applied. Refresh to read what the gateway enforces",
    },
  }[phase];
  const pending = busy !== null;
  const Icon = view.Icon;

  return (
    <div
      className="pc-kill-switch"
      data-service-stop={phase}
      data-service={service}
      style={{ borderColor: view.color, background: phase === "stopped" ? "rgba(239,68,68,0.08)" : "var(--card)" }}
    >
      <div className="pc-kill-switch__state">
        <Icon className={pending ? "animate-spin" : ""} style={{ color: view.color }} aria-hidden="true" />
        <div>
          <div className="pc-kill-switch__label" style={{ color: view.color }}>
            {serviceLabel} · {view.label}
          </div>
          <div className="pc-kill-switch__description" role="status">
            {view.desc}.
          </div>
          {error ? (
            <p className="pc-inline-notice is-danger" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {phase === "unknown" || phase === "unconfirmed" ? (
          <button type="button" className="ghost" disabled={pending} onClick={() => void refresh()} data-action="refresh-service-stop">
            <RefreshCw aria-hidden="true" /> Refresh status
          </button>
        ) : null}
        {phase === "stopped" ? (
          <button type="button" className="ghost" disabled={pending} onClick={() => void apply(false)} data-action="resume-service">
            <PlayCircle aria-hidden="true" /> Resume {serviceLabel} calls
          </button>
        ) : phase === "running" || phase === "unknown" ? (
          confirming ? (
            <span className="flex flex-wrap items-center gap-2" data-confirm="stop-service">
              <span className="text-sm">Refuse every {serviceLabel} call until you resume?</span>
              <button type="button" className="is-danger" disabled={pending} onClick={() => void apply(true)} data-action="confirm-stop-service">
                Stop {serviceLabel} calls
              </button>
              <button type="button" className="ghost" disabled={pending} onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className="ghost" disabled={pending} onClick={() => setConfirming(true)} data-action="stop-service">
              <PauseCircle aria-hidden="true" /> Stop all {serviceLabel} calls
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}
