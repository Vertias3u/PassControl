"use client";
// Edits what an agent is permitted to call. Until this existed, scope could be
// set when a passport was issued and never changed from the Control Tower —
// budgets and the kill switch were editable, the capability itself was not.
//
// Two things this UI has to be honest about, because both bite operators:
//
//  1. A scope change is NOT instant. The proxy gates on the scope snapshot
//     inside the visa, so an agent holding a live visa keeps its old scope
//     until that visa expires. The delay is rendered from visaTtlSeconds() and
//     never typed as a literal — VISA_TTL_SECONDS is tunable to 900.
//  2. An empty scope list is valid and means "this agent can reach nothing".
//     That is a legitimate way to park an agent, so validation does not block
//     it; the form warns instead.
import { type FormEvent, useState } from "react";
import { updateAgentScopes } from "@/app/dashboard/actions";
import { PROVIDERS, type ProviderId } from "@/lib/providers";
import { describeDelay, parseModels, type ScopeRow } from "@/lib/scope-rows";

export function ScopeEditor({
  agentId,
  scopes,
  ttlSeconds,
  onClose,
}: {
  agentId: string;
  scopes: readonly ScopeRow[];
  ttlSeconds: number;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<{ provider: string; models: string }[]>(
    scopes.length > 0
      ? scopes.map((s) => ({ provider: s.provider, models: s.models.join(", ") }))
      : [{ provider: PROVIDERS[0], models: "" }]
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A row with no model patterns grants nothing, so it is dropped rather than
  // saved as a provider entry that silently matches no call.
  const effective: ScopeRow[] = rows
    .map((r) => ({ provider: r.provider, models: parseModels(r.models) }))
    .filter((r) => r.models.length > 0);
  const reachesNothing = effective.length === 0;

  const setRow = (index: number, patch: Partial<{ provider: string; models: string }>) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await updateAgentScopes(agentId, effective);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="grid gap-4 rounded-lg border border-border bg-secondary/40 p-4">
      <div className="grid gap-3">
        {rows.map((row, index) => (
          <div key={index} className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
            <label className="grid gap-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Provider</span>
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
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Models</span>
              <input
                value={row.models}
                onChange={(e) => setRow(index, { models: e.target.value })}
                placeholder="claude-*, claude-opus-5"
                spellCheck={false}
              />
            </label>
            <button
              type="button"
              className="ghost"
              onClick={() => setRows((prev) => prev.filter((_, i) => i !== index))}
              disabled={busy}
              aria-label={`Remove ${row.provider} scope`}
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <div>
        <button
          type="button"
          className="ghost"
          onClick={() => setRows((prev) => [...prev, { provider: PROVIDERS[0], models: "" }])}
          disabled={busy}
        >
          Add provider
        </button>
      </div>

      <p className="m-0 text-xs leading-5 text-muted-foreground">
        Comma-separated. <code>*</code> matches any model, and <code>claude-*</code> matches a
        prefix. An exact name must match exactly — <code>claude-haiku-4-5</code> does not cover{" "}
        <code>claude-haiku-4-5-20251001</code>.
      </p>

      {reachesNothing ? (
        <div
          className="rounded-lg border p-3"
          style={{ borderColor: "var(--warning)", background: "color-mix(in srgb, var(--warning) 10%, transparent)" }}
          data-state="reaches-nothing"
        >
          <p className="m-0 text-sm font-semibold" style={{ color: "var(--warning)" }}>
            Saving this leaves no scopes — this passport will reach nothing.
          </p>
          <p className="m-0 mt-1 text-xs leading-5 text-muted-foreground">
            Every call it makes will be refused. That is a valid way to park an agent; use suspend
            if you want it stopped but its capability kept.
          </p>
        </div>
      ) : null}

      <p className="m-0 text-xs leading-5 text-muted-foreground">
        Takes effect on the agent&rsquo;s next visa. One already issued keeps the old scope until
        it expires, up to {describeDelay(ttlSeconds)} from now — the gateway checks the scope
        carried in the visa, not this record. To stop an agent immediately, suspend it or use the
        kill switch.
      </p>

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
          {busy ? "Saving..." : reachesNothing ? "Save — reach nothing" : "Save scopes"}
        </button>
      </div>
    </form>
  );
}
