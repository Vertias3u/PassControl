"use client";
// The injection guard's hold on the agent page (Phase 2, owner 2026-10-30): whether
// the agent is tainted, until when, and the owner's Clear. It never says what was
// found; the findings table below it lists the tells, and no text was ever stored.
import { useRouter } from "next/navigation";
import { useState } from "react";

import { clearInjectionTaint } from "@/app/dashboard/agents/[id]/injection-actions";
import { DashboardTimestamp } from "@/components/dashboard/DashboardTime";

export type InjectionTaintView = { state: "tainted"; until: string } | { state: "clear" } | { state: "unknown" };


export function InjectionTaintControl({ agentId, taint }: { agentId: string; taint: InjectionTaintView }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await clearInjectionTaint(agentId);
      if (r.error) setError(r.error);
      else router.refresh();
    } catch {
      setError("PassControl could not clear the hold just now. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const held = taint.state === "tainted";
  return (
    <div
      data-taint-state={taint.state}
      className="rounded-xl border p-4 text-sm"
      style={{
        borderColor: held ? "var(--pc-calm, var(--border))" : "var(--border)",
        background: held ? "color-mix(in srgb, var(--pc-calm, transparent) 8%, var(--card))" : "var(--card)",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <p className="m-0 font-medium" style={held ? { color: "var(--pc-calm, inherit)" } : undefined}>
            {taint.state === "tainted" ? (
              <>
                {/* The dashboard's zone switch, never the server's own zone: a time formatted
                    there failed hydration, and Clear stayed dead until React rebuilt the tree. */}
                Holding until <DashboardTimestamp value={taint.until} kind="time" />
              </>
            ) : taint.state === "unknown" ? (
              "The hold could not be checked just now"
            ) : (
              "Not holding anything"
            )}
          </p>
          <p className="m-0 text-xs leading-5 text-muted-foreground">
            {taint.state === "tainted"
              ? "This agent recently read something that looked like a prompt injection. Until then its service writes wait for you, and so do Claude Code's commands, file edits, fetches and MCP tools wherever PassControl's tool hook is installed; reading and model calls go on. Approving one action does not end the hold."
              : taint.state === "unknown"
                ? "Service writes wait for you while it cannot be checked; Claude Code's tools go on, with a warning."
                : "A strong finding in what this agent's tools return makes its service writes wait for you for 30 minutes, and Claude Code's risky tools too wherever PassControl's tool hook is installed."}
          </p>
        </div>
        {held ? (
          <button type="button" onClick={clear} disabled={busy}>
            {busy ? "Clearing…" : "Clear the hold"}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="m-0 mt-2 text-sm" role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
