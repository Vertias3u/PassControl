"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  Circle,
  Copy,
  KeyRound,
  Radio,
  ReceiptText,
  RefreshCw,
  ShieldAlert,
  ShieldX,
  X,
} from "lucide-react";

import { DirectAgentConnect } from "@/components/DirectAgentConnect";
import { KeyImportOnramp } from "@/components/KeyImportOnramp";
import { PassportIssuanceModal } from "@/components/PassportIssuanceModal";
import { browserClient } from "@/lib/supabase/client";
import type { ProviderId } from "@/lib/providers";
import { buildDirectConnectSetup } from "@/lib/direct-connect-config";
import {
  activationDiagnosis,
  authenticationProofLabel,
  deriveFirstCallActivation,
  type FirstCallActivation,
  type FirstCallAgent,
  type FirstCallRow,
  type RefusalTest,
} from "@/lib/first-call-activation";

const MAX_ACTIVATION_ROWS = 40;
const REFUSAL_POLL_INTERVAL_MS = 4_000;
const REFUSAL_POLL_WINDOW_MS = 10 * 60_000;


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

type StepName = "provider" | "agent" | "call" | "refuse";

// `diagnose` stays in this list even though no step is named after it. It is a
// position, not a label: drop it and indexOf returns -1 at that stage, so every
// earlier step fails both the `<` and `===` branches below and silently regresses
// from complete to grey. The special case underneath only rescues `call`.
// Where the provider call actually goes. Hosted and self-hosted give different
// true answers, so the sentence is a function rather than a literal in the JSX:
// a marked region inside a JSX expression cannot carry its own closing brace.
function callDestinationHint(identityKind: string | undefined): string {
  return identityKind === "passport"
    ? "Use the Passport SDK configuration saved during issuance. The private key signs locally and the provider call goes through this PassControl gateway."
    : "Use the Direct Agent Key configuration saved when the credential was revealed. The provider call goes through this PassControl gateway.";
}

const STEP_ORDER = ["provider", "agent", "call", "diagnose", "refuse", "proven"];

function stepState(current: string, step: StepName) {
  const currentIndex = STEP_ORDER.indexOf(current);
  const stepIndex = STEP_ORDER.indexOf(step);
  if (current === "diagnose" && step === "call") return "attention";
  // `proven` still waits on the server, so step 4 stays current until then.
  if (current === "proven" && step === "refuse") return "current";
  if (stepIndex < currentIndex) return "complete";
  return stepIndex === currentIndex ? "current" : "upcoming";
}

/** Server-side confirmation of the whole-flow milestone (complete_onboarding). */
type Confirmation = "idle" | "confirming" | "confirmed" | "unconfirmed";

export function FirstCallActivation({
  userId,
  providerConfigured,
  refusalTest: initialRefusalTest,
  initiallyHidden,
  agents,
  initialLogs,
  integrations,
  defaultProvider,
  configuredProviders,
  logsAvailable,
}: {
  userId: string;
  providerConfigured: boolean;
  /**
   * The started refusal test, null when none was started, or "unavailable"
   * when the row could not be read — for instance a database without 0072.
   * Unavailable is never read as "not started": the step says it cannot run.
   */
  refusalTest: RefusalTest | null | "unavailable";
  /** Resolved from the tenant-scoped onboarding row before the first paint. */
  initiallyHidden: boolean;
  agents: FirstCallAgent[];
  initialLogs: FirstCallRow[];
  integrations: string[];
  defaultProvider?: ProviderId;
  /** Providers with a stored key; null when that read failed. */
  configuredProviders?: readonly ProviderId[] | null;
  /**
   * Whether the call log this rail reasons over was actually read. REQUIRED.
   *
   * `deriveFirstCallActivation` takes absent rows as proof that no call has been
   * made — correctly, because that is what an empty log means. With the read
   * FAILED it means nothing, and the rail would tell an established operator to
   * make their first call in the middle of a database fault. That is the mirror
   * of the rule `refusalTest` states in lib/first-call-activation.ts: absent
   * evidence must not read as verified, and it must not read as unmet either.
   */
  logsAvailable: boolean;
}) {
  const [logs, setLogs] = useState(initialLogs);
  const [live, setLive] = useState(false);
  const [hidden, setHidden] = useState(initiallyHidden);
  // Which on-ramp, if any, currently has an unrecoverable secret on screen. Each
  // on-ramp is rendered inside a stage branch, so advancing the stage unmounts it
  // and destroys a private key the user cannot be shown again. The on-ramps' own
  // actions already defer revalidation; this covers the other direction — a
  // revalidatePath("/") from any unrelated action elsewhere on the dashboard,
  // which flips providerConfigured or refreshes `agents` underneath us.
  const [revealing, setRevealing] = useState<"provider" | "agent" | null>(null);
  const [refusalTest, setRefusalTest] = useState(initialRefusalTest);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>("idle");
  const [copiedTest, setCopiedTest] = useState(false);
  const [origin, setOrigin] = useState("https://YOUR-PASSCONTROL-HOST");
  useEffect(() => setOrigin(window.location.origin), []);
  const testAvailable = refusalTest !== "unavailable";
  const derived = useMemo(
    () => deriveFirstCallActivation({
      providerConfigured,
      agents,
      logs,
      refusalTest: refusalTest === "unavailable" ? null : refusalTest,
    }),
    [providerConfigured, agents, logs, refusalTest]
  );
  // Safe to pin by stage name alone: both held variants are field-free, so there
  // is no captured row or agent id that could go stale while the hold is active.
  const state: FirstCallActivation = revealing ? { stage: revealing } : derived;

  const persistProgress = async (operation: "dismiss" | "complete") => {
    // Neither RPC accepts a user id. The database binds the row to auth.uid(),
    // and completion independently re-checks ordered call/control evidence.
    const { data, error } = operation === "dismiss"
      ? await browserClient().rpc("dismiss_onboarding")
      : await browserClient().rpc("complete_onboarding");
    return !error && data === true;
  };

  useEffect(() => {
    setLogs(initialLogs);
  }, [initialLogs]);

  useEffect(() => {
    setHidden(initiallyHidden);
  }, [initiallyHidden]);

  useEffect(() => {
    setRefusalTest(initialRefusalTest);
  }, [initialRefusalTest]);

  // The browser's `proven` is a copy of the rule, read from a bounded window.
  // Completion is what complete_onboarding() re-derives from the authoritative
  // history, so the guide shows "complete" only when the server agrees, and
  // says so plainly when it does not (a failed read must not complete it).
  const confirm = async () => {
    setConfirmation("confirming");
    setConfirmation((await persistProgress("complete")) ? "confirmed" : "unconfirmed");
  };
  useEffect(() => {
    if (state.stage !== "proven" || initiallyHidden || confirmation !== "idle") return;
    void confirm();
    // The current render keeps the proof visible. The durable timestamp hides
    // it on later loads and on other devices.
  }, [initiallyHidden, state.stage, confirmation, userId]);

  // While a refusal test is waiting, read that one agent's rows since the test
  // started on a short, bounded interval. Realtime is the fast path, but a
  // missed or unsubscribed channel must not leave the operator watching a
  // "waiting" step after the refusal was already recorded. Bounded in time and
  // rows; stops the moment the stage moves on.
  const waitingAgentId = state.stage === "refuse" && state.test ? state.test.agentId : null;
  const waitingSince = state.stage === "refuse" && state.test ? state.test.startedAt : null;
  useEffect(() => {
    if (!waitingAgentId || !waitingSince) return;
    let cancelled = false;
    const deadline = Date.now() + REFUSAL_POLL_WINDOW_MS;
    const poll = async () => {
      const { data, error } = await browserClient()
        .from("agent_logs")
        .select("id, agent_id, provider, model, status, receipt, auth_method, agent_access_key_id, created_at")
        .eq("agent_id", waitingAgentId)
        .gte("created_at", waitingSince)
        .order("created_at", { ascending: false })
        .limit(10);
      if (cancelled || error || !Array.isArray(data) || data.length === 0) return;
      const fresh = data as FirstCallRow[];
      setLogs((current) => {
        const seen = new Set(current.map((row) => row.id));
        const added = fresh.filter((row) => !seen.has(row.id));
        return added.length ? [...added, ...current].slice(0, MAX_ACTIVATION_ROWS) : current;
      });
    };
    const timer = window.setInterval(() => {
      if (Date.now() > deadline) {
        window.clearInterval(timer);
        return;
      }
      void poll();
    }, REFUSAL_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [waitingAgentId, waitingSince]);

  const startRefusalTest = async (agentId: string) => {
    setStarting(true);
    setStartError(null);
    try {
      // The RPC binds the row to auth.uid() and refuses an agent this user
      // does not own or that is revoked; it returns null for either.
      const { data, error } = await browserClient().rpc("start_onboarding_refusal_test", { p_agent_id: agentId });
      if (error || typeof data !== "string") {
        setStartError("PassControl could not start the refusal test. Try again.");
        return;
      }
      setConfirmation("idle");
      setRefusalTest({ agentId, startedAt: data });
    } finally {
      setStarting(false);
    }
  };

  const copyTest = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedTest(true);
      window.setTimeout(() => setCopiedTest(false), 1800);
    } catch {
      // Selecting the text by hand still works.
    }
  };

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

  const dismiss = async () => {
    // Keep the guide visible if persistence fails. Pretending a database-backed
    // preference was saved would recreate the resurrection bug on next load.
    if (await persistProgress("dismiss")) setHidden(true);
  };

  // The row is resolved on the server, avoiding a hydration flash. Dismissal is
  // a durable preference, so it remains respected even if reality later moves
  // back to an earlier computed step.
  // Not a stage, and not an empty rail. The activation guide is an onboarding
  // aid; when the evidence it reads is unavailable the honest thing is to say
  // nothing rather than to guess a stage — `deriveFirstCallActivation` would
  // otherwise read the absent rows as proof no call has been made and tell an
  // established operator to make their first one, mid-outage. The operations
  // appendix on the same page reports the failed read, so the fact is not lost.
  //
  // BELOW the hooks, beside the `hidden` guard, and that placement is load-
  // bearing: an early return above `useState` changes the hook count between
  // renders the moment this prop flips, which React tears the tree down for.
  if (!logsAvailable || hidden) return null;

  if (state.stage === "proven" && confirmation === "confirmed") {
    return (
      <section
        className="pc-first-call pc-first-call--proof"
        aria-label="First governed call and refusal verified"
        data-stage="complete"
        data-live={live ? "connected" : "connecting"}
      >
        <div className="pc-first-call__complete" data-activation-state="complete">
          <div className="pc-first-call__complete-copy">
            <span><Check aria-hidden="true" /> {authenticationProofLabel(state.row.auth_method)}</span>
            <strong>
              {state.agentName || "The agent"} reached {state.row.provider ?? "the provider"}
              {state.row.model ? ` / ${state.row.model}` : ""}, then was refused{" "}
              {state.refusal.model ?? "a model"} outside its access.
            </strong>
            <small data-refusal-state="recorded">
              <ShieldX aria-hidden="true" /> Refused as <code>blocked_scope</code> before the provider saw it — no provider call, no cost.
            </small>
            <small data-receipt-state={state.receiptRecorded ? "recorded" : "missing"}>
              <ReceiptText aria-hidden="true" />
              {state.receiptRecorded
                ? "Signed receipt attached to the allowed call."
                : "Allowed call stored; no receipt is attached, so it is not receipt-verified."}
            </small>
          </div>
          <nav className="pc-first-call__controls" aria-label="Next steps">
            <Link href={`/dashboard/agents/${state.agentId}`} data-control="agent">Operate {state.agentName || "this agent"}</Link>
            <Link href="/dashboard#activity" data-control="receipt">Inspect stored calls</Link>
            <DirectAgentConnect triggerLabel="Connect another worker" initialProvider={defaultProvider} configuredProviders={configuredProviders} />
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
            Configuration is not proof. This guide completes when PassControl has stored one allowed call and one
            deliberate refusal from the same worker.
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
          ["refuse", "4", "Prove a refusal", "Same worker, outside its access"],
        ].map(([step, number, label, detail]) => {
          const status = stepState(state.stage, step as StepName);
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
                <p data-activation-services-note>
                  This guide walks through a model call. If your agents will only call GitHub or Telegram, add the
                  token under <a href="/dashboard/settings#services">Settings, Services</a>, create the agent with
                  &ldquo;Only GitHub or Telegram&rdquo;, and dismiss this guide.
                </p>
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
              <DirectAgentConnect triggerLabel="Direct Agent Key" initialProvider={defaultProvider} configuredProviders={configuredProviders} />
              <PassportIssuanceModal
                userId={userId}
                integrations={integrations}
                onRevealChange={(on) => setRevealing(on ? "agent" : null)}
              />
            </div>
          </div>
        ) : null}

        {state.stage === "call" ? (
          <div
            className="pc-first-call__action"
            data-activation-state="call"
            data-connected={state.connected ? "probe" : "none"}
          >
            <div>
              <strong>Run one request from {state.agentName || "the agent"}.</strong>
              {/* A probe already cleared the gate, so the wiring is not in doubt
                  — saying "check the base URL" here would send the operator to
                  debug the one thing already proven. The probe is named, not
                  hidden: it is a real recorded call, just not an inference. */}
              {state.connected ? (
                <p>
                  This agent&rsquo;s SDK has already reached PassControl — a capability probe
                  (model listing) cleared the gate, so the base URL and credential are correct.
                  What is outstanding is one actual model call.
                </p>
              ) : (
                <p>
                  {callDestinationHint(
                    agents.find((agent) => agent.id === state.agentId)?.identityKind
                  )}
                </p>
              )}
              <small>
                {state.connected
                  ? "Capability probes are recorded in full on the departures board, but they do not count as agent activity."
                  : "If nothing appears, check the PassControl base URL and agent credential. Authentication failures happen before a tenant call row can be written."}
              </small>
            </div>
            <Link href={`/dashboard/agents/${state.agentId}#agent-identity`} className="ghost">
              Open agent identity <ArrowRight aria-hidden="true" />
            </Link>
          </div>
        ) : null}

        {state.stage === "refuse" ? (
          <div className="pc-first-call__action" data-activation-state="refuse" data-refusal-test={state.test ? "started" : "not-started"}>
            <div>
              <strong>
                {state.agentName || "The agent"} reached {state.row.provider ?? "the provider"}
                {state.row.model ? ` / ${state.row.model}` : ""}. Now prove PassControl can say no.
              </strong>
              {!testAvailable ? (
                <p data-refusal-test-state="unavailable">
                  The refusal step cannot run until this deployment&rsquo;s database is updated. Everything
                  above is still recorded; you can dismiss this guide.
                </p>
              ) : state.testModel === null ? (
                <p data-refusal-test-state="needs-narrower-access">
                  This agent&rsquo;s access allows every model, so there is nothing for PassControl to refuse.{" "}
                  <Link href={`/dashboard/agents/${state.agentId}#agent-policy`}>Narrow its access</Link> first, then come back.
                </p>
              ) : !state.test ? (
                <>
                  <p>
                    An allowed call proves the path is open. The other half is a refusal: start the test, then
                    have this same worker request <code>{state.testModel}</code>, a model outside its access.
                    PassControl refuses it as <code>blocked_scope</code> before the provider sees it, so it costs
                    nothing.
                  </p>
                  <small>
                    Only a refusal from this worker after you start counts — not an older one, another
                    agent&rsquo;s, or a kill switch.
                  </small>
                </>
              ) : (
                <>
                  <p data-refusal-test-state="waiting">
                    Waiting for {state.agentName || "the agent"} to request <code>{state.testModel}</code>…
                  </p>
                  {agents.find((agent) => agent.id === state.agentId)?.identityKind === "direct_key" && state.provider ? (
                    <>
                      <pre className="overflow-x-auto rounded-xl border border-border bg-black/30 p-4 text-xs leading-6 text-foreground">
                        {buildDirectConnectSetup({ origin, provider: state.provider, key: null, model: state.testModel }).smokeCommand}
                      </pre>
                      <button
                        type="button"
                        className="ghost inline-flex items-center gap-2 justify-self-start"
                        onClick={() => copyTest(buildDirectConnectSetup({ origin, provider: state.provider!, key: null, model: state.testModel! }).smokeCommand)}
                      >
                        {copiedTest ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                        {copiedTest ? "Copied" : "Copy refusal test"}
                      </button>
                      <small>
                        Run it where the worker&rsquo;s configuration is loaded, so it uses the same Direct Agent Key.
                      </small>
                    </>
                  ) : (
                    <small>Change the model this agent requests to <code>{state.testModel}</code> for one call.</small>
                  )}
                  <small>
                    A <code>401 invalid_credential</code> means the key itself was not accepted, and nothing is
                    recorded for it — that is not this test.
                  </small>
                </>
              )}
              {startError ? <p role="alert" className="pc-inline-error">{startError}</p> : null}
            </div>
            <nav className="pc-first-call__controls" aria-label="Refusal test">
              {testAvailable && state.testModel !== null ? (
                <button type="button" className="inline-flex items-center gap-2" onClick={() => startRefusalTest(state.agentId)} disabled={starting} data-control="start-refusal-test">
                  <ShieldX aria-hidden="true" /> {starting ? "Starting…" : state.test ? "Restart the test" : "Start the refusal test"}
                </button>
              ) : null}
              <Link href={`/dashboard/agents/${state.agentId}#agent-setup`} data-control="setup">Worker setup</Link>
            </nav>
            <button
              type="button"
              className="pc-first-call__dismiss"
              onClick={dismiss}
              aria-label="Dismiss the first-call guide"
            >
              <X aria-hidden="true" /> Dismiss
            </button>
          </div>
        ) : null}

        {state.stage === "proven" ? (
          <div className="pc-first-call__action" data-activation-state="proven" data-confirmation={confirmation}>
            <div>
              <strong>
                {state.agentName || "The agent"} was refused {state.refusal.model ?? "a model"} outside its access.
              </strong>
              {confirmation === "unconfirmed" ? (
                <p>PassControl could not confirm this from its stored history yet, so the guide is not marked complete.</p>
              ) : (
                <p>Confirming from PassControl&rsquo;s stored history…</p>
              )}
            </div>
            {confirmation === "unconfirmed" ? (
              <nav className="pc-first-call__controls" aria-label="Confirmation">
                <button type="button" className="inline-flex items-center gap-2" onClick={() => void confirm()} data-control="retry-confirmation">
                  <RefreshCw aria-hidden="true" /> Try again
                </button>
              </nav>
            ) : null}
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
