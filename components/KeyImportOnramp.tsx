"use client";

import { type FormEvent, useMemo, useState } from "react";
import { ed25519 } from "@noble/curves/ed25519";
import { Copy, KeyRound, Upload } from "lucide-react";
import { completeKeyImport, probeProviderKey } from "@/app/dashboard/actions";
import { buildConfigureSnippet } from "@/app/dashboard/key-import-snippet";
import { bytesToBase64url } from "@/lib/encoding";
import {
  PROVIDERS,
  detectProviderFromKey,
  resolveProviderSelection,
  type ProviderId,
} from "@/lib/providers";
import { buttonVariants } from "@/components/ui/button";

type Stage = "key" | "scope" | "done";

export function KeyImportOnramp({ integrations }: { integrations: string[] }) {
  const defaultIntegration = integrations.includes("generic")
    ? "generic"
    : integrations[0] ?? "";
  const [stage, setStage] = useState<Stage>("key");
  const [key, setKey] = useState("");
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const [providerOverridden, setProviderOverridden] = useState(false);
  const [handoff, setHandoff] = useState("");
  const [probeMode, setProbeMode] = useState<"detected" | "manual">("manual");
  const [models, setModels] = useState("");
  const [name, setName] = useState("");
  const [label, setLabel] = useState("imported");
  const [passportId, setPassportId] = useState("");
  const [passportSecret, setPassportSecret] = useState("");
  const [integration, setIntegration] = useState(defaultIntegration);
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setName("");
    setLabel("imported");
    setPassportId("");
    setPassportSecret("");
    setIntegration(defaultIntegration);
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
    setBusy(true);
    setError(null);
    const privateKey = ed25519.utils.randomPrivateKey();
    try {
      const publicKey = ed25519.getPublicKey(privateKey);
      const publicId = bytesToBase64url(publicKey);
      await completeKeyImport({
        handoff,
        provider,
        label: label.trim() || "imported",
        name,
        passportPubkey: publicId,
        models: selectedModels,
      });
      setPassportId(publicId);
      setPassportSecret(bytesToBase64url(privateKey));
      setHandoff("");
      setStage("done");
    } catch (cause) {
      setError((cause as Error).message || "Something went wrong. Please try again.");
    } finally {
      privateKey.fill(0);
      setBusy(false);
    }
  };

  const snippet =
    stage === "done" && passportId && passportSecret && selectedModels[0] && integration
      ? buildConfigureSnippet({
          passportId,
          passportSecret,
          provider,
          model: selectedModels[0],
          integration,
          allowedIntegrations: integrations,
        })
      : "";

  const labelClass = "grid gap-1 text-sm";
  const labelText = "text-xs uppercase tracking-wide text-muted-foreground";

  return (
    <div className="grid gap-5">
      <div>
        <h2 className="mb-1 flex items-center gap-2 text-lg font-bold">
          <Upload className="h-5 w-5 text-primary" /> Import an existing provider key
        </h2>
        <p className="m-0 text-sm text-muted-foreground">
          Detect reachable models, choose the exact capability grant, store the key in Vault,
          and issue a browser-generated passport in one flow.
        </p>
      </div>

      {stage === "key" ? (
        <form onSubmit={probe} className="grid gap-4">
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
              autoComplete="off"
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
              <span className="text-xs text-muted-foreground">
                {guess.ambiguous
                  ? "The key shape is ambiguous. Confirm or override the provider before continuing."
                  : `Key shape suggests ${guess.suggested}. You can override it.`}
              </span>
            ) : null}
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
          {error ? <p className="m-0 text-sm text-destructive">{error}</p> : null}
          <div className="flex justify-between gap-3">
            <button type="button" className="ghost" onClick={reset} disabled={busy}>
              Start over
            </button>
            <button
              type="submit"
              disabled={!name.trim() || !selectedModels.length || busy}
              className={buttonVariants({ size: "sm" })}
            >
              <KeyRound className="h-4 w-4" />
              {busy ? "Securing import…" : "Store key & issue passport"}
            </button>
          </div>
        </form>
      ) : null}

      {stage === "done" ? (
        <div className="grid gap-4">
          <div>
            <h3 className="m-0 text-base font-bold">Your governed agent is ready</h3>
            <p className="m-0 mt-1 text-sm text-muted-foreground">
              The private passport below is shown once. It was generated in this browser and
              was never sent to the server.
            </p>
          </div>
          <label className={labelClass}>
            <span className={labelText}>Integration preset</span>
            <select value={integration} onChange={(event) => setIntegration(event.target.value)}>
              {integrations.map((preset) => (
                <option key={preset} value={preset}>
                  {preset}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-1">
            <span className={labelText}>Paste into a private terminal</span>
            <pre className="overflow-x-auto rounded-sm border border-destructive/60 bg-destructive/5 p-3 text-xs">
              {snippet}
            </pre>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(snippet)}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-secondary/80"
            >
              <Copy className="h-4 w-4" /> Copy setup snippet
            </button>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="w-auto"
                checked={stored}
                onChange={(event) => setStored(event.target.checked)}
              />
              I&apos;ve stored this securely
            </label>
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              disabled={!stored}
              onClick={reset}
              className={buttonVariants({ size: "sm" })}
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
