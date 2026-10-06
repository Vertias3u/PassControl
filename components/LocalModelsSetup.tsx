"use client";
// Settings → Provider credentials: run agents on models served from this
// machine. Rendered only where the operator gate admits local addresses
// (app/dashboard/settings/page.tsx), so hosted Cloud never shows it.
//
// One click stores a `local` credential with no key and Ollama's address, after
// Ollama has answered (connectOllama). Agents then call the `local` provider
// with any model Ollama has; their calls are recorded with tokens and no cost.
import { useState, useTransition } from "react";
import { CheckCircle2, Cpu } from "lucide-react";

import { connectOllama, listLocalModelsForAgents } from "@/app/dashboard/actions-client";

const OLLAMA_ADDRESS = "http://localhost:11434/v1";

type Outcome = { ok: true; text: string; models: string[] } | { ok: false; text: string } | null;

export function LocalModelsSetup({ connected }: { connected: boolean }) {
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [pending, start] = useTransition();

  const run = (work: () => Promise<Exclude<Outcome, null>>) =>
    start(async () => {
      setOutcome(null);
      try {
        setOutcome(await work());
      } catch (error) {
        setOutcome({ ok: false, text: (error as Error).message });
      }
    });

  const connect = () =>
    run(async () => {
      const result = await connectOllama();
      return {
        ok: true,
        models: result.models,
        text: result.alreadyConnected
          ? "Ollama was already connected."
          : "Connected. Agents can now call the local provider.",
      };
    });

  const check = () =>
    run(async () => {
      const result = await listLocalModelsForAgents();
      if (result.state === "ok") return { ok: true, models: result.models, text: "Ollama is answering." };
      return {
        ok: false,
        text:
          result.state === "unreachable"
            ? "Ollama is not answering. Start the Ollama app (or run `ollama serve`)."
            : "Your local server could not be reached.",
      };
    });

  return (
    <div
      className="mb-4 grid gap-3 rounded-xl border border-border bg-card p-4"
      data-panel="local-models"
      data-state={connected ? "connected" : "available"}
    >
      <div className="grid gap-2">
        <strong className="flex items-center gap-2">
          <Cpu aria-hidden="true" className="h-4 w-4" /> Models on this machine
        </strong>
        <span className="text-sm leading-6 text-muted-foreground">
          {connected ? (
            <>
              Ollama is connected at <code>{OLLAMA_ADDRESS}</code>. Give an agent the <code>local</code>{" "}
              provider and any model Ollama has. Calls are recorded with their tokens and no cost, so
              limit these agents with a token budget, not a dollar one.
            </>
          ) : (
            <>
              Running Ollama? Connect it and your agents can use its models through PassControl, with
              the same scopes, budgets and kill switch. No key is needed: it stays on this machine.
            </>
          )}
        </span>
        <div className="flex flex-wrap gap-2">
          {connected ? (
            <button type="button" className="ghost" disabled={pending} onClick={check}>
              {pending ? "Checking…" : "Check Ollama's models"}
            </button>
          ) : (
            <button type="button" disabled={pending} onClick={connect} data-control="use-ollama">
              {pending ? "Connecting…" : "Use Ollama"}
            </button>
          )}
        </div>
        {outcome ? (
          <p
            className={outcome.ok ? "pc-inline-notice is-success" : "pc-inline-notice is-danger"}
            role={outcome.ok ? "status" : "alert"}
            data-result={outcome.ok ? "ok" : "error"}
          >
            {outcome.ok ? <CheckCircle2 aria-hidden="true" /> : null}
            <span>
              {outcome.text}
              {outcome.ok ? (
                outcome.models.length ? (
                  <>
                    {" "}Models: <code data-local-models>{outcome.models.join(", ")}</code>
                  </>
                ) : (
                  <> No models yet. Pull one with <code>ollama pull llama3.2</code>.</>
                )
              ) : null}
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
