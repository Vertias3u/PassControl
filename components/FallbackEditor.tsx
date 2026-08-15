"use client";
// Edits which other providers the gateway may retry a failed call on.
//
// Three things this UI has to be honest about, because all three cost money:
//
//  1. A fallback outside the agent's scope NEVER FIRES. Every attempt is
//     re-checked against the scope carried in the visa, so a fallback the agent
//     may not call is configuration that silently does nothing. The form warns
//     and still lets you save it — adding the scope afterwards is a legitimate
//     order of work, and blocking would make the two editors fight.
//  2. A retry can be BILLED TWICE. After a 5xx or a dropped connection the first
//     provider may already have run the call. This screen states that where the
//     operator opts into the risk.
//  3. The delay is a cache window, NOT a visa TTL. Deliberately not ScopeEditor's
//     paragraph: fallbacks are read live with a 60-second cache, and saving
//     purges it, so the honest answer is "immediately".
import { type FormEvent, useState } from "react";
import { updateAgentFallbacks } from "@/app/dashboard/actions";
import { PROVIDERS, type ProviderId } from "@/lib/providers";
import { MAX_FALLBACKS } from "@/lib/providers/fallbacks";
import { outOfScope, type FallbackRow } from "@/lib/fallback-rows";
import type { ScopeRow } from "@/lib/scope-rows";
import { prospectiveAgentChange } from "@/lib/impact-preview";
import { ImpactPreview } from "@/components/ImpactPreview";

export function FallbackEditor({
  agentId,
  fallbacks,
  scopes,
  onClose,
}: {
  agentId: string;
  fallbacks: readonly FallbackRow[];
  scopes: readonly ScopeRow[];
  onClose: () => void;
}) {
  const [rows, setRows] = useState<FallbackRow[]>(fallbacks.map((f) => ({ ...f })));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A row with no model names nothing to call, so it is dropped rather than
  // saved as an entry the gateway would refuse the whole list over.
  const effective = rows
    .map((r) => ({ provider: r.provider, model: r.model.trim() }))
    .filter((r) => r.model.length > 0);
  const unreachable = outOfScope(effective, scopes);
  const preview = prospectiveAgentChange("fallbacks", fallbacks, effective);

  const setRow = (index: number, patch: Partial<FallbackRow>) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await updateAgentFallbacks(agentId, effective);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="grid gap-4 rounded-lg border border-border bg-secondary/40 p-4">
      {rows.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">
          No fallbacks. A failed call is returned to the agent as it is today.
        </p>
      ) : (
        <div className="grid gap-3">
          {rows.map((row, index) => (
            <div key={index} className="grid gap-3 sm:grid-cols-[2rem_10rem_1fr_auto] sm:items-end">
              <span className="hidden text-xs font-bold tabular-nums text-muted-foreground sm:block sm:pb-2">
                {index + 1}
              </span>
              <label className="grid gap-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  Provider
                </span>
                <select
                  value={row.provider}
                  onChange={(e) => setRow(index, { provider: e.target.value as ProviderId })}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">Model</span>
                <input
                  value={row.model}
                  onChange={(e) => setRow(index, { model: e.target.value })}
                  placeholder="llama-3.3-70b"
                  spellCheck={false}
                />
              </label>
              <button
                type="button"
                className="ghost"
                onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
                disabled={busy}
                aria-label={`Remove ${row.provider} fallback`}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div>
        <button
          type="button"
          className="ghost"
          onClick={() => setRows((prev) => [...prev, { provider: PROVIDERS[0], model: "" }])}
          disabled={busy || rows.length >= MAX_FALLBACKS}
        >
          Add fallback
        </button>
      </div>

      <p className="m-0 text-xs leading-5 text-muted-foreground">
        Tried in order, first to last, when the provider the agent asked for refuses the call for
        credit, rate limits it, returns a server error, or cannot be reached. A refusal that blames
        the request — a malformed body, a bad key, an unknown model — is never retried. At most{" "}
        {MAX_FALLBACKS}.
      </p>

      <p className="m-0 text-xs leading-5 text-muted-foreground">
        A fallback names one exact model to call, not a pattern. Each attempt is checked against
        this agent&rsquo;s scope, budget, policy and the kill switch on its own, so failover can
        never reach further than the agent already could.
      </p>

      <ImpactPreview change={preview} title="Fallback-order impact" />

      {unreachable.length > 0 ? (
        <div
          className="rounded-lg border p-3"
          style={{
            borderColor: "var(--warning)",
            background: "color-mix(in srgb, var(--warning) 10%, transparent)",
          }}
          data-state="out-of-scope"
        >
          <p className="m-0 text-sm font-semibold" style={{ color: "var(--warning)" }}>
            {unreachable.length === 1
              ? "One fallback is outside this agent's scope and will never fire."
              : `${unreachable.length} fallbacks are outside this agent's scope and will never fire.`}
          </p>
          <p className="m-0 mt-1 text-xs leading-5 text-muted-foreground">
            {unreachable.map((f) => `${f.provider}/${f.model}`).join(", ")} — every attempt is
            re-checked against the scope in the agent&rsquo;s visa, so these are skipped silently.
            Add them to the scopes above if you want them used. Saving anyway is fine.
          </p>
        </div>
      ) : null}

      {effective.length > 0 ? (
        <p className="m-0 text-xs leading-5 text-muted-foreground">
          One call can be billed twice. When the first provider returns a server error or drops the
          connection, it may already have run the call before failing — the gateway cannot tell.
          The receipt for the retry records why it happened so the two bills can be reconciled.
        </p>
      ) : null}

      {error ? (
        <p className="m-0 text-sm" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2">
        <button type="button" className="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="submit" disabled={busy}>
          {busy ? "Saving..." : effective.length === 0 ? "Save — no failover" : "Save fallbacks"}
        </button>
      </div>
    </form>
  );
}
