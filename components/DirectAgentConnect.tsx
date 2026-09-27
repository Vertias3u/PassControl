"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRound, PlugZap, RefreshCw, ShieldCheck } from "lucide-react";

import { issueDirectAgent } from "@/app/dashboard/actions";
import { clientModelIsUsable, DEFAULT_CLIENT_MODELS, providerAvailability } from "@/lib/agent-connect";
import { parseTokenBudgetInput, parseUsdBudgetToCents } from "@/lib/budget-input";
import { PROVIDERS, type ProviderId } from "@/lib/providers";
import { scopeAllows } from "@/lib/scope";
import { buttonVariants } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DirectAgentKeyReveal, type RevealedDirectAgent } from "@/components/DirectAgentKeyReveal";

const DEFAULT_INSTALLATION_NAME = "My installation";

export function DirectAgentConnect({
  triggerLabel = "Connect an agent",
  initialProvider = "openai",
  configuredProviders,
}: {
  triggerLabel?: string;
  initialProvider?: ProviderId;
  /**
   * Providers with a stored key, or null when that read failed. Omitted means
   * the caller did not check; the server action still refuses a provider with
   * no stored key either way.
   */
  configuredProviders?: readonly ProviderId[] | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [keyName, setKeyName] = useState(DEFAULT_INSTALLATION_NAME);
  const [provider, setProvider] = useState<ProviderId>(initialProvider);
  // The grant starts at the ONE concrete model this worker calls, not at a
  // family wildcard: widening is a deliberate edit, and a narrow grant is what
  // makes the activation guide's scope-refusal test possible at all.
  const [models, setModels] = useState(DEFAULT_CLIENT_MODELS[initialProvider]);
  const [clientModel, setClientModel] = useState(DEFAULT_CLIENT_MODELS[initialProvider]);
  const [tokenBudget, setTokenBudget] = useState("");
  const [costBudgetUsd, setCostBudgetUsd] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [result, setResult] = useState<RevealedDirectAgent | null>(null);
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availability = providerAvailability(configuredProviders, provider);

  const reset = () => {
    setOpen(false);
    setName("");
    setKeyName(DEFAULT_INSTALLATION_NAME);
    setProvider(initialProvider);
    setModels(DEFAULT_CLIENT_MODELS[initialProvider]);
    setClientModel(DEFAULT_CLIENT_MODELS[initialProvider]);
    setTokenBudget("");
    setCostBudgetUsd("");
    setExpiresAt("");
    setResult(null);
    setStored(false);
    setError(null);
  };

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      const allowedModels = models.split(",").map((value) => value.trim()).filter(Boolean);
      const callableModel = clientModel.trim();
      if (!clientModelIsUsable(callableModel) || !scopeAllows([{ provider, models: allowedModels }], provider, callableModel)) {
        throw new Error("Client model must be a concrete model covered by the allowed patterns.");
      }
      const issued = await issueDirectAgent({
        name,
        keyName,
        scopes: [{ provider, models: allowedModels }],
        budget_tokens: parseTokenBudgetInput(tokenBudget),
        budget_cents: parseUsdBudgetToCents(costBudgetUsd),
        expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
      });
      setResult({ ...issued, provider, model: callableModel });
    } catch (caught) {
      setError((caught as Error).message || "This credential could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const acknowledgeStored = () => {
    if (!stored) return;
    reset();
    router.refresh();
  };

  const label = "text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground";

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={buttonVariants({ size: "lg" })}>
        <PlugZap aria-hidden="true" className="h-4 w-4" /> {triggerLabel}
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            if (result && !stored) return;
            if (result) acknowledgeStored();
            else reset();
          } else {
            setOpen(true);
          }
        }}
        title={result ? "Store the Direct Agent Key" : "Connect an agent"}
        description={
          result
            ? "The raw credential is not stored by PassControl and cannot be retrieved later."
            : "Create one scoped identity, then copy the provider-native configuration into its SDK or compatible client."
        }
        preventClose={Boolean(result && !stored)}
        showClose={!result}
        className="max-w-2xl"
      >
        <div className="grid gap-5" data-direct-connect-state={result ? undefined : "configure"}>
          {!result ? (
            <>
              <div className="rounded-xl border border-primary/25 bg-primary/8 p-4 text-sm leading-6">
                <div className="flex items-start gap-3">
                  <ShieldCheck aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                  <p className="m-0">
                    <strong>Fast on-ramp, lower assurance.</strong> This is a revocable bearer key, not a
                    signed passport. Calls stay scope- and budget-bound, and receipts say exactly which
                    authentication method was accepted.
                  </p>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm">
                  <span className={label}>Agent name</span>
                  <input value={name} onChange={(event) => setName(event.target.value)} placeholder="coding-agent" autoFocus />
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className={label}>Installation name</span>
                  <input value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="Work laptop" />
                  <span className="text-xs text-muted-foreground">Used for attribution. Create a separate key per installation.</span>
                </label>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1.5 text-sm">
                  <span className={label}>Provider</span>
                  <select
                    value={provider}
                    onChange={(event) => {
                      const next = event.target.value as ProviderId;
                      setProvider(next);
                      setModels(DEFAULT_CLIENT_MODELS[next]);
                      setClientModel(DEFAULT_CLIENT_MODELS[next]);
                    }}
                  >
                    {PROVIDERS.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className={label}>Allowed models</span>
                  <input value={models} onChange={(event) => setModels(event.target.value)} />
                  <span className="text-xs text-muted-foreground">Starts at the one model this worker calls. Add exact ids or patterns such as <code>gpt-*</code> deliberately; comma-separated.</span>
                </label>
              </div>
              <label className="grid gap-1.5 text-sm">
                <span className={label}>Client model</span>
                <input value={clientModel} onChange={(event) => setClientModel(event.target.value)} />
                <span className="text-xs text-muted-foreground">A concrete model the SDK will call. It must match one of the allowed patterns above; wildcards are authorization rules, not provider model names.</span>
              </label>
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="grid gap-1.5 text-sm">
                  <span className={label}>Token budget</span>
                  <input value={tokenBudget} onChange={(event) => setTokenBudget(event.target.value)} inputMode="numeric" placeholder="Unlimited" />
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className={label}>Cost budget (USD)</span>
                  <input value={costBudgetUsd} onChange={(event) => setCostBudgetUsd(event.target.value)} inputMode="decimal" placeholder="Unlimited" />
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className={label}>Optional expiry</span>
                  <input type="date" value={expiresAt} min={new Date().toISOString().slice(0, 10)} onChange={(event) => setExpiresAt(event.target.value)} />
                  <span className="text-xs text-muted-foreground">Blank means no scheduled outage.</span>
                </label>
              </div>
              <p className="m-0 text-xs leading-5 text-muted-foreground">
                Blank budgets mean no PassControl cap on this worker. This flow never asks the worker to hold your provider key.
              </p>
              {availability === "missing" ? (
                <div role="status" className="pc-inline-error" data-provider-availability="missing">
                  No {provider} key is stored in PassControl yet, so this worker&apos;s calls would have nothing to use.{" "}
                  <Link href="/dashboard/settings#provider-credentials">Add a {provider} key</Link>, or choose a provider you have stored.
                </div>
              ) : null}
              {availability === "unknown" ? (
                <div role="status" className="pc-inline-error" data-provider-availability="unknown">
                  PassControl could not confirm which provider keys are stored.{" "}
                  <button type="button" className="ghost" onClick={() => router.refresh()}>
                    <RefreshCw aria-hidden="true" className="h-4 w-4" /> Retry
                  </button>
                </div>
              ) : null}
              {error ? <p role="alert" className="pc-inline-error">{error}</p> : null}
              <div className="flex justify-end gap-3">
                <button type="button" className="ghost" onClick={reset}>Cancel</button>
                <button
                  type="button"
                  className={buttonVariants({ size: "lg" })}
                  disabled={busy || availability === "missing" || availability === "unknown" || !name.trim() || !keyName.trim() || !clientModel.trim() || !models.split(",").some((value) => value.trim())}
                  onClick={issue}
                >
                  <KeyRound aria-hidden="true" className="h-4 w-4" />
                  {busy ? "Creating…" : "Create credential"}
                </button>
              </div>
            </>
          ) : (
            <DirectAgentKeyReveal
              issued={result}
              stored={stored}
              onStoredChange={setStored}
              onDone={acknowledgeStored}
            />
          )}
        </div>
      </Dialog>
    </>
  );
}
