"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, KeyRound, Plus, ShieldOff } from "lucide-react";

import { issueDirectAgentKey, revokeDirectAgentKey } from "@/app/dashboard/actions";
import type { AgentAccessKeyView } from "@/app/dashboard/agents/[id]/passport-data";
import { useDashboardTime } from "@/components/dashboard/DashboardTime";
import { buttonVariants } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

function keyState(key: AgentAccessKeyView): "active" | "expired" | "revoked" {
  if (key.revokedAt) return "revoked";
  if (key.expiresAt && Date.parse(key.expiresAt) <= Date.now()) return "expired";
  return "active";
}

export function DirectAgentKeyPanel({
  agentId,
  agentName,
  status,
  keys,
}: {
  agentId: string;
  agentName: string;
  status: string;
  keys: AgentAccessKeyView[];
}) {
  const router = useRouter();
  const { format, zoneLabel } = useDashboardTime();
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [issued, setIssued] = useState<{ keyId: string; key: string; name: string; expiresAt: string | null } | null>(null);
  const [stored, setStored] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<AgentAccessKeyView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const closeCreate = () => {
    setCreateOpen(false);
    setName("");
    setExpiresAt("");
    setIssued(null);
    setStored(false);
    setCopied(false);
    setError(null);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setIssued(await issueDirectAgentKey(agentId, {
        name,
        expiresAt: expiresAt ? new Date(`${expiresAt}T23:59:59`).toISOString() : null,
      }));
    } catch (caught) {
      setError((caught as Error).message || "This credential could not be created.");
    } finally {
      setBusy(false);
    }
  };

  const acknowledgeIssued = () => {
    if (!stored) return;
    closeCreate();
    router.refresh();
  };

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    setError(null);
    try {
      await revokeDirectAgentKey(agentId, revoking.id);
      setRevoking(null);
    } catch (caught) {
      setError((caught as Error).message || "This credential could not be revoked.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-5 rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6" aria-labelledby="direct-agent-keys-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-primary">Installation credentials</p>
          <h2 id="direct-agent-keys-heading" className="mt-2 text-lg font-bold">Direct Agent Keys</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Give each laptop, server, or CI runner its own named key. Revocation takes effect on its next request; provider keys remain inside PassControl.
          </p>
        </div>
        <button type="button" className={buttonVariants()} disabled={status === "revoked"} onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden="true" className="h-4 w-4" /> New installation key
        </button>
      </div>

      {keys.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-secondary/25 p-5" data-state="empty">
          <strong className="text-sm">No Direct Agent Keys</strong>
          <p className="mt-1 text-sm text-muted-foreground">This agent may still use a signed passport. Create a key only for an OpenAI-compatible bearer-key integration.</p>
        </div>
      ) : (
        <ul className="m-0 grid list-none gap-3 p-0">
          {keys.map((key) => {
            const state = keyState(key);
            return (
              <li key={key.id} className="flex flex-col gap-4 rounded-xl border border-border bg-secondary/30 p-4 sm:flex-row sm:items-center sm:justify-between" data-state={state}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong className="break-words text-sm">{key.name}</strong>
                    <span className="rounded-full border border-border px-2 py-0.5 text-[0.68rem] font-bold uppercase tracking-[0.1em] text-muted-foreground">{state}</span>
                  </div>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">pc_agent_…{key.suffix}</p>
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    Created {format(key.createdAt)} · Last stored call {key.lastUsedAt ? format(key.lastUsedAt) : "never"} · {key.recordedCalls.toLocaleString()} recorded {key.recordedCalls === 1 ? "call" : "calls"} · {zoneLabel}
                  </p>
                  {key.expiresAt ? <p className="mt-1 text-xs text-muted-foreground">Expires {format(key.expiresAt)}</p> : null}
                </div>
                {state === "active" ? (
                  <button type="button" className="ghost shrink-0 text-danger" onClick={() => setRevoking(key)}>
                    <ShieldOff aria-hidden="true" className="h-4 w-4" /> Revoke
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <p className="m-0 text-xs leading-5 text-muted-foreground">
        Last use is derived from immutable <code>agent_logs</code>. It is not a mutable timestamp on the credential row, so an absent audit record stays visibly absent.
      </p>

      <Dialog
        open={createOpen}
        onOpenChange={(next) => {
          if (!next) {
            if (issued && !stored) return;
            if (issued) acknowledgeIssued();
            else closeCreate();
          } else setCreateOpen(true);
        }}
        title={issued ? "Store the Direct Agent Key" : `Add an installation for ${agentName}`}
        description={issued ? "This raw credential cannot be retrieved later." : "Use a separate named key for every place this agent runs."}
        preventClose={Boolean(issued && !stored)}
        showClose={!issued}
      >
        <div className="grid gap-4">
          {!issued ? (
            <>
              <label className="grid gap-1.5 text-sm">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Installation name</span>
                <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Production CI" autoFocus />
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Optional expiry</span>
                <input type="date" min={new Date().toISOString().slice(0, 10)} value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} />
                <span className="text-xs text-muted-foreground">Blank means no scheduled expiry. Revocation remains available at any time.</span>
              </label>
              {error ? <p role="alert" className="pc-inline-error">{error}</p> : null}
              <div className="flex justify-end gap-3">
                <button type="button" className="ghost" onClick={closeCreate}>Cancel</button>
                <button type="button" className={buttonVariants()} disabled={busy || !name.trim()} onClick={create}>
                  <KeyRound aria-hidden="true" className="h-4 w-4" /> {busy ? "Creating…" : "Create key"}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="pc-secret-warning"><strong>Shown once.</strong><span>Store this only in the intended installation.</span></div>
              <pre className="pc-secret-block is-secret whitespace-pre-wrap break-all">{issued.key}</pre>
              <button
                type="button"
                className="ghost justify-self-start"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(issued.key);
                    setCopied(true);
                  } catch {
                    setError("Clipboard access was blocked. Select and copy the key manually.");
                  }
                }}
              >
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />} {copied ? "Copied" : "Copy key"}
              </button>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 w-auto" checked={stored} onChange={(event) => setStored(event.target.checked)} />
                <span>I&apos;ve stored this key securely</span>
              </label>
              {error ? <p role="alert" className="pc-inline-error">{error}</p> : null}
              <div className="flex justify-end"><button type="button" className={buttonVariants()} disabled={!stored} onClick={acknowledgeIssued}>Done</button></div>
            </>
          )}
        </div>
      </Dialog>

      <Dialog
        open={Boolean(revoking)}
        onOpenChange={(next) => { if (!next && !busy) setRevoking(null); }}
        title="Revoke this Direct Agent Key?"
        description="This installation will be refused on its next request. Existing stored call records remain intact."
      >
        <div className="grid gap-4">
          <div className="rounded-xl border border-danger/30 bg-danger/8 p-4 text-sm">
            <strong>{revoking?.name}</strong>
            <p className="mt-1 font-mono text-xs text-muted-foreground">pc_agent_…{revoking?.suffix}</p>
          </div>
          {error ? <p role="alert" className="pc-inline-error">{error}</p> : null}
          <div className="flex justify-end gap-3">
            <button type="button" className="ghost" disabled={busy} onClick={() => setRevoking(null)}>Cancel</button>
            <button type="button" className="danger" disabled={busy} onClick={revoke}>{busy ? "Revoking…" : "Revoke key"}</button>
          </div>
        </div>
      </Dialog>
    </section>
  );
}
