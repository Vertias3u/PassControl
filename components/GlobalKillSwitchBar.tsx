"use client";
import { useState, useTransition } from "react";
import { setMasterKill } from "@/app/dashboard/actions";
import { CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";

export function GlobalKillSwitchBar({ initialArmed }: { initialArmed: boolean }) {
  const [armed, setArmed] = useState(initialArmed);
  const [showConfirm, setShowConfirm] = useState(false);
  const [pending, start] = useTransition();

  const phase: "disarmed" | "arming" | "armed" = pending ? "arming" : armed ? "armed" : "disarmed";

  const apply = (next: boolean) =>
    start(async () => {
      await setMasterKill(next);
      setArmed(next);
    });

  const CONFIG = {
    disarmed: { color: "var(--success)", Icon: CheckCircle2, label: "DISARMED", desc: "Fleet operational" },
    arming: { color: "var(--warning)", Icon: Loader2, label: "ARMING…", desc: "Suspending fleet" },
    armed: { color: "var(--danger)", Icon: AlertTriangle, label: "ARMED", desc: "All agents suspended" },
  }[phase];
  const { color, Icon, label, desc } = CONFIG;

  return (
    <>
      <div
        className="flex items-center gap-4 rounded-lg border p-4"
        style={{ borderColor: color, background: armed ? "rgba(239,68,68,0.08)" : "var(--card)" }}
      >
        <Icon className={`h-8 w-8 ${phase === "arming" ? "animate-spin" : ""}`} style={{ color }} />
        <div className="flex-1">
          <div className="text-sm font-bold tracking-wide" style={{ color }}>
            Global Kill Switch · {label}
          </div>
          <div className="text-xs text-muted-foreground">
            {desc} — freezes every agent in your fleet and purges cached keys.
          </div>
        </div>
        {phase === "armed" ? (
          <button
            className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-secondary/80"
            onClick={() => apply(false)}
          >
            Disarm
          </button>
        ) : (
          <button
            className="rounded-md px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: "var(--danger)" }}
            disabled={pending}
            onClick={() => setShowConfirm(true)}
          >
            {pending ? "Arming…" : "Engage kill switch"}
          </button>
        )}
      </div>

      {showConfirm && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60"
          onClick={(e) => e.target === e.currentTarget && setShowConfirm(false)}
        >
          <div className="grid w-[440px] max-w-[90vw] gap-4 rounded-lg border border-border bg-card p-6">
            <h2 className="m-0 text-lg font-bold">Arm the kill switch?</h2>
            <p className="m-0 text-sm text-muted-foreground">
              This immediately suspends <strong>every agent in your fleet</strong> and blocks all
              their API calls until you disarm.
            </p>
            <div
              className="rounded-sm border p-3 text-xs font-medium"
              style={{ borderColor: "var(--danger)", background: "rgba(239,68,68,0.1)", color: "var(--danger)" }}
            >
              ⚠ Critical action — all agents stop working the moment you confirm.
            </div>
            <div className="flex justify-end gap-3">
              <button
                className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-secondary/80"
                onClick={() => setShowConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="rounded-md px-3 py-1.5 text-sm font-semibold text-white"
                style={{ background: "var(--danger)" }}
                onClick={() => {
                  setShowConfirm(false);
                  apply(true);
                }}
              >
                Confirm — arm
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
