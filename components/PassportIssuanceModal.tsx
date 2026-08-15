"use client";
// Passport issuance: the Ed25519 keypair is generated IN THE BROWSER. Only the
// public key is sent to the server. The private key is shown exactly once.
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToBase64url } from "@/lib/encoding";
import { parseTokenBudgetInput, parseUsdBudgetToCents } from "@/lib/budget-input";
import { clientModelIsUsable, DEFAULT_ALLOWED_MODELS, DEFAULT_CLIENT_MODELS } from "@/lib/agent-connect";
import { PROVIDERS, type ProviderId } from "@/lib/providers";
import { scopeAllows } from "@/lib/scope";
import { createAgent } from "@/app/dashboard/actions";
import { buttonVariants } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { PassportStoreAndConnect } from "@/components/PassportStoreAndConnect";
import { Plus, KeyRound, Check, ShieldCheck } from "lucide-react";

export function PassportIssuanceModal({
  userId,
  integrations,
  onRevealChange,
}: {
  userId: string;
  integrations: readonly string[];
  /** Fired while the one-time private key is on screen. A parent that renders
   *  this inside a conditional branch must hold that branch open until it clears. */
  onRevealChange?: (revealing: boolean) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const [models, setModels] = useState(DEFAULT_ALLOWED_MODELS.anthropic);
  const [clientModel, setClientModel] = useState(DEFAULT_CLIENT_MODELS.anthropic);
  const [runtime, setRuntime] = useState<"sdk" | "static">("sdk");
  const [tokenBudget, setTokenBudget] = useState("");
  const [costBudgetUsd, setCostBudgetUsd] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [issuedAt, setIssuedAt] = useState<string | null>(null);
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Through a ref so an inline arrow from the parent cannot re-fire the effect on
  // every render.
  const revealRef = useRef(onRevealChange);
  revealRef.current = onRevealChange;
  useEffect(() => {
    revealRef.current?.(Boolean(secret));
  }, [secret]);
  useEffect(() => () => revealRef.current?.(false), []);

  const reset = () => {
    setOpen(false);
    setName("");
    setProvider("anthropic");
    setModels(DEFAULT_ALLOWED_MODELS.anthropic);
    setClientModel(DEFAULT_CLIENT_MODELS.anthropic);
    setRuntime("sdk");
    setTokenBudget("");
    setCostBudgetUsd("");
    setSecret(null);
    setPubkey(null);
    setAgentId(null);
    setIssuedAt(null);
    setStored(false);
    setError(null);
  };

  const issue = async () => {
    setBusy(true);
    setError(null);
    const priv = ed25519.utils.randomPrivateKey();
    try {
      const budget_tokens = parseTokenBudgetInput(tokenBudget);
      const budget_cents = parseUsdBudgetToCents(costBudgetUsd);
      const allowedModels = models.split(",").map((m) => m.trim()).filter(Boolean);
      const concreteModel = clientModel.trim();
      if (runtime !== "sdk") throw new Error("Use a Direct Agent Key for an application that accepts only a static API key.");
      if (!clientModelIsUsable(concreteModel) || !scopeAllows([{ provider, models: allowedModels }], provider, concreteModel)) {
        throw new Error("Model to call must be a concrete provider model id covered by the allowed patterns.");
      }
      const pub = ed25519.getPublicKey(priv);
      const passportId = bytesToBase64url(pub);
      const created = await createAgent({
        name,
        passportPubkey: passportId,
        scopes: [{ provider, models: allowedModels }],
        budget_tokens,
        budget_cents,
      });
      setPubkey(passportId);
      setAgentId(created.agentId);
      setIssuedAt(created.createdAt);
      setSecret(bytesToBase64url(priv)); // shown once, never sent
    } catch (e) {
      setError((e as Error).message || "The passport could not be issued.");
    } finally {
      priv.fill(0);
      setBusy(false);
    }
  };

  const acknowledgeStored = () => {
    if (!stored) return;
    reset();
    router.refresh();
  };

  const labelCls = "grid gap-1 text-sm";
  const labelText = "text-xs uppercase tracking-wide text-muted-foreground";

  return (
    <>
      <button onClick={() => setOpen(true)} className={buttonVariants({ size: "lg" })}>
        <Plus className="h-4 w-4" /> Issue passport
      </button>
      <Dialog
        className="pc-passport-dialog"
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            if (secret && !stored) return;
            if (secret) acknowledgeStored();
            else reset();
            return;
          }
          setOpen(true);
        }}
        title={secret ? "Store the private passport" : "Issue an agent passport"}
        description={
          secret
            ? "This secret exists only in this browser and cannot be retrieved later."
            : "Define the first capability and budget. The signing key is generated locally in your browser."
        }
        preventClose={Boolean(secret && !stored)}
        showClose={!secret}
      >
      <div className="pc-issuance-dialog">
        {!secret ? (
          <>
            <div className="pc-flow-steps" aria-label="Passport issuance progress">
              <span className="is-current"><b>1</b> Capability</span>
              <span className="is-current"><b>2</b> Runtime</span>
              <span><b>3</b> Store &amp; connect</span>
              <span><b>4</b> Verify</span>
            </div>
            <div className="pc-boundary-note">
              <ShieldCheck aria-hidden="true" />
              <span><strong>The private key never crosses the boundary.</strong> Only the public passport ID is sent to PassControl.</span>
            </div>
            <label className={labelCls}>
              <span className={labelText}>Agent name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-summarizer" autoFocus />
            </label>
            <label className={labelCls}>
              <span className={labelText}>Provider</span>
              <select
                value={provider}
                onChange={(e) => {
                  const next = e.target.value as ProviderId;
                  setProvider(next);
                  setModels(DEFAULT_ALLOWED_MODELS[next]);
                  setClientModel(DEFAULT_CLIENT_MODELS[next]);
                }}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              <span className={labelText}>Allowed model patterns</span>
              <input value={models} onChange={(e) => setModels(e.target.value)} />
              <span className="text-xs text-muted-foreground">Allowed model patterns are authorization rules. <code>{DEFAULT_ALLOWED_MODELS[provider]}</code> permits matching models; it is not a model ID the provider can call.</span>
            </label>
            <label className={labelCls}>
              <span className={labelText}>Model to call · exact provider ID</span>
              <input value={clientModel} onChange={(e) => setClientModel(e.target.value)} />
              <span className="text-xs text-muted-foreground">This exact value is sent to the provider. Wildcards are rejected.</span>
            </label>
            <fieldset className="grid gap-2">
              <legend className={labelText}>Runtime integration</legend>
              <label className="rounded-md border border-border bg-secondary/30 p-3 text-sm">
                <input type="radio" className="mr-2 w-auto" checked={runtime === "sdk"} onChange={() => setRuntime("sdk")} />
                <strong>JavaScript / TypeScript application · Passport SDK</strong>
                <span className="mt-1 block text-muted-foreground">Recommended. The SDK signs locally and routes every provider call through PassControl Cloud.</span>
              </label>
              <label className="rounded-md border border-border bg-secondary/30 p-3 text-sm">
                <input type="radio" className="mr-2 w-auto" checked={runtime === "static"} onChange={() => setRuntime("static")} />
                <strong>Application accepts only a base URL and API key</strong>
                <span className="mt-1 block text-muted-foreground">This application cannot sign passport challenges or refresh visas. Use a Direct Agent Key for PassControl Cloud today.</span>
              </label>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={labelCls}>
                <span className={labelText}>Token budget</span>
                <input
                  value={tokenBudget}
                  onChange={(e) => setTokenBudget(e.target.value)}
                  inputMode="numeric"
                  placeholder="Unlimited"
                />
                <span className="text-xs text-muted-foreground">Blank means unlimited.</span>
              </label>
              <label className={labelCls}>
                <span className={labelText}>Cost budget (USD)</span>
                <input
                  value={costBudgetUsd}
                  onChange={(e) => setCostBudgetUsd(e.target.value)}
                  inputMode="decimal"
                  placeholder="Unlimited"
                />
                <span className="text-xs text-muted-foreground">Example: 5.00. Blank means unlimited.</span>
              </label>
            </div>
            {error ? <p role="alert" className="pc-inline-error">{error}</p> : null}
            <div className="flex justify-end gap-3">
              <button
                onClick={reset}
                className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-secondary/80"
              >
                Cancel
              </button>
              <button
                disabled={runtime !== "sdk" || !name.trim() || !models.split(",").some((model) => model.trim()) || !clientModelIsUsable(clientModel) || busy}
                onClick={issue}
                className={buttonVariants({ size: "lg" })}
              >
                <KeyRound aria-hidden="true" />
                {busy ? "Issuing passport…" : "Generate & issue"}
              </button>
            </div>
          </>
        ) : agentId && issuedAt && pubkey ? (
          <>
            <div className="pc-flow-steps" aria-label="Passport issuance progress">
              <span className="is-complete"><b><Check /></b> Capability</span>
              <span className="is-complete"><b><Check /></b> Runtime</span>
              <span className="is-current"><b>3</b> Store &amp; connect</span>
              <span><b>4</b> Verify</span>
            </div>
            <PassportStoreAndConnect
              userId={userId}
              agentId={agentId}
              issuedAt={issuedAt}
              provider={provider}
              model={clientModel.trim()}
              passportId={pubkey}
              passportSecret={secret}
              integrations={integrations}
              stored={stored}
              onStoredChange={setStored}
              onFinish={acknowledgeStored}
            />
          </>
        ) : (
          <p role="alert" className="pc-inline-error">The passport was issued but its setup state could not be loaded.</p>
        )}
      </div>
      </Dialog>
    </>
  );
}
