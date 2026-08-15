"use client";
import { useState, useTransition } from "react";
import { setMasterKill } from "@/app/dashboard/actions";
import { CheckCircle2, AlertTriangle, Loader2, ShieldOff } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";

export function GlobalKillSwitchBar({ initialArmed }: { initialArmed: boolean }) {
  const [armed, setArmed] = useState(initialArmed);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pending, start] = useTransition();

  const phase: "disarmed" | "arming" | "armed" | "disarming" = pending
    ? armed
      ? "disarming"
      : "arming"
    : armed
      ? "armed"
      : "disarmed";

  const apply = (next: boolean) =>
    start(async () => {
      setError(null);
      try {
        await setMasterKill(next);
        setArmed(next);
        setAnnouncement(
          next
            ? "Global kill switch armed. New calls for every agent in this tenant are now refused."
            : "Global kill switch disarmed. Eligible agents can make governed calls again."
        );
      } catch (cause) {
        setError((cause as Error).message || "The kill-switch state could not be changed.");
        setAnnouncement("The kill-switch state did not change.");
      }
    });

  const CONFIG = {
    disarmed: { color: "var(--success)", Icon: CheckCircle2, label: "DISARMED", desc: "Fleet operational" },
    arming: { color: "var(--warning)", Icon: Loader2, label: "ARMING…", desc: "Applying tenant-wide refusal" },
    disarming: { color: "var(--warning)", Icon: Loader2, label: "DISARMING…", desc: "Restoring governed access" },
    armed: { color: "var(--danger)", Icon: AlertTriangle, label: "ARMED", desc: "New calls are refused tenant-wide" },
  }[phase];
  const { color, Icon, label, desc } = CONFIG;

  return (
    <>
      <div
        className="pc-kill-switch"
        data-state={phase}
        style={{ borderColor: color, background: armed ? "rgba(239,68,68,0.08)" : "var(--card)" }}
      >
        <div className="pc-kill-switch__state">
          <Icon className={pending ? "animate-spin" : ""} style={{ color }} aria-hidden="true" />
          <div>
            <div className="pc-kill-switch__label" style={{ color }}>
              Fleet safety · {label}
            </div>
            <div className="pc-kill-switch__description">
              {desc}. The gateway also purges cached provider credentials.
            </div>
          </div>
        </div>
        {phase === "armed" ? (
          <button
            className="ghost"
            disabled={pending}
            onClick={() => apply(false)}
          >
            <ShieldOff aria-hidden="true" />
            Disarm fleet
          </button>
        ) : (
          <button
            className="danger"
            disabled={pending}
            onClick={() => setShowConfirm(true)}
          >
            {pending ? "Arming…" : "Engage kill switch"}
          </button>
        )}
      </div>

      {error ? (
        <p role="alert" className="pc-inline-error">
          {error}
        </p>
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
            <p className="m-0 text-sm leading-6 text-muted-foreground">
              This immediately suspends <strong>every agent in your fleet</strong> and blocks all
              their API calls until you disarm.
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
                  apply(true);
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
