"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  Circle,
  KeyRound,
  Radio,
  ReceiptText,
  ShieldAlert,
  X,
} from "lucide-react";

import { DirectAgentConnect } from "@/components/DirectAgentConnect";
import { KeyImportOnramp } from "@/components/KeyImportOnramp";
import { PassportIssuanceModal } from "@/components/PassportIssuanceModal";
import { browserClient } from "@/lib/supabase/client";
import type { ProviderId } from "@/lib/providers";
import {
  activationDiagnosis,
  authenticationProofLabel,
  deriveFirstCallActivation,
  type FirstCallActivation,
  type FirstCallAgent,
  type FirstCallRow,
} from "@/lib/first-call-activation";

const MAX_ACTIVATION_ROWS = 40;

function destinationFor(action: ReturnType<typeof activationDiagnosis>["action"], agentId: string) {
  switch (action) {
    case "settings":
      return "/dashboard/settings#provider-credentials";
    case "policy":
      return `/dashboard/agents/${agentId}#agent-policy`;
    case "fleet":
      return "/dashboard#fleet";
    case "activity":
      return "/dashboard#activity";
  }
}

function stepState(current: string, step: "provider" | "agent" | "call") {
  const order = ["provider", "agent", "call", "diagnose", "complete"];
  const currentIndex = order.indexOf(current);
  const stepIndex = order.indexOf(step);
  if (current === "diagnose" && step === "call") return "attention";
  if (current === "complete" || stepIndex < currentIndex) return "complete";
  return stepIndex === currentIndex ? "current" : "upcoming";
}

export function FirstCallActivation({
  userId,
  providerConfigured,
  agents,
  initialLogs,
  integrations,
  defaultProvider,
}: {
  userId: string;
  providerConfigured: boolean;
  agents: FirstCallAgent[];
  initialLogs: FirstCallRow[];
  integrations: string[];
  defaultProvider?: ProviderId;
}) {
  const [logs, setLogs] = useState(initialLogs);
  const [live, setLive] = useState(false);
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  // Which on-ramp, if any, currently has an unrecoverable secret on screen. Each
  // on-ramp is rendered inside a stage branch, so advancing the stage unmounts it
  // and destroys a private key the user cannot be shown again. The on-ramps' own
  // actions already defer revalidation; this covers the other direction — a
  // revalidatePath("/") from any unrelated action elsewhere on the dashboard,
  // which flips providerConfigured or refreshes `agents` underneath us.
  const [revealing, setRevealing] = useState<"provider" | "agent" | null>(null);
  const derived = useMemo(
    () => deriveFirstCallActivation({ providerConfigured, agents, logs }),
    [providerConfigured, agents, logs]
  );
  // Safe to pin by stage name alone: both held variants are field-free, so there
  // is no captured row or agent id that could go stale while the hold is active.
  const state: FirstCallActivation = revealing ? { stage: revealing } : derived;

  useEffect(() => {
    setLogs(initialLogs);
  }, [initialLogs]);

  useEffect(() => {
    if (state.stage !== "complete") return;
    try {
      setDismissed(localStorage.getItem(`passcontrol:first-call:${userId}:dismissed`) === "true");
    } catch {
      setDismissed(false);
    }
  }, [state.stage, userId]);

  useEffect(() => {
    const supabase = browserClient();
    const channel = supabase
      .channel(`first-call-activation:${userId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "agent_logs", filter: `user_id=eq.${userId}` },
        (payload) => {
          const row = payload.new as FirstCallRow;
          if (!row?.id) return;
          setLogs((current) => [row, ...current.filter((item) => item.id !== row.id)].slice(0, MAX_ACTIVATION_ROWS));
        }
      )
      .subscribe((status) => setLive(status === "SUBSCRIBED"));

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  const dismiss = () => {
    try {
      localStorage.setItem(`passcontrol:first-call:${userId}:dismissed`, "true");
    } catch {
      // A blocked local preference must not make the completion control fail.
    }
    setDismissed(true);
  };

  // A completed guide may have been dismissed in localStorage. Do not render it
  // once on the server and then make it disappear after hydration; wait until
  // the local-only preference has been resolved. Incomplete setup remains
  // server-visible immediately because it has no dismissal state.
  if (state.stage === "complete" && dismissed !== false) return null;

  if (state.stage === "complete") {
    return (
      <section
        className="pc-first-call pc-first-call--proof"
        aria-label="First governed call verified"
        data-stage="complete"
        data-live={live ? "connected" : "connecting"}
      >
        <div className="pc-first-call__complete" data-activation-state="complete">
          <div className="pc-first-call__complete-copy">
            <span><Check aria-hidden="true" /> {authenticationProofLabel(state.row.auth_method)}</span>
            <strong>{state.agentName || "The agent"} reached {state.row.provider ?? "the provider"}{state.row.model ? ` / ${state.row.model}` : ""}.</strong>
            <small data-receipt-state={state.receiptRecorded ? "recorded" : "missing"}>
              <ReceiptText aria-hidden="true" />
              {state.receiptRecorded
                ? "Signed receipt attached to the stored call."
                : "Stored call found; no receipt is attached, so it is not receipt-verified."}
            </small>
          </div>
          <nav className="pc-first-call__controls" aria-label="First-call proof controls">
            <Link href="/dashboard#activity" data-control="receipt">Inspect stored call</Link>
            <Link href="/dashboard#fleet" data-control="suspend">Suspend agent</Link>
            <Link href="/dashboard#fleet" data-control="budget">Set budget</Link>
          </nav>
          <button type="button" className="pc-first-call__dismiss" onClick={dismiss} aria-label="Dismiss completed first-call proof">
            <X aria-hidden="true" /> Dismiss
          </button>
        </div>
      </section>
    );
  }

  const diagnosis = state.stage === "diagnose" ? activationDiagnosis(state.row) : null;

  return (
    <section
      className="pc-first-call"
      aria-labelledby="first-call-heading"
      data-stage={state.stage}
      data-live={live ? "connected" : "connecting"}
    >
      <div className="pc-first-call__header">
        <div>
          <p className="pc-first-call__eyebrow">First governed call</p>
          <h2 id="first-call-heading">
            Get one agent through the boundary.
          </h2>
          <p>
            Configuration is not proof. This guide completes only after PassControl stores the call result in the tenant audit log.
          </p>
        </div>
        <span className={live ? "is-live" : "is-connecting"} role="status">
          <Radio aria-hidden="true" /> {live ? "Watching call records" : "Connecting to call records"}
        </span>
      </div>

      <ol className="pc-first-call__steps" aria-label="First-call activation progress">
        {[
          ["provider", "1", "Provider key", "Stored server-side"],
          ["agent", "2", "Agent identity", "Scope and budget attached"],
          ["call", "3", "Governed call", "Stored result proves the path"],
        ].map(([step, number, label, detail]) => {
          const status = stepState(state.stage, step as "provider" | "agent" | "call");
          return (
            <li key={step} data-state={status}>
              <span className="pc-first-call__step-mark">
                {status === "complete" ? <Check aria-hidden="true" /> : status === "attention" ? <ShieldAlert aria-hidden="true" /> : <Circle aria-hidden="true" />}
                <b>{number}</b>
              </span>
              <span><strong>{label}</strong><small>{detail}</small></span>
            </li>
          );
        })}
      </ol>

      <div className="pc-first-call__body" aria-live="polite">
        {state.stage === "provider" ? (
          <div data-activation-state="provider">
            <div className="pc-first-call__message">
              <KeyRound aria-hidden="true" />
              <div>
                <strong>Start with the provider credential.</strong>
                <p>PassControl stores it in Vault and uses it only after an agent call clears the gate.</p>
              </div>
            </div>
            <KeyImportOnramp
              userId={userId}
              integrations={integrations}
              onRevealChange={(on) => setRevealing(on ? "provider" : null)}
            />
          </div>
        ) : null}

        {state.stage === "agent" ? (
          <div className="pc-first-call__action" data-activation-state="agent">
            <div>
              <strong>Create the first agent identity.</strong>
              <p>Use a Direct Agent Key for static-key tools, or a Passport for code that can sign challenges with the PassControl SDK.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <DirectAgentConnect triggerLabel="Direct Agent Key" initialProvider={defaultProvider} />
              <PassportIssuanceModal
                userId={userId}
                integrations={integrations}
                onRevealChange={(on) => setRevealing(on ? "agent" : null)}
              />
            </div>
          </div>
        ) : null}

        {state.stage === "call" ? (
          <div className="pc-first-call__action" data-activation-state="call">
            <div>
              <strong>Run one request from {state.agentName || "the agent"}.</strong>
              <p>
                {state.stage === "call" && agents.find((agent) => agent.id === state.agentId)?.identityKind === "passport"
                  ? "Use the Passport SDK configuration saved during issuance. The private key signs locally and the provider call goes through PassControl Cloud."
                  : "Use the Direct Agent Key configuration saved when the credential was revealed. The provider call goes through PassControl Cloud."}
              </p>
              <small>If nothing appears, check the PassControl base URL and agent credential. Authentication failures happen before a tenant call row can be written.</small>
            </div>
            <Link href={`/dashboard/agents/${state.agentId}#agent-identity`} className="ghost">
              Open agent identity <ArrowRight aria-hidden="true" />
            </Link>
          </div>
        ) : null}

        {state.stage === "diagnose" && diagnosis ? (
          <div className="pc-first-call__diagnosis" data-activation-state="diagnose">
            <ShieldAlert aria-hidden="true" />
            <div>
              <span>Recorded as <code>{state.row.status}</code></span>
              <strong>{diagnosis.title}</strong>
              <p>{diagnosis.detail}</p>
              <div className="pc-first-call__links">
                <Link href={destinationFor(diagnosis.action, state.agentId)}>
                  Fix this condition <ArrowRight aria-hidden="true" />
                </Link>
                <Link href="/dashboard#activity">Inspect stored call</Link>
              </div>
            </div>
          </div>
        ) : null}

      </div>
    </section>
  );
}
