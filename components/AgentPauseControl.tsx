"use client";
// The soft pause on the agent page (1.6.0, L4): where the agent is against its
// owner's pause line, and the one control a pause needs, "let it go on for an hour".
//
// A pause is the product doing what the owner asked, not an incident, so it is drawn
// in the calm tone (`--pc-calm`, landed by Codex's C2; muted until then), never red.
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { SwitchModel } from "@/lib/cheaper-model";

import { setAgentPauseLift } from "@/app/dashboard/agents/[id]/pause-actions";

export interface AgentPauseControlProps {
  agentId: string;
  percent: number;
  /** The limit past the line, in words, e.g. "today's spend is $16.40 of $20.00 (82%)"; null below the line. */
  reached: string | null;
  liftedUntil: string | null;
  liftUnknown: boolean;
  /** The provider/model configured to carry on at the line; null for pause-only agents. */
  switchTo?: SwitchModel | null;
}

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function AgentPauseControl({ agentId, percent, reached, liftedUntil, liftUnknown, switchTo }: AgentPauseControlProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const act = async (lift: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await setAgentPauseLift(agentId, lift);
      if (r.error) setError(r.error);
      else router.refresh();
    } catch {
      setError("PassControl could not change the pause just now. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const state = !reached ? "below" : liftedUntil ? "lifted" : switchTo ? "switched" : "paused";
  const showLift = state === "paused" || state === "switched";
  return (
    <section
      id="agent-pause"
      data-pause-state={state}
      className="scroll-mt-40 rounded-xl border p-4 text-sm"
      style={{
        borderColor: showLift ? "var(--pc-calm, var(--border))" : "var(--border)",
        background: showLift ? "color-mix(in srgb, var(--pc-calm, transparent) 8%, var(--card))" : "var(--card)",
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <p className="m-0 font-medium" style={showLift ? { color: "var(--pc-calm, inherit)" } : undefined}>
            {state === "switched"
              ? `${switchTo!.provider} carries on with ${switchTo!.model} past its ${percent}% line; other providers are paused`
              : state === "paused"
                ? `Paused at its ${percent}% line`
                : state === "lifted"
                  ? `Going on until ${time(liftedUntil!)}, past its ${percent}% line`
                  : `Pauses at ${percent}% of its limits`}
          </p>
          <p className="m-0 text-xs leading-5 text-muted-foreground">
            {state === "below"
              ? "PassControl pauses this agent once it uses this share of any limit, before the limit itself is reached."
              : `${reached![0]!.toUpperCase()}${reached!.slice(1)}. The limit itself still applies.`}
            {state === "paused" && liftUnknown ? " The pause could not be checked just now, so it holds." : ""}
          </p>
        </div>
        {showLift ? (
          <button type="button" onClick={() => act(true)} disabled={busy}>
            {busy ? "Letting it go on…" : "Let it go on for an hour"}
          </button>
        ) : state === "lifted" ? (
          <button type="button" className="ghost" onClick={() => act(false)} disabled={busy}>
            {busy ? "Pausing…" : "Keep paused"}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="m-0 mt-2 text-sm" role="alert" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}
    </section>
  );
}
