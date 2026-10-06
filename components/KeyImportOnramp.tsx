"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ed25519 } from "@noble/curves/ed25519";
import { ArrowRight, Check, KeyRound, Plus, ShieldCheck, Upload, X } from "lucide-react";
import { completeKeyImport, completeKeyImportDirect, probeProviderKey } from "@/app/dashboard/actions-client";
import {
  clientModelIsUsable,
  DEFAULT_CLIENT_MODELS,
  OTHER_MODEL_DISPLAY_LIMIT,
  preferredClientModel,
  rankDiscoveredModels,
} from "@/lib/agent-connect";
import { bytesToBase64url } from "@/lib/encoding";
import {
  PROVIDERS,
  detectProviderFromKey,
  providerRequiresEndpoint,
  resolveProviderSelection,
  type ProviderId,
} from "@/lib/providers";
import { buttonVariants } from "@/components/ui/button";
import { PassportStoreAndConnect } from "@/components/PassportStoreAndConnect";
import { DirectAgentKeyReveal, type RevealedDirectAgent } from "@/components/DirectAgentKeyReveal";
import { scopeAllows } from "@/lib/scope";

type Stage = "key" | "scope" | "done";
/** Providers whose key alone is enough to import; see the picker below. */
const IMPORTABLE_PROVIDERS = PROVIDERS.filter((p) => !providerRequiresEndpoint(p));
/**
 * Which credential the worker gets. A Direct Agent Key is the default because
 * it is what an existing SDK can use unchanged — replace the provider key with
 * it and set a base URL. A Passport is the stronger, explicit second choice
 * for code that can sign challenges.
 */
type WorkerCredential = "direct" | "passport";
const DEFAULT_INSTALLATION_NAME = "My installation";

export function KeyImportOnramp({
  userId,
  integrations,
  onRevealChange,
}: {
  userId: string;
  integrations: string[];
  /** Fired while this component is displaying a passport secret that exists
   *  nowhere else. The parent renders it inside a stage branch, so it must not
   *  advance that stage until this goes false. */
  onRevealChange?: (revealing: boolean) => void;
}) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("key");
  const [key, setKey] = useState("");
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const [providerOverridden, setProviderOverridden] = useState(false);
  const [handoff, setHandoff] = useState("");
  const [probeMode, setProbeMode] = useState<"detected" | "manual">("manual");
  // What the provider reported, kept SEPARATE from the grant below. Discovery
  // describes the key; `models` authorizes the agent. Merging the two is what
  // filled a scope to its validator ceiling before the operator chose anything.
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [discoveredTotal, setDiscoveredTotal] = useState(0);
  const [models, setModels] = useState("");
  const [clientModel, setClientModel] = useState(DEFAULT_CLIENT_MODELS.anthropic);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("imported");
  const [passportId, setPassportId] = useState("");
  const [passportSecret, setPassportSecret] = useState("");
  const [agentId, setAgentId] = useState("");
  const [issuedAt, setIssuedAt] = useState("");
  const [credential, setCredential] = useState<WorkerCredential>("direct");
  const [directIssued, setDirectIssued] = useState<RevealedDirectAgent | null>(null);
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Through a ref so an inline arrow from the parent cannot re-fire the effect on
  // every render.
  const revealRef = useRef(onRevealChange);
  revealRef.current = onRevealChange;
  useEffect(() => {
    revealRef.current?.(stage === "done" && (Boolean(passportSecret) || Boolean(directIssued)));
  }, [stage, passportSecret, directIssued]);
  useEffect(() => () => revealRef.current?.(false), []);

  const guess = useMemo(() => detectProviderFromKey(key), [key]);
  const selectedModels = useMemo(
    () => models.split(",").map((model) => model.trim()).filter(Boolean),
    [models]
  );
  // Presentation only. The listing is split by id shape into a short list of
  // current general-purpose models and everything else the key reported; the
  // provider's own order is not a recommendation. Neither list is the grant —
  // `models` is, and any exact id can still be typed into it.
  const ranked = useMemo(() => rankDiscoveredModels(discovered), [discovered]);
  const suggestions = useMemo(
    () => ranked.suggested.filter((model) => !selectedModels.includes(model)),
    [ranked, selectedModels]
  );
  const otherModels = useMemo(
    () => ranked.other.filter((model) => !selectedModels.includes(model)),
    [ranked, selectedModels]
  );
  const otherShown = otherModels.slice(0, OTHER_MODEL_DISPLAY_LIMIT);

  const reset = () => {
    setStage("key");
    setKey("");
    setProvider("anthropic");
    setProviderOverridden(false);
    setHandoff("");
    setProbeMode("manual");
    setDiscovered([]);
    setDiscoveredTotal(0);
    setModels("");
    setClientModel(DEFAULT_CLIENT_MODELS.anthropic);
    setName("");
    setLabel("imported");
    setPassportId("");
    setPassportSecret("");
    setAgentId("");
    setIssuedAt("");
    setCredential("direct");
    setDirectIssued(null);
    setStored(false);
    setError(null);
  };

  const probe = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Start the server action, then immediately remove the raw key from React
      // state. Only the in-flight server-action request still carries it.
      const pending = probeProviderKey({ provider, key });
      setKey("");
      const result = await pending;
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setHandoff(result.handoff);
      setProbeMode(result.mode);
      setDiscovered(result.models);
      setDiscoveredTotal(result.modelsTotal);
      // The grant starts at the ONE model this agent is about to call, not at
      // everything the key can see. The rest of the listing is offered below as
      // one-click additions, so widening the scope stays an operator decision
      // rather than the default.
      const concrete = preferredClientModel(provider, result.models);
      setClientModel(concrete);
      setModels(concrete);
      setStage("scope");
    } catch (cause) {
      setError((cause as Error).message || "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const complete = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedModels.length) {
      setError("Choose at least one model before creating the agent.");
      return;
    }
    const concreteModel = clientModel.trim();
    if (!clientModelIsUsable(concreteModel) || !scopeAllows([{ provider, models: selectedModels }], provider, concreteModel)) {
      setError("Model to call must be a concrete provider model id covered by the allowed models.");
      return;
    }
    setBusy(true);
    setError(null);
    if (credential === "direct") {
      try {
        const result = await completeKeyImportDirect({
          handoff,
          provider,
          label: label.trim() || "imported",
          name,
          keyName: DEFAULT_INSTALLATION_NAME,
          models: selectedModels,
        });
        setDirectIssued({ ...result, provider: result.provider, model: concreteModel });
        setHandoff("");
        setStage("done");
      } catch (cause) {
        setError((cause as Error).message || "Something went wrong. Please try again.");
      } finally {
        setBusy(false);
      }
      return;
    }
    const privateKey = ed25519.utils.randomPrivateKey();
    try {
      const publicKey = ed25519.getPublicKey(privateKey);
      const publicId = bytesToBase64url(publicKey);
      const result = await completeKeyImport({
        handoff,
        provider,
        label: label.trim() || "imported",
        name,
        passportPubkey: publicId,
        models: selectedModels,
      });
      setPassportId(publicId);
      setPassportSecret(bytesToBase64url(privateKey));
      setAgentId(result.agentId);
      setIssuedAt(result.createdAt);
      setHandoff("");
      setStage("done");
    } catch (cause) {
      setError((cause as Error).message || "Something went wrong. Please try again.");
    } finally {
      privateKey.fill(0);
      setBusy(false);
    }
  };

  const removeModel = (modelToRemove: string) => {
    setModels(selectedModels.filter((model) => model !== modelToRemove).join(", "));
  };

  const addModel = (modelToAdd: string) => {
    if (selectedModels.includes(modelToAdd)) return;
    setModels([...selectedModels, modelToAdd].join(", "));
  };

  const acknowledgeStored = () => {
    if (!stored) return;
    reset();
    router.refresh();
  };

  const labelClass = "grid gap-1 text-sm";
  const labelText = "text-xs uppercase tracking-wide text-muted-foreground";

  return (
    <div className="pc-onramp">
      <div>
        <h2 className="mb-1 flex items-center gap-2 text-lg font-bold">
          <Upload className="h-5 w-5 text-primary" /> Import an existing provider key
        </h2>
        <p className="m-0 text-sm text-muted-foreground">
          Detect reachable models, choose the exact capability grant, store the key in Vault,
          and give one worker its own credential in one flow.
        </p>
      </div>

      <ol className="pc-onramp__steps" aria-label="Provider import progress">
        {[
          ["key", "Provider key"],
          ["scope", "Capability"],
          ["done", "Connect worker"],
        ].map(([id, text], index) => {
          const current = ["key", "scope", "done"].indexOf(stage);
          const complete = index < current;
          return (
            <li key={id} data-state={complete ? "complete" : stage === id ? "current" : "upcoming"}>
              <span>{complete ? <Check aria-hidden="true" /> : index + 1}</span>
              {text}
            </li>
          );
        })}
      </ol>

      {stage === "key" ? (
        <form onSubmit={probe} className="grid gap-4">
          <div className="pc-onramp__boundary" aria-label="Provider credential boundary">
            <div><span>Browser</span><small>paste once</small></div>
            <ArrowRight aria-hidden="true" />
            <div className="is-control"><ShieldCheck aria-hidden="true" /><span>PassControl</span><small>probe, then clear</small></div>
            <ArrowRight aria-hidden="true" />
            <div><span>Vault</span><small>encrypted only after review</small></div>
          </div>
          <label className={labelClass}>
            <span className={labelText}>Provider key</span>
            <input
              type="password"
              value={key}
              onChange={(event) => {
                const next = event.target.value;
                setKey(next);
                if (!providerOverridden) setProvider(resolveProviderSelection(next));
              }}
              placeholder="Paste the key your agent already uses"
              autoComplete="new-password"
              spellCheck={false}
            />
            <span className="text-xs text-muted-foreground">
              Sent once to this server and the selected provider. Never placed in a URL or
              returned to this page.
            </span>
          </label>

          <label className={labelClass}>
            <span className={labelText}>Provider</span>
            <select
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value as ProviderId);
                setClientModel(DEFAULT_CLIENT_MODELS[event.target.value as ProviderId]);
                setProviderOverridden(true);
              }}
            >
              {/* Not Azure: its key is only usable with the resource address, which
                  this on-ramp does not ask for. Settings adds the two together. */}
              {IMPORTABLE_PROVIDERS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">
              Azure OpenAI keys are added under Settings, Provider credentials, together with the resource address.
            </span>
            {key ? (
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {guess.ambiguous
                  ? `Low-confidence match${guess.candidates.length < PROVIDERS.length ? `: ${guess.candidates.join(" or ")}` : ""}. Confirm the provider manually.`
                  : `High-confidence key-shape match: ${guess.suggested}. You can still override it.`}
              </span>
            ) : null}
          </label>
          <label className={labelClass}>
            <span className={labelText}>Model to call · exact provider ID</span>
            <input value={clientModel} onChange={(event) => setClientModel(event.target.value)} />
            <span className="text-xs text-muted-foreground">Allowed models are authorization. This separate concrete ID is sent to the provider; wildcards are rejected.</span>
          </label>

          {error ? <p className="m-0 text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!key || busy}
              className={buttonVariants({ size: "sm" })}
            >
              {busy ? "Detecting models…" : "Detect models"}
            </button>
          </div>
        </form>
      ) : null}

      {stage === "scope" ? (
        <form onSubmit={complete} className="grid gap-4">
          <div className="rounded-md border border-border bg-secondary/40 p-3 text-sm">
            {probeMode === "detected" ? (
              <p className="m-0">
                <strong>{provider}</strong> reported {discoveredTotal} model
                {discoveredTotal === 1 ? "" : "s"} for this key. That is what the key can
                see, not what the agent may use — the grant below starts at one model and
                you widen it deliberately.
              </p>
            ) : (
              <p className="m-0">
                We couldn&apos;t detect models. The key is ready for secure import; the grant
                below starts at this provider&apos;s usual model — replace it with the model ids
                this agent should be allowed to use.
              </p>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className={labelClass}>
              <span className={labelText}>Agent name</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="prod-summarizer"
              />
            </label>
            <label className={labelClass}>
              <span className={labelText}>Vault label</span>
              <input value={label} onChange={(event) => setLabel(event.target.value)} />
            </label>
          </div>
          <label className={labelClass}>
            <span className={labelText}>Allowed models · the grant (comma-separated)</span>
            <textarea
              value={models}
              onChange={(event) => setModels(event.target.value)}
              rows={4}
              placeholder="Enter exact model ids"
            />
            <span className="text-xs text-muted-foreground">
              This is the worker&apos;s capability grant — the only list that authorizes
              anything. Add only what the agent needs; any exact id works, listed below or not.
            </span>
          </label>
          {selectedModels.length ? (
            <div className="pc-onramp__models" aria-label={`${selectedModels.length} selected models`}>
              {selectedModels.map((model) => (
                <span key={model}>
                  <code>{model}</code>
                  <button type="button" onClick={() => removeModel(model)} aria-label={`Remove ${model}`}>
                    <X aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          {suggestions.length ? (
            <div className="grid gap-2" data-section="suggested-models">
              <span className="text-xs text-muted-foreground">
                Suggested — current general-purpose models on this key, picked by name
                for convenience. Adding one widens the grant.
              </span>
              <ModelChips
                models={suggestions}
                onAdd={addModel}
                label="Suggested models from this provider"
              />
            </div>
          ) : null}
          {otherModels.length ? (
            <details className="grid gap-2" data-section="other-models">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                {/* "Showing N of M", never a truncated list presented as the whole
                    set — that is how an operator concludes a model is unavailable
                    when it simply was not listed. */}
                Other models this key reports ({otherModels.length}) — not recommended
              </summary>
              <span className="text-xs text-muted-foreground">
                Dated snapshots, older families, and audio, image, embedding or moderation
                models, which the provider lists but which may not work on the chat and
                Responses endpoints PassControl forwards.
                {otherShown.length < otherModels.length
                  ? ` Showing ${otherShown.length} of ${otherModels.length}; type any other exact id into the allowed models above.`
                  : ""}
              </span>
              <ModelChips models={otherShown} onAdd={addModel} label="Other models from this provider" />
            </details>
          ) : null}
          <fieldset className="grid gap-2" data-section="worker-credential">
            <legend className={labelText}>Credential for this worker</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="worker-credential"
                className="mt-1 w-auto"
                checked={credential === "direct"}
                onChange={() => setCredential("direct")}
              />
              <span>
                <strong>Direct Agent Key</strong> — recommended. The worker&apos;s existing SDK uses it in
                place of the provider key; only the base URL changes. A revocable bearer key, bound to
                this one agent.
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="worker-credential"
                className="mt-1 w-auto"
                checked={credential === "passport"}
                onChange={() => setCredential("passport")}
              />
              <span>
                <strong>Passport</strong> — stronger identity for code that can sign challenges with the
                PassControl SDK or sidecar. The private key is generated in this browser.
              </span>
            </label>
          </fieldset>
          <div className="pc-onramp__review">
            <p className="pc-kicker">Before you continue</p>
            <p>
              Store one <strong>{provider}</strong> key as <strong>{label.trim() || "imported"}</strong>,
              {credential === "direct"
                ? <> give <strong>{name.trim() || "the named agent"}</strong> a Direct Agent Key,</>
                : <> issue <strong>{name.trim() || "the named agent"}</strong> a browser-generated passport,</>}
              {" "}and grant exactly {selectedModels.length} model{selectedModels.length === 1 ? "" : "s"}.
            </p>
          </div>
          {error ? <p className="m-0 text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-between gap-3">
            <button type="button" className="ghost" onClick={reset} disabled={busy}>
              Start over
            </button>
            <button
              type="submit"
              disabled={!name.trim() || !selectedModels.length || !clientModelIsUsable(clientModel) || busy}
              className={buttonVariants({ size: "sm" })}
            >
              <KeyRound className="h-4 w-4" />
              {busy
                ? "Securing import…"
                : credential === "direct"
                  ? "Store key & create worker credential"
                  : "Store key & issue passport"}
            </button>
          </div>
        </form>
      ) : null}

      {stage === "done" && directIssued ? (
        <DirectAgentKeyReveal
          issued={directIssued}
          stored={stored}
          onStoredChange={setStored}
          onDone={acknowledgeStored}
        />
      ) : null}

      {stage === "done" && agentId && issuedAt && passportId && passportSecret ? (
        <PassportStoreAndConnect
          userId={userId}
          agentId={agentId}
          issuedAt={issuedAt}
          provider={provider}
          model={clientModel.trim()}
          passportId={passportId}
          passportSecret={passportSecret}
          initialMode="sidecar"
          integrations={integrations}
          stored={stored}
          onStoredChange={setStored}
          onFinish={acknowledgeStored}
        />
      ) : null}
    </div>
  );
}

function ModelChips({
  models,
  onAdd,
  label,
}: {
  models: string[];
  onAdd: (model: string) => void;
  label: string;
}) {
  return (
    <div className="pc-onramp__models" aria-label={label}>
      {models.map((model) => (
        <span key={model}>
          <code>{model}</code>
          <button type="button" onClick={() => onAdd(model)} aria-label={`Allow ${model}`}>
            <Plus aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  );
}
