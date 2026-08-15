"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, KeyRound, PlugZap, ShieldCheck } from "lucide-react";

import { issueDirectAgent } from "@/app/dashboard/actions";
import { clientModelIsUsable, DEFAULT_ALLOWED_MODELS, DEFAULT_CLIENT_MODELS } from "@/lib/agent-connect";
import { parseTokenBudgetInput, parseUsdBudgetToCents } from "@/lib/budget-input";
import { buildDirectConnectSetup, buildHermesCloudSetup } from "@/lib/direct-connect-config";
import { PROVIDERS, type ProviderId } from "@/lib/providers";
import { scopeAllows } from "@/lib/scope";
import { buttonVariants } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

interface IssuedDirectAgent {
  agentId: string;
  keyId: string;
  key: string;
  name: string;
  keyName: string;
  expiresAt: string | null;
  provider: ProviderId;
  model: string;
}

function gatewayOrigin(): string {
  return typeof window === "undefined" ? "https://YOUR-PASSCONTROL-HOST" : window.location.origin;
}

export function DirectAgentConnect({
  triggerLabel = "Connect an agent",
  initialProvider = "openai",
}: {
  triggerLabel?: string;
  initialProvider?: ProviderId;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [keyName, setKeyName] = useState("My installation");
  const [provider, setProvider] = useState<ProviderId>(initialProvider);
  const [models, setModels] = useState(DEFAULT_ALLOWED_MODELS[initialProvider]);
  const [clientModel, setClientModel] = useState(DEFAULT_CLIENT_MODELS[initialProvider]);
  const [tokenBudget, setTokenBudget] = useState("");
  const [costBudgetUsd, setCostBudgetUsd] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [result, setResult] = useState<IssuedDirectAgent | null>(null);
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState<"key" | "env" | "smoke" | "code" | "hermes" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setOpen(false);
    setName("");
    setKeyName("My installation");
    setProvider(initialProvider);
    setModels(DEFAULT_ALLOWED_MODELS[initialProvider]);
    setClientModel(DEFAULT_CLIENT_MODELS[initialProvider]);
    setTokenBudget("");
    setCostBudgetUsd("");
    setExpiresAt("");
    setResult(null);
    setStored(false);
    setCopied(null);
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

  const copy = async (kind: "key" | "env" | "smoke" | "code" | "hermes", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setError("Clipboard access was blocked. Select and copy the value manually.");
    }
  };

  const acknowledgeStored = () => {
    if (!stored) return;
    reset();
    router.refresh();
  };

  const setup = result ? buildDirectConnectSetup({
    origin: gatewayOrigin(),
    provider: result.provider,
    key: result.key,
    model: result.model,
  }) : null;
  const hermesSetup = result ? buildHermesCloudSetup({
    origin: gatewayOrigin(),
    provider: result.provider,
    key: result.key,
    model: result.model,
  }) : null;
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
        <div className="grid gap-5" data-direct-connect-state={result ? "issued" : "configure"}>
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
                  <span className={label}>Provider account</span>
                  <select
                    value={provider}
                    onChange={(event) => {
                      const next = event.target.value as ProviderId;
                      setProvider(next);
                      setModels(DEFAULT_ALLOWED_MODELS[next]);
                      setClientModel(DEFAULT_CLIENT_MODELS[next]);
                    }}
                  >
                    {PROVIDERS.map((value) => <option key={value} value={value}>{value}</option>)}
                  </select>
                </label>
                <label className="grid gap-1.5 text-sm">
                  <span className={label}>Allowed model patterns</span>
                  <input value={models} onChange={(event) => setModels(event.target.value)} />
                  <span className="text-xs text-muted-foreground">Comma-separated. Blank scopes are a real deny-all state.</span>
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
                The matching provider key must already be stored in PassControl. This flow never asks the agent to hold that provider key.
              </p>
              {error ? <p role="alert" className="pc-inline-error">{error}</p> : null}
              <div className="flex justify-end gap-3">
                <button type="button" className="ghost" onClick={reset}>Cancel</button>
                <button
                  type="button"
                  className={buttonVariants({ size: "lg" })}
                  disabled={busy || !name.trim() || !keyName.trim() || !clientModel.trim() || !models.split(",").some((value) => value.trim())}
                  onClick={issue}
                >
                  <KeyRound aria-hidden="true" className="h-4 w-4" />
                  {busy ? "Creating…" : "Create credential"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-3 rounded-xl border border-success/30 bg-success/8 p-4">
                <div className="flex items-center gap-2 text-sm font-bold text-success">
                  <Check aria-hidden="true" className="h-4 w-4" /> Credential created
                </div>
                <p className="m-0 text-sm leading-6 text-muted-foreground">
                  This is not yet proof that traffic reached the gateway. A stored call row will provide that evidence after the client makes its first request.
                </p>
              </div>
              <div className="pc-secret-warning">
                <strong>Shown once.</strong>
                <span>Store this credential only in the intended agent or secret manager.</span>
              </div>
              <div className="grid gap-1.5">
                <span className={label}>Direct Agent Key</span>
                <pre className="pc-secret-block is-secret whitespace-pre-wrap break-all">{result.key}</pre>
                <button type="button" className="ghost justify-self-start" onClick={() => copy("key", result.key)}>
                  {copied === "key" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied === "key" ? "Copied" : "Copy credential"}
                </button>
              </div>
              {setup ? <div className="grid gap-1.5" data-client-family={setup.family}>
                <span className={label}>{setup.label}</span>
                <pre className="overflow-x-auto rounded-xl border border-border bg-black/30 p-4 text-xs leading-6 text-foreground">{setup.envBlock}</pre>
                <button type="button" className="ghost justify-self-start" onClick={() => copy("env", setup.envBlock)}>
                  {copied === "env" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied === "env" ? "Copied" : "Copy configuration"}
                </button>
                <span className={`${label} mt-2`}>First-call smoke test</span>
                <pre className="overflow-x-auto rounded-xl border border-border bg-black/30 p-4 text-xs leading-6 text-foreground">{setup.smokeCommand}</pre>
                <button type="button" className="ghost justify-self-start" onClick={() => copy("smoke", setup.smokeCommand)}>
                  {copied === "smoke" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied === "smoke" ? "Copied" : "Copy smoke test"}
                </button>
                <p className="m-0 text-xs leading-5 text-muted-foreground">
                  After loading the configuration above, this command makes one real provider request without copying the credential into shell history. A successful response is useful, but the stored call row is the dashboard&apos;s proof that PassControl governed it.
                </p>
                <span className={`${label} mt-2`}>Minimal SDK call</span>
                <pre className="overflow-x-auto rounded-xl border border-border bg-black/30 p-4 text-xs leading-6 text-foreground">{setup.example}</pre>
                <button type="button" className="ghost justify-self-start" onClick={() => copy("code", setup.example)}>
                  {copied === "code" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied === "code" ? "Copied" : "Copy SDK example"}
                </button>
                <p className="m-0 text-xs leading-5 text-muted-foreground">
                  {setup.authNote}
                </p>
              </div> : null}
              {hermesSetup ? <div className="grid gap-1.5" data-first-class-integration="hermes">
                <span className={label}>Hermes Agent {hermesSetup.version}</span>
                <p className="m-0 text-xs leading-5 text-muted-foreground">
                  Merge this <code>model</code> block into <code>{hermesSetup.configPath}</code>, then run <code>hermes chat</code>. This uses Hermes&apos;s current custom-provider configuration; the removed legacy <code>OPENAI_BASE_URL</code> path is not used.
                </p>
                <pre className="overflow-x-auto rounded-xl border border-border bg-black/30 p-4 text-xs leading-6 text-foreground">{hermesSetup.config}</pre>
                <button type="button" className="ghost justify-self-start" onClick={() => copy("hermes", hermesSetup.config)}>
                  {copied === "hermes" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  {copied === "hermes" ? "Copied" : "Copy Hermes configuration"}
                </button>
                <p className="m-0 text-xs leading-5 text-muted-foreground">
                  Hermes stores this scoped Direct Agent Key, never your provider key. Auxiliary providers or fallback tools configured elsewhere in Hermes are outside this route and can bypass PassControl.
                </p>
              </div> : null}
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 w-auto" checked={stored} onChange={(event) => setStored(event.target.checked)} />
                <span>I&apos;ve stored this credential securely</span>
              </label>
              {error ? <p role="alert" className="pc-inline-error">{error}</p> : null}
              <div className="flex justify-end">
                <button type="button" className={buttonVariants({ size: "lg" })} disabled={!stored} onClick={acknowledgeStored}>Done</button>
              </div>
            </>
          )}
        </div>
      </Dialog>
    </>
  );
}
