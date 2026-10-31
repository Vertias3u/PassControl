"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { DashboardTimestamp } from "@/components/dashboard/DashboardTime";
import { PauseCircle, PlayCircle, RefreshCw } from "lucide-react";

import { observeAgentControl, setAgentSuspended } from "@/app/dashboard/actions-client";
import type { AgentControlObservation, ControlIntent } from "@/app/dashboard/actions";

/**
 * One suspend/reactivate contract for every surface that offers it (Fleet row,
 * Fleet card, agent header). v1 playbook Contract C:
 *
 *  - The button names the DESIRED state and sends exactly that. A retry resends
 *    the same intent; nothing is ever re-derived by inverting possibly stale
 *    state, so a lost response cannot flip an applied stop back.
 *  - The result is what was OBSERVED afterwards, per layer. A thrown or lost
 *    response is "could not confirm" — it may or may not have applied — never
 *    "the state did not change".
 *  - A stop is never undone optimistically.
 */
export type ControlResult =
  | { phase: "pending"; intent: ControlIntent }
  | { phase: "observed"; intent: ControlIntent; observation: AgentControlObservation; at: string }
  | { phase: "lost"; intent: ControlIntent; at: string };

export function intentFor(status: string): ControlIntent {
  return status === "suspended" ? "active" : "suspended";
}

export async function applyIntent(agentId: string, intent: ControlIntent): Promise<ControlResult> {
  try {
    const observation = await setAgentSuspended(agentId, intent === "suspended");
    return { phase: "observed", intent, observation, at: new Date().toISOString() };
  } catch {
    return { phase: "lost", intent, at: new Date().toISOString() };
  }
}

export async function refreshIntent(agentId: string, intent: ControlIntent): Promise<ControlResult> {
  try {
    const observation = await observeAgentControl(agentId, intent);
    return { phase: "observed", intent, observation, at: new Date().toISOString() };
  } catch {
    return { phase: "lost", intent, at: new Date().toISOString() };
  }
}

function layer(value: AgentControlObservation["database"] | boolean | null, kind: "database" | "flag"): string {
  if (value === null) return "could not be read";
  if (kind === "flag") return value ? "set — calls are refused" : "clear";
  return String(value);
}

/** The outcome line under a control. Renders nothing before the first click. */
export function AgentControlResult({
  result,
  agentName,
  onRetry,
  onRefresh,
}: {
  result: ControlResult | null;
  agentName: string;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  if (!result) return null;
  const name = agentName || "This agent";
  const verb = result.intent === "suspended" ? "suspend" : "reactivate";
  if (result.phase === "pending") {
    return (
      <p className="m-0 text-xs text-muted-foreground" role="status" data-control-result="pending">
        {result.intent === "suspended" ? "Suspending" : "Reactivating"} {name}…
      </p>
    );
  }
  const actions = (
    <span className="inline-flex flex-wrap gap-2">
      <button type="button" className="ghost inline-flex items-center gap-1" onClick={onRetry} data-control="retry">
        <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" /> Retry {verb}
      </button>
      <button type="button" className="ghost" onClick={onRefresh} data-control="refresh">Refresh status</button>
    </span>
  );
  if (result.phase === "lost") {
    return (
      <div className="grid gap-1 text-xs" role="alert" data-control-result="lost">
        <p className="m-0">
          Could not confirm the {verb}: the request may or may not have applied. Nothing has been undone.
        </p>
        {actions}
      </div>
    );
  }
  const { observation } = result;
  if (observation.confirmed) {
    return (
      <p className="m-0 text-xs text-muted-foreground" role="status" data-control-result="confirmed">
        {result.intent === "suspended"
          ? `${name} is suspended — its next request is refused. Calls already sent to the provider are not recalled.`
          : `${name} is active again — its next request is admitted if its access allows it.`}{" "}
        <span className="opacity-75">Checked <DashboardTimestamp value={result.at} kind="time" fallback="" />.</span>
      </p>
    );
  }
  return (
    <div className="grid gap-1 text-xs" role="alert" data-control-result="unconfirmed">
      <p className="m-0">
        Could not confirm the {verb}. Agent status: {layer(observation.database, "database")}; gateway
        suspension flag: {layer(observation.suspensionFlag, "flag")}.
        {observation.requested === "active" && observation.suspensionFlag === true
          ? " Calls are still refused until the flag clears."
          : ""}
      </p>
      {actions}
    </div>
  );
}

/**
 * Self-contained control for the agent header: the button, its outcome, and a
 * re-check of the observed state when the window regains focus. The re-check
 * is a read (observeAgentControl), not a route refresh, so nothing else on the
 * page remounts.
 */
export function AgentSuspendControl({
  agentId,
  agentName,
  status,
}: {
  agentId: string;
  agentName: string;
  status: string;
}) {
  const router = useRouter();
  const [result, setResult] = useState<ControlResult | null>(null);
  const [observedStatus, setObservedStatus] = useState<string | null>(null);
  // An observation only outranks the prop it was made against. Once the server
  // sends a different status (the refresh landed, or another tab reactivated),
  // that newer read wins; otherwise a stale "suspended" would hide an active agent.
  const [observedAgainst, setObservedAgainst] = useState(status);
  const stale = observedAgainst !== status;
  if (stale) {
    setObservedAgainst(status);
    setObservedStatus(null);
  }
  const busy = result?.phase === "pending";
  // The newest OBSERVED status wins over the server prop, which lags until the
  // route refresh lands; otherwise a confirmed suspend would still offer
  // "Suspend agent" for a moment. Keep that observation through pending/lost
  // responses; a lost reply does not undo an observed stop. Revocation wins.
  const effectiveStatus = status === "revoked" || stale ? status : observedStatus ?? status;
  const intent = intentFor(effectiveStatus);

  const acceptResult = (next: ControlResult) => {
    if (next.phase === "observed" && next.observation.database !== null) {
      setObservedStatus(next.observation.database);
    }
    setResult(next);
  };

  const run = async (next: ControlIntent) => {
    setResult({ phase: "pending", intent: next });
    acceptResult(await applyIntent(agentId, next));
    router.refresh();
  };
  const refresh = async (about: ControlIntent) => {
    acceptResult(await refreshIntent(agentId, about));
    router.refresh();
  };

  useEffect(() => {
    if (!result || result.phase === "pending") return;
    const onFocus = () => void refresh(result.intent);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [result]);

  if (effectiveStatus === "revoked") {
    return <p className="m-0 text-xs text-muted-foreground">Revoked agents cannot be reactivated.</p>;
  }
  return (
    <div className="grid max-w-md justify-items-start gap-2" data-agent-control={effectiveStatus}>
      <button
        type="button"
        className={intent === "suspended" ? "danger inline-flex items-center gap-2" : "inline-flex items-center gap-2"}
        disabled={busy}
        aria-busy={busy}
        onClick={() => void run(intent)}
        data-control={intent === "suspended" ? "suspend" : "reactivate"}
      >
        {intent === "suspended" ? <PauseCircle aria-hidden="true" className="h-4 w-4" /> : <PlayCircle aria-hidden="true" className="h-4 w-4" />}
        {busy ? (result.intent === "suspended" ? "Suspending…" : "Reactivating…") : intent === "suspended" ? "Suspend agent" : "Reactivate agent"}
      </button>
      <AgentControlResult
        result={result}
        agentName={agentName}
        onRetry={() => result && result.phase !== "pending" && void run(result.intent)}
        onRefresh={() => result && result.phase !== "pending" && void refresh(result.intent)}
      />
    </div>
  );
}
