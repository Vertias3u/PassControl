"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ed25519 } from "@noble/curves/ed25519";
import { ArrowRight, Check, KeyRound, ShieldCheck, Upload, X } from "lucide-react";
import { completeKeyImport, probeProviderKey } from "@/app/dashboard/actions";
import { clientModelIsUsable, DEFAULT_CLIENT_MODELS } from "@/lib/agent-connect";
import { bytesToBase64url } from "@/lib/encoding";
import {
  PROVIDERS,
  detectProviderFromKey,
  resolveProviderSelection,
  type ProviderId,
} from "@/lib/providers";
import { buttonVariants } from "@/components/ui/button";
import { PassportStoreAndConnect } from "@/components/PassportStoreAndConnect";
import { scopeAllows } from "@/lib/scope";

type Stage = "key" | "scope" | "done";

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
  const [models, setModels] = useState("");
  const [clientModel, setClientModel] = useState(DEFAULT_CLIENT_MODELS.anthropic);
  const [name, setName] = useState("");
  const [label, setLabel] = useState("imported");
  const [passportId, setPassportId] = useState("");
  const [passportSecret, setPassportSecret] = useState("");
  const [agentId, setAgentId] = useState("");
  const [issuedAt, setIssuedAt] = useState("");
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Through a ref so an inline arrow from the parent cannot re-fire the effect on
  // every render.
  const revealRef = useRef(onRevealChange);
  revealRef.current = onRevealChange;
  useEffect(() => {
    revealRef.current?.(stage === "done" && Boolean(passportSecret));
  }, [stage, passportSecret]);
  useEffect(() => () => revealRef.current?.(false), []);

  const guess = useMemo(() => detectProviderFromKey(key), [key]);
  const selectedModels = useMemo(
    () => models.split(",").map((model) => model.trim()).filter(Boolean),
    [models]
  );

  const reset = () => {
    setStage("key");
    setKey("");
    setProvider("anthropic");
    setProviderOverridden(false);
    setHandoff("");
    setProbeMode("manual");
    setModels("");
    setClientModel(DEFAULT_CLIENT_MODELS.anthropic);
    setName("");
    setLabel("imported");
    setPassportId("");
    setPassportSecret("");
    setAgentId("");
    setIssuedAt("");
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
      setModels(result.models.join(", "));
      setClientModel(result.models.find(clientModelIsUsable) ?? DEFAULT_CLIENT_MODELS[provider]);
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
          and issue a browser-generated passport in one flow.
        </p>
      </div>

      <ol className="pc-onramp__steps" aria-label="Provider import progress">
        {[
          ["key", "Provider key"],
          ["scope", "Capability"],
          ["done", "Connect agent"],
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
              {PROVIDERS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
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
                Models returned by <strong>{provider}</strong> are pre-filled below. Trim this
                list before granting the passport.
              </p>
            ) : (
              <p className="m-0">
                We couldn&apos;t detect models. The key is ready for secure import; enter the model
                ids this agent should be allowed to use.
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
            <span className={labelText}>Allowed models (comma-separated)</span>
            <textarea
              value={models}
              onChange={(event) => setModels(event.target.value)}
              rows={4}
              placeholder="Enter exact model ids"
            />
            <span className="text-xs text-muted-foreground">
              This is the passport&apos;s capability grant. Remove anything the agent does not need.
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
          <div className="pc-onramp__review">
            <p className="pc-kicker">Before you continue</p>
            <p>
              Store one <strong>{provider}</strong> key as <strong>{label.trim() || "imported"}</strong>,
              issue <strong>{name.trim() || "the named agent"}</strong> a browser-generated passport,
              and grant exactly {selectedModels.length} model{selectedModels.length === 1 ? "" : "s"}.
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
              {busy ? "Securing import…" : "Store key & issue passport"}
            </button>
          </div>
        </form>
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
          integrations={integrations}
          stored={stored}
          onStoredChange={setStored}
          onFinish={acknowledgeStored}
        />
      ) : null}
    </div>
  );
}
