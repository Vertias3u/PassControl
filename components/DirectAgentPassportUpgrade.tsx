"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, KeyRound, ShieldCheck } from "lucide-react";
import { ed25519 } from "@noble/curves/ed25519";

import { attachAgentPassport } from "@/app/dashboard/actions";
import { bytesToBase64url } from "@/lib/encoding";
import { buttonVariants } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

export function DirectAgentPassportUpgrade({ agentId, agentName }: { agentId: string; agentName: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [passportId, setPassportId] = useState<string | null>(null);
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    setSecret(null);
    setPassportId(null);
    setStored(false);
    setCopied(false);
    setError(null);
    router.refresh();
  };

  const attach = async () => {
    setBusy(true);
    setError(null);
    const privateKey = ed25519.utils.randomPrivateKey();
    try {
      const publicId = bytesToBase64url(ed25519.getPublicKey(privateKey));
      await attachAgentPassport(agentId, publicId);
      setPassportId(publicId);
      setSecret(bytesToBase64url(privateKey));
    } catch (caught) {
      setError((caught as Error).message || "The signing passport could not be attached.");
    } finally {
      privateKey.fill(0);
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className={buttonVariants({ variant: "outline" })} onClick={() => setOpen(true)}>
        <ShieldCheck aria-hidden="true" className="h-4 w-4" /> Add signing passport
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            if (secret && !stored) return;
            close();
          } else setOpen(true);
        }}
        title={secret ? "Store the private passport" : `Add signing proof to ${agentName}`}
        description={
          secret
            ? "This private key was generated in your browser and cannot be retrieved later."
            : "Upgrade this same agent identity to challenge-response authentication without replacing its history, policy, budgets, or keys."
        }
        preventClose={Boolean(secret && !stored)}
        showClose={!secret}
      >
        <div className="grid gap-4">
          {!secret ? (
            <>
              <div className="rounded-xl border border-primary/25 bg-primary/8 p-4 text-sm leading-6">
                <strong>Nothing is migrated or recreated.</strong>
                <p className="mt-1 text-muted-foreground">Existing Direct Agent Keys keep working until revoked. Passport signing becomes an additional, higher-assurance way for this same agent to authenticate.</p>
              </div>
              <div className="rounded-xl border border-border bg-secondary/35 p-4 text-sm leading-6">
                <p className="m-0"><strong>The private key never reaches PassControl.</strong> Only the public passport ID is attached to the existing agent row.</p>
              </div>
              {error ? <p role="alert" className="pc-inline-error">{error}</p> : null}
              <div className="flex justify-end gap-3">
                <button type="button" className="ghost" onClick={close}>Cancel</button>
                <button type="button" className={buttonVariants()} disabled={busy} onClick={attach}>
                  <KeyRound aria-hidden="true" className="h-4 w-4" /> {busy ? "Generating…" : "Generate and attach"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="pc-secret-warning"><strong>Shown once.</strong><span>Store the private key in the agent&apos;s private runtime.</span></div>
              <div className="grid gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Passport ID · public</span>
                <pre className="pc-secret-block is-public whitespace-pre-wrap break-all">{passportId}</pre>
              </div>
              <div className="grid gap-1.5">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-danger">Passport private key</span>
                <pre className="pc-secret-block is-secret whitespace-pre-wrap break-all">{secret}</pre>
              </div>
              <button
                type="button"
                className="ghost justify-self-start"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(secret);
                    setCopied(true);
                  } catch {
                    setError("Clipboard access was blocked. Select and copy the key manually.");
                  }
                }}
              >
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />} {copied ? "Copied" : "Copy private key"}
              </button>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 w-auto" checked={stored} onChange={(event) => setStored(event.target.checked)} />
                <span>I&apos;ve stored this private key securely</span>
              </label>
              {error ? <p role="alert" className="pc-inline-error">{error}</p> : null}
              <div className="flex justify-end"><button type="button" className={buttonVariants()} disabled={!stored} onClick={close}>Done</button></div>
            </>
          )}
        </div>
      </Dialog>
    </>
  );
}
