"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { KeyRound, PlugZap, RefreshCw, ShieldCheck } from "lucide-react";

import { issueDirectAgent, listLocalModelsForAgents } from "@/app/dashboard/actions-client";
import { clientModelIsUsable, DEFAULT_CLIENT_MODELS, providerAvailability } from "@/lib/agent-connect";
import { parseTokenBudgetInput, parseUsdBudgetToCents } from "@/lib/budget-input";
import { PROVIDERS, type ProviderId, offeredProviders } from "@/lib/providers";
import { useLocalModelsEnabled } from "@/components/dashboard/LocalModels";
import { scopeAllows } from "@/lib/scope";
import { buttonVariants } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DirectAgentKeyReveal, type RevealedDirectAgent } from "@/components/DirectAgentKeyReveal";
import { serviceNames } from "@/lib/services/display";
import { SERVICE_CATALOG, isServiceId } from "@/lib/services/catalog";
import { WIZARD_SERVICE_DEFAULTS, presetsFor, serviceHasWrites, type WizardServiceChoice } from "@/lib/services/presets";

/** The wizard's service choices for the services this workspace holds a token for, pre-ticked. */
function defaultServiceChoices(stored: readonly string[] | undefined): WizardServiceChoice[] {
  return (stored ?? []).flatMap((service) => {
    const defaults = isServiceId(service) ? WIZARD_SERVICE_DEFAULTS[service] : undefined;
    return defaults ? [{ service, checked: [...defaults.checked], askWrites: defaults.askWrites }] : [];
  });
}

const DEFAULT_INSTALLATION_NAME = "My installation";

export function DirectAgentConnect({
  triggerLabel = "Connect an agent",
  initialProvider = "openai",
  configuredProviders,
  storedServices,
}: {
  /**
   * Services the workspace holds a token for. Those the wizard can grant at
   * creation (WIZARD_SERVICE_DEFAULTS) are shown, pre-ticked.
   */
  storedServices?: readonly string[];
  triggerLabel?: string;
  initialProvider?: ProviderId;
  /**
   * Providers with a stored key, or null when that read failed. Omitted means
   * the caller did not check; the server action still refuses a provider with
   * no stored key either way.
   */
  configuredProviders?: readonly ProviderId[] | null;
}) {
  // `local` only where this deployment can reach it (components/dashboard/LocalModels.tsx).
  const localModels = useLocalModelsEnabled();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [keyName, setKeyName] = useState(DEFAULT_INSTALLATION_NAME);
  // What the worker calls. "services": catalog services only, so the agent is
  // created with NO model access at all (any model call is refused) and the
  // provider, model and budget fields do not apply.
  const [target, setTarget] = useState<"models" | "services">("models");
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
  const [serviceChoices, setServiceChoices] = useState<WizardServiceChoice[]>(() => defaultServiceChoices(storedServices));
  const [servicesOutcome, setServicesOutcome] = useState<{ granted: string[]; saved: boolean } | null>(null);
  const editChoice = (service: string, change: (choice: WizardServiceChoice) => WizardServiceChoice) =>
    setServiceChoices((current) => current.map((choice) => (choice.service === service ? change(choice) : choice)));
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The models on the workspace's local server, offered when `local` is chosen
  // (null until asked). Suggestions only: the fields stay free text.
  const [localModelList, setLocalModelList] = useState<string[] | null>(null);
  const servicesOnly = target === "services";

  useEffect(() => {
    if (!open || provider !== "local" || localModelList !== null) return;
    let cancelled = false;
    listLocalModelsForAgents()
      .then((result) => {
        if (cancelled) return;
        setLocalModelList(result.models);
        // Start the grant at a model the server actually has, rather than at a
        // default name it may never have pulled.
        const first = result.models[0];
        if (first && !result.models.includes(clientModel)) {
          setModels(first);
          setClientModel(first);
        }
      })
      .catch(() => {
        if (!cancelled) setLocalModelList([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, provider, localModelList, clientModel]);
  const availability = servicesOnly ? "ok" : providerAvailability(configuredProviders, provider);

  const reset = () => {
    setOpen(false);
    setTarget("models");
    setName("");
    setKeyName(DEFAULT_INSTALLATION_NAME);
    setProvider(initialProvider);
    setModels(DEFAULT_CLIENT_MODELS[initialProvider]);
    setClientModel(DEFAULT_CLIENT_MODELS[initialProvider]);
    setLocalModelList(null);
    setTokenBudget("");
    setCostBudgetUsd("");
    setExpiresAt("");
    setResult(null);
    setStored(false);
    setError(null);
    setServiceChoices(defaultServiceChoices(storedServices));
    setServicesOutcome(null);
  };

  const issue = async () => {
    setBusy(true);
    setError(null);
    try {
      if (servicesOnly) {
        const issued = await issueDirectAgent({
          name,
          keyName,
          scopes: [],
          expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
          services: serviceChoices,
        });
        setServicesOutcome({ granted: issued.servicesGranted ?? [], saved: issued.servicesSaved !== false });
        setResult({ ...issued, provider: null, model: null });
        return;
      }
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
        services: serviceChoices,
      });
      setServicesOutcome({ granted: issued.servicesGranted ?? [], saved: issued.servicesSaved !== false });
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
              <fieldset className="grid gap-2 text-sm" data-field="agent-target">
                <legend className={label}>What will this agent call?</legend>
                <label className="flex items-start gap-2">
                  <input type="radio" className="mt-1 w-auto" name="agent-target" checked={!servicesOnly} onChange={() => setTarget("models")} />
                  <span>AI models <span className="text-muted-foreground">(and {serviceNames()} too, if you add rules later)</span></span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="radio" className="mt-1 w-auto" name="agent-target" checked={servicesOnly} onChange={() => setTarget("services")} data-target="services" />
                  <span>Only services <span className="text-muted-foreground">({serviceNames()}; no model access, every model call is refused)</span></span>
                </label>
              </fieldset>
              {serviceChoices.map((choice) => {
                const entryLabel = isServiceId(choice.service) ? SERVICE_CATALOG[choice.service].label : choice.service;
                const sends = serviceHasWrites(choice.service);
                const anyWrite = presetsFor(choice.service).some((preset) => choice.checked.includes(preset.id) && preset.id !== "read");
                return (
                  <fieldset key={choice.service} className="grid gap-2 text-sm" data-wizard-service={choice.service}>
                    <legend className={label}>{entryLabel} access (your token is stored)</legend>
                    {presetsFor(choice.service).map((preset) => (
                      <label key={preset.id} className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-1 w-auto"
                          checked={choice.checked.includes(preset.id)}
                          onChange={(event) =>
                            editChoice(choice.service, (current) => ({
                              ...current,
                              checked: event.target.checked
                                ? [...current.checked.filter((id) => id !== preset.id), preset.id]
                                : current.checked.filter((id) => id !== preset.id),
                            }))
                          }
                          data-wizard-preset={preset.id}
                        />
                        <span>
                          {preset.label}
                          {preset.hint ? <span className="block text-xs text-muted-foreground">{preset.hint}</span> : null}
                        </span>
                      </label>
                    ))}
                    {sends ? (
                      <label className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          className="mt-1 w-auto"
                          checked={choice.askWrites}
                          disabled={!anyWrite}
                          onChange={(event) => editChoice(choice.service, (current) => ({ ...current, askWrites: event.target.checked }))}
                          data-wizard-ask
                        />
                        <span>
                          Ask me first before each send
                          <span className="block text-xs text-muted-foreground">
                            You approve or deny each one on the Approvals page, or with a tap on Telegram alerts.
                          </span>
                        </span>
                      </label>
                    ) : null}
                  </fieldset>
                );
              })}
              {servicesOnly ? (
                <p className="m-0 text-sm leading-6 text-muted-foreground" data-services-only-note>
                  After creating it, give it access on its page, under GitHub access or Telegram access. It can call
                  nothing until you do.
                </p>
              ) : null}
              {!servicesOnly ? (<>
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
                    {offeredProviders(PROVIDERS, localModels, [provider]).map((value) => <option key={value} value={value}>{value}</option>)}
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
                <input
                  value={clientModel}
                  onChange={(event) => setClientModel(event.target.value)}
                  list={provider === "local" && localModelList?.length ? "pc-local-models" : undefined}
                />
                <span className="text-xs text-muted-foreground">A concrete model the SDK will call. It must match one of the allowed patterns above; wildcards are authorization rules, not provider model names.</span>
              </label>
              {provider === "local" && localModelList?.length ? (
                <>
                  <datalist id="pc-local-models">
                    {localModelList.map((model) => <option key={model} value={model} />)}
                  </datalist>
                  <div className="flex flex-wrap items-center gap-2 text-xs" data-local-model-suggestions>
                    <span className="text-muted-foreground">On your server:</span>
                    {localModelList.slice(0, 12).map((model) => (
                      <button
                        key={model}
                        type="button"
                        className="ghost"
                        aria-pressed={clientModel === model}
                        onClick={() => {
                          setModels(model);
                          setClientModel(model);
                        }}
                      >
                        {model}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
              {provider === "local" && costBudgetUsd.trim() ? (
                <p role="status" className="pc-inline-error" data-local-cost-budget>
                  Local calls have no price, so a cost budget would refuse every call this worker
                  makes. Use a token budget instead.
                </p>
              ) : null}
              </>) : null}
              <div className={servicesOnly ? "grid gap-4" : "grid gap-4 sm:grid-cols-3"}>
                {!servicesOnly ? (<>
                <label className="grid gap-1.5 text-sm">
                  <span className={label}>Token budget</span>
                  <input value={tokenBudget} onChange={(event) => setTokenBudget(event.target.value)} inputMode="numeric" placeholder="Unlimited" />
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className={label}>Cost budget (USD)</span>
                  <input value={costBudgetUsd} onChange={(event) => setCostBudgetUsd(event.target.value)} inputMode="decimal" placeholder="Unlimited" />
                </label>
                </>) : null}
                <label className="grid gap-1.5 text-sm">
                  <span className={label}>Optional expiry</span>
                  <input type="date" value={expiresAt} min={new Date().toISOString().slice(0, 10)} onChange={(event) => setExpiresAt(event.target.value)} />
                  <span className="text-xs text-muted-foreground">Blank means no scheduled outage.</span>
                </label>
              </div>
              {!servicesOnly ? (
              <p className="m-0 text-xs leading-5 text-muted-foreground">
                Blank budgets mean no PassControl cap on this worker. This flow never asks the worker to hold your provider key.
              </p>
              ) : null}
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
                  disabled={
                    busy || availability === "missing" || availability === "unknown" ||
                    !name.trim() ||
                    !keyName.trim() ||
                    (!servicesOnly && (!clientModel.trim() || !models.split(",").some((value) => value.trim())))
                  }
                  onClick={issue}
                >
                  <KeyRound aria-hidden="true" className="h-4 w-4" />
                  {busy ? "Creating…" : "Create credential"}
                </button>
              </div>
            </>
          ) : (
            <>
            {servicesOutcome && !servicesOutcome.saved ? (
              <p role="alert" className="pc-inline-error" data-wizard-services="not-saved">
                The agent was created, but its service access could not be saved. Set it on the agent&apos;s page
                after storing the key.
              </p>
            ) : servicesOutcome && servicesOutcome.granted.length > 0 ? (
              <p role="status" className="m-0 text-sm text-muted-foreground" data-wizard-services="saved">
                Service access saved:{" "}
                {servicesOutcome.granted.map((service) => (isServiceId(service) ? SERVICE_CATALOG[service].label : service)).join(", ")}.
                Change it any time on the agent&apos;s page.
              </p>
            ) : null}
            <DirectAgentKeyReveal
              issued={result}
              stored={stored}
              onStoredChange={setStored}
              onDone={acknowledgeStored}
            />
            </>
          )}
        </div>
      </Dialog>
    </>
  );
}
