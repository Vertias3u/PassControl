"use client";
// Passport issuance: the Ed25519 keypair is generated IN THE BROWSER. Only the
// public key is sent to the server. The private key is shown exactly once.
import { useState } from "react";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToBase64url } from "@/lib/encoding";
import { parseTokenBudgetInput, parseUsdBudgetToCents } from "@/lib/budget-input";
import { PROVIDERS, type ProviderId } from "@/lib/providers";
import { createAgent } from "@/app/dashboard/actions";
import { buttonVariants } from "@/components/ui/button";
import { Plus, Copy, KeyRound } from "lucide-react";

const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: "claude-*",
  openai: "gpt-*",
  groq: "llama-*",
  mistral: "mistral-*",
  together: "openai/gpt-oss-*",
  deepseek: "deepseek-*",
};

export function PassportIssuanceModal() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const [models, setModels] = useState(DEFAULT_MODELS.anthropic);
  const [tokenBudget, setTokenBudget] = useState("");
  const [costBudgetUsd, setCostBudgetUsd] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setOpen(false);
    setName("");
    setProvider("anthropic");
    setModels(DEFAULT_MODELS.anthropic);
    setTokenBudget("");
    setCostBudgetUsd("");
    setSecret(null);
    setPubkey(null);
    setStored(false);
  };

  const issue = async () => {
    setBusy(true);
    try {
      const budget_tokens = parseTokenBudgetInput(tokenBudget);
      const budget_cents = parseUsdBudgetToCents(costBudgetUsd);
      const priv = ed25519.utils.randomPrivateKey();
      const pub = ed25519.getPublicKey(priv);
      const passportId = bytesToBase64url(pub);
      await createAgent({
        name,
        passportPubkey: passportId,
        scopes: [{ provider, models: models.split(",").map((m) => m.trim()).filter(Boolean) }],
        budget_tokens,
        budget_cents,
      });
      setPubkey(passportId);
      setSecret(bytesToBase64url(priv)); // shown once, never sent
    } catch (e) {
      alert(`Failed to issue passport: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className={buttonVariants({ size: "sm" })}>
        <Plus className="h-4 w-4" /> Issue passport
      </button>
    );
  }

  const labelCls = "grid gap-1 text-sm";
  const labelText = "text-xs uppercase tracking-wide text-muted-foreground";

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60"
      onClick={(e) => e.target === e.currentTarget && !secret && reset()}
    >
      <div className="grid w-[520px] max-w-[90vw] gap-4 rounded-lg border border-border bg-card p-6">
        {!secret ? (
          <>
            <h2 className="m-0 flex items-center gap-2 text-lg font-bold">
              <KeyRound className="h-5 w-5 text-primary" /> Issue agent passport
            </h2>
            <label className={labelCls}>
              <span className={labelText}>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="prod-summarizer" />
            </label>
            <label className={labelCls}>
              <span className={labelText}>Provider</span>
              <select
                value={provider}
                onChange={(e) => {
                  const next = e.target.value as ProviderId;
                  setProvider(next);
                  setModels(DEFAULT_MODELS[next]);
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
              <span className={labelText}>Allowed models (comma-separated, * wildcard)</span>
              <input value={models} onChange={(e) => setModels(e.target.value)} />
            </label>
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
            <div className="flex justify-end gap-3">
              <button
                onClick={reset}
                className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-secondary/80"
              >
                Cancel
              </button>
              <button disabled={!name || busy} onClick={issue} className={buttonVariants({ size: "sm" })}>
                {busy ? "Generating…" : "Generate keypair"}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="m-0 text-lg font-bold">Save your passport private key</h2>
            <p className="m-0 text-sm text-muted-foreground">
              Shown <strong className="text-foreground">once</strong> and never sent to our servers.
              Store it in your agent&apos;s runtime as its passport.
            </p>
            <div className="grid gap-1">
              <span className={labelText}>Passport ID (public)</span>
              <pre className="overflow-x-auto rounded-sm border border-border bg-secondary p-2 text-xs">{pubkey}</pre>
            </div>
            <div className="grid gap-1">
              <span className={labelText} style={{ color: "var(--danger)" }}>Private key (secret)</span>
              <pre
                className="overflow-x-auto rounded-sm border p-2 text-xs"
                style={{ borderColor: "var(--danger)", background: "rgba(239,68,68,0.08)" }}
              >
                {secret}
              </pre>
            </div>
            <div className="flex items-center justify-between">
              <button
                onClick={() => navigator.clipboard.writeText(secret)}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold text-foreground hover:bg-secondary/80"
              >
                <Copy className="h-4 w-4" /> Copy private key
              </button>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={stored}
                  onChange={(e) => setStored(e.target.checked)}
                />
                I&apos;ve stored this securely
              </label>
            </div>
            <div className="flex justify-end">
              <button disabled={!stored} onClick={reset} className={buttonVariants({ size: "sm" })}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
