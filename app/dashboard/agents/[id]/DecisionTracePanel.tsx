"use client";

import { useFormState, useFormStatus } from "react-dom";
import { PROVIDERS, type ProviderId } from "@/lib/providers";
import type { GateStepResult } from "@/lib/gate";
import {
  runDecisionTrace,
  type DecisionTraceActionState,
} from "./trace-action";
import { useDashboardTime } from "@/components/dashboard/DashboardTime";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center justify-center rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity disabled:cursor-wait disabled:opacity-60"
    >
      {pending ? "Evaluating…" : "Run snapshot"}
    </button>
  );
}

function stepPresentation(step: GateStepResult): {
  label: string;
  symbol: string;
  className: string;
} {
  const statusLabel =
    step.status === "fail" ? "FAIL" : step.status === "skipped" ? "SKIPPED" : "PASS";
  if (step.presentation === "warning") {
    return {
      label: `${statusLabel} · WARNING`,
      symbol: "!",
      className: "border-amber-500/40 bg-amber-500/10",
    };
  }
  if (step.status === "fail") {
    return {
      label: "FAIL",
      symbol: "×",
      className: "border-destructive/40 bg-destructive/10",
    };
  }
  if (step.status === "skipped") {
    return {
      label: "SKIPPED",
      symbol: "–",
      className: "border-border bg-secondary/50",
    };
  }
  return {
    label: "PASS",
    symbol: "✓",
    className: "border-primary/30 bg-primary/5",
  };
}

function TraceStep({ step, index }: { step: GateStepResult; index: number }) {
  const presentation = stepPresentation(step);
  return (
    <li className={`grid grid-cols-[2.5rem_1fr] gap-3 rounded-lg border p-3 ${presentation.className}`}>
      <span
        aria-hidden="true"
        className="grid h-8 w-8 place-items-center rounded-full border border-current text-sm font-bold"
      >
        {presentation.symbol}
      </span>
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-xs font-bold tracking-[0.12em] text-muted-foreground">
            {String(index + 1).padStart(2, "0")} · {presentation.label}
          </span>
          <strong className="text-sm capitalize text-foreground">{step.name}</strong>
        </div>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{step.reason}</p>
        {step.rule ? (
          <code className="mt-1 block break-all text-xs text-muted-foreground">{step.rule}</code>
        ) : null}
      </div>
    </li>
  );
}

export function DecisionTracePanel({
  agentId,
  initialProvider,
  initialModel,
}: {
  agentId: string;
  initialProvider?: string;
  initialModel?: string;
}) {
  const { format } = useDashboardTime();
  const action = runDecisionTrace.bind(null, agentId);
  const [state, formAction] = useFormState<DecisionTraceActionState | undefined, FormData>(
    action,
    undefined
  );
  const provider = (PROVIDERS as readonly string[]).includes(initialProvider ?? "")
    ? (initialProvider as ProviderId)
    : PROVIDERS[0];
  const model = initialModel && !initialModel.includes("*") ? initialModel : "";
  const trace = state?.trace;

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            Ordered capability check
          </p>
          <h2 className="mt-2 text-lg font-bold text-foreground">Why would this call pass?</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Simulate the standard chat endpoint with current gateway state. The result is read-only
            and never resolves a provider key.
          </p>
        </div>
        <span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-xs font-semibold text-muted-foreground">
          Read-only · 30/min
        </span>
      </div>

      <form action={formAction} className="mt-5 grid gap-4 md:grid-cols-3" autoComplete="off">
        <label className="grid gap-1.5 text-sm font-semibold text-foreground">
          Provider
          <select
            name="provider"
            defaultValue={provider}
            className="h-10 rounded-lg border border-border bg-background px-3 text-sm font-normal"
          >
            {PROVIDERS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {candidate}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1.5 text-sm font-semibold text-foreground">
          Model
          <input
            name="model"
            required
            maxLength={200}
            defaultValue={model}
            placeholder="gpt-4.1"
            className="h-10 rounded-lg border border-border bg-background px-3 text-sm font-normal"
          />
        </label>
        <label className="grid gap-1.5 text-sm font-semibold text-foreground">
          Policy time (UTC, optional)
          <input
            name="timestamp"
            type="datetime-local"
            className="h-10 rounded-lg border border-border bg-background px-3 text-sm font-normal"
          />
        </label>
        <div className="md:col-span-3">
          <SubmitButton />
        </div>
      </form>

      {state?.error ? (
        <p role="alert" className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      {trace ? (
        <div className="mt-6 border-t border-border pt-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="m-0 text-xs font-bold uppercase tracking-[0.14em] text-muted-foreground">
                Snapshot · {trace.verdict === "allow" ? "ALLOW" : "DENY"}
              </p>
              <p className="mt-2 text-sm leading-6 text-foreground">
                Evaluated {format(trace.evaluated_at)} · policy clock {format(trace.policy_time)}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                This is a point-in-time snapshot, not a standing verdict. Refreshing the page clears it;
                running it again re-reads mutable state.
              </p>
            </div>
            <code className="rounded-md bg-secondary px-2 py-1 text-xs text-muted-foreground">
              {trace.method} /{trace.path.join("/")} · {trace.provider}/{trace.model}
            </code>
          </div>
          {/* Declared, not silently folded in. This snapshot was evaluated
              against the WIDER scope a visa would carry right now, so a reader
              comparing it against the agent's stored scope would otherwise be
              unable to explain the result. */}
          {trace.break_glass ? (
            <p
              className="m-0 mt-4 rounded-lg border p-3 text-xs leading-5"
              style={{
                borderColor: "var(--warning)",
                background: "color-mix(in srgb, var(--warning) 10%, transparent)",
              }}
              data-state="break-glass"
            >
              <strong style={{ color: "var(--warning)" }}>
                Evaluated with a break-glass elevation in force.
              </strong>{" "}
              This agent is temporarily allowed more than its stored scope, until{" "}
              {format(trace.break_glass.expires_at)}. Reason given:{" "}
              {trace.break_glass.reason}
            </p>
          ) : null}
          <ol className="mt-4 grid list-none gap-2 p-0">
            {trace.steps.map((step, index) => (
              <TraceStep key={step.name} step={step} index={index} />
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
