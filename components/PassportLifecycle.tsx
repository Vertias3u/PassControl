"use client";
// Giving a passport an end date, and retiring its key without killing the agent.
//
// Rotation used to be impossible: the only way to retire a compromised key was
// to revoke the agent, which is terminal and takes the id, budgets, audit
// history and receipts with it. So the responsible act cost more than doing
// nothing.
//
// ── What this UI has to be honest about ─────────────────────────────────────
//
// 1. DURING THE GRACE WINDOW, BOTH KEYS WORK. That is the entire point — it is
//    what lets a fleet redeploy without an outage — and it is also a period in
//    which a key the operator has decided to retire still opens the door. Said
//    at the control, with the deadline, not in a doc.
// 2. THE SECRET IS SHOWN ONCE. Generated here, in the browser, exactly as
//    PassportIssuanceModal does for a new agent. It is never sent anywhere: the
//    server action takes the PUBLIC key. Closing the panel loses it.
// 3. EXPIRY IS CHECKED WHEN A VISA IS MINTED, NOT PER CALL. A passport that
//    lapses mid-visa keeps working until that visa runs out. That tail is
//    stated rather than engineered away, because engineering it away would put
//    a database read on the credential path for a check the mint already made.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ed25519 } from "@noble/curves/ed25519";
import { Check, Copy, KeyRound } from "lucide-react";

import { bytesToBase64url } from "@/lib/encoding";
import { MAX_ROTATION_GRACE_S } from "@/lib/passport-limits";
import {
  rotateAgentPassport,
  setAgentPassportExpiry,
} from "@/app/dashboard/agents/[id]/passport-actions";
import { Dialog } from "@/components/ui/dialog";
import { useDashboardTime } from "@/components/dashboard/DashboardTime";
import { ImpactPreview } from "@/components/ImpactPreview";
import {
  prospectiveAgentChange,
  prospectivePassportRotation,
} from "@/lib/impact-preview";

/** Options bounded by what fleet.rotatePassport will actually accept. */
const GRACE_CHOICES = [
  { label: "Immediately", seconds: 0, hint: "The old key stops working the moment you rotate." },
  { label: "1 hour", seconds: 3600, hint: "Long enough to redeploy a service." },
  { label: "24 hours", seconds: 86_400, hint: "Long enough to redeploy a fleet." },
  { label: "7 days", seconds: MAX_ROTATION_GRACE_S, hint: "The longest window allowed." },
] as const;

function Countdown({ until }: { until: string }) {
  const remaining = Date.parse(until) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return null;
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return (
    <span className="font-mono tabular-nums">
      {hours > 0 ? `${hours}h ` : ""}
      {minutes}m
    </span>
  );
}

export function PassportLifecycle({
  agentId,
  status,
  expiresAt,
  previousPassportId,
  previousValidUntil,
  currentPassportId,
  visaTtlSeconds,
}: {
  agentId: string;
  status: string;
  expiresAt: string | null;
  previousPassportId: string | null;
  previousValidUntil: string | null;
  currentPassportId: string;
  visaTtlSeconds: number;
}) {
  const router = useRouter();
  const [editingExpiry, setEditingExpiry] = useState(false);
  const [expiryInput, setExpiryInput] = useState(
    expiresAt ? new Date(expiresAt).toISOString().slice(0, 16) : ""
  );
  const [rotating, setRotating] = useState(false);
  const [grace, setGrace] = useState<number>(3600);
  const [secret, setSecret] = useState<{ id: string; secret: string; until?: string } | null>(null);
  const [secretAck, setSecretAck] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "id" | "secret" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { format } = useDashboardTime();
  const when = (at: string | null): string =>
    at && Number.isFinite(Date.parse(at)) ? format(at) : "not set";

  const active = status === "active";
  // A window only counts as open while its deadline is in the future. The sweep
  // clears these columns after the fact, so between the deadline passing and the
  // next cron run the row still holds a retired key that no longer works —
  // presenting that as an open window would be a lie the row itself invites.
  const windowOpen =
    Boolean(previousPassportId) &&
    Boolean(previousValidUntil) &&
    Date.parse(previousValidUntil ?? "") > Date.now();
  const expired = Boolean(expiresAt) && Date.parse(expiresAt ?? "") <= Date.now();
  const proposedExpiry = expiryInput
    ? new Date(`${expiryInput}:00.000Z`).toISOString()
    : null;
  const expiryPreview = prospectiveAgentChange("expires_at", expiresAt, proposedExpiry);
  const rotationPreview = prospectivePassportRotation(currentPassportId, grace);

  const run = (action: () => Promise<{ ok?: true; error?: string }>, after?: () => void) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.error) setError(result.error);
      else after?.();
    });
  };

  const rotate = () => {
    // Generated in the browser. Only the public half is sent — there is no code
    // path on the server that could produce or receive the private one.
    const priv = ed25519.utils.randomPrivateKey();
    const pub = bytesToBase64url(ed25519.getPublicKey(priv));
    setError(null);
    startTransition(async () => {
      try {
        const result = await rotateAgentPassport(agentId, pub, grace);
        if (result.error) {
          setError(result.error);
          return;
        }
        setSecret({ id: pub, secret: bytesToBase64url(priv), until: result.previousValidUntil });
        setSecretAck(false);
        setCopyState("idle");
        setRotating(false);
      } finally {
        priv.fill(0);
      }
    });
  };

  const saveExpiry = (value: string | null) =>
    run(() => setAgentPassportExpiry(agentId, value), () => setEditingExpiry(false));

  const acknowledgeSecret = () => {
    if (!secretAck) return;
    setSecret(null);
    setSecretAck(false);
    setCopyState("idle");
    router.refresh();
  };

  return (
    <section
      className="grid gap-4 rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6"
      aria-labelledby="passport-lifecycle-heading"
      data-state={expired ? "expired" : windowOpen ? "rotating" : "steady"}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-primary">
            Key lifecycle
          </p>
          <h2 id="passport-lifecycle-heading" className="mt-2 text-lg font-bold text-foreground">
            Expiry and rotation
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
            Rotating retires this passport&rsquo;s key and installs a new one. The agent itself is
            untouched — same id, same budgets, same audit history, same receipts. Revoking is the
            other thing, and it is permanent.
          </p>
        </div>
      </div>

      {/* The secret, once. A native dialog keeps focus here and refuses an
          accidental backdrop/Escape dismissal until storage is acknowledged. */}
      <Dialog
        open={Boolean(secret)}
        onOpenChange={(open) => {
          if (!open && secretAck) {
            acknowledgeSecret();
          }
        }}
        title={<span className="inline-flex items-center gap-2"><KeyRound className="h-5 w-5 text-primary" /> Store the new passport key</span>}
        description="Shown once. Losing it requires another rotation."
        preventClose={!secretAck}
        showClose={secretAck}
      >
        {secret ? (
        <div className="pc-dialog__body" data-state="new-secret">
          <div className="grid gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              PASSPORT_ID (public)
            </span>
            <code className="block break-all rounded-md border border-border bg-secondary px-3 py-2 text-xs">
              {secret.id}
            </code>
            <button
              type="button"
              className="ghost w-fit"
              onClick={async () => {
                try { await navigator.clipboard.writeText(secret.id); setCopyState("id"); }
                catch { setCopyState("failed"); }
              }}
            >
              {copyState === "id" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copyState === "id" ? "Public ID copied" : "Copy public ID"}
            </button>
          </div>
          <div className="grid gap-1">
            <span className="text-xs uppercase tracking-wide" style={{ color: "var(--danger)" }}>
              PASSPORT_SECRET (private — never sent to the gateway)
            </span>
            <code className="pc-secret-block">
              {secret.secret}
            </code>
            <button
              type="button"
              className="ghost w-fit"
              onClick={async () => {
                try { await navigator.clipboard.writeText(secret.secret); setCopyState("secret"); }
                catch { setCopyState("failed"); }
              }}
            >
              {copyState === "secret" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copyState === "secret" ? "Private key copied" : "Copy private key"}
            </button>
          </div>
          <p className="m-0 text-xs leading-5 text-muted-foreground">
            {secret.until && Date.parse(secret.until) > Date.now() ? (
              <>
                The <strong>old key still works until {when(secret.until)}</strong>. Both keys
                authenticate until then, so deploy this one before it passes.
              </>
            ) : (
              <>The old key stopped working immediately. Deploy this one now.</>
            )}
          </p>
          <p className="pc-field-note" role="status" aria-live="polite">
            {copyState === "failed" ? "Clipboard access was blocked. Select and copy the value manually." : "Only the public ID crossed the server boundary. Store the private key in the agent's secret manager."}
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="w-auto" checked={secretAck} onChange={(event) => setSecretAck(event.target.checked)} />
            I have stored the new private key securely
          </label>
          <div className="pc-dialog__actions">
            <button type="button" disabled={!secretAck} onClick={acknowledgeSecret}>
              Done
            </button>
          </div>
        </div>
        ) : null}
      </Dialog>

      {/* An open grace window is the state most worth surfacing: two keys can
          open this door right now. */}
      {windowOpen && previousValidUntil ? (
        <div
          className="rounded-lg border p-4"
          style={{
            borderColor: "var(--warning)",
            background: "color-mix(in srgb, var(--warning) 10%, transparent)",
          }}
          data-state="grace-open"
        >
          <p className="m-0 text-sm font-semibold" style={{ color: "var(--warning)" }}>
            Two keys can authenticate as this agent right now.
          </p>
          <p className="m-0 mt-1 text-xs leading-5 text-muted-foreground">
            The key retired at the last rotation still works for another{" "}
            <Countdown until={previousValidUntil} />, until {when(previousValidUntil)}. That is what
            lets a fleet redeploy without an outage — and it is also a key you have decided to
            retire, still opening the door. It stops working on its own; nothing needs to be run.
          </p>
          <code className="mt-2 block break-all text-xs text-muted-foreground">
            retiring: {previousPassportId}
          </code>
        </div>
      ) : null}

      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-semibold text-foreground">Expires</dt>
          <dd className="mt-1 text-muted-foreground" data-state={expired ? "lapsed" : expiresAt ? "dated" : "never"}>
            {expired ? (
              <span style={{ color: "var(--danger)" }}>
                Lapsed {when(expiresAt)} — this passport can no longer mint a visa.
              </span>
            ) : expiresAt ? (
              when(expiresAt)
            ) : (
              "Never. This passport works until it is revoked."
            )}
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-foreground">Previous key</dt>
          <dd className="mt-1 text-muted-foreground">
            {windowOpen ? `Accepted until ${when(previousValidUntil)}` : "None accepted."}
          </dd>
        </div>
      </dl>

      {editingExpiry ? (
        <form
          className="grid gap-3 rounded-lg border border-border bg-secondary/40 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            saveExpiry(proposedExpiry);
          }}
        >
          <label className="grid gap-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Expires at (UTC)
            </span>
            <input
              type="datetime-local"
              value={expiryInput}
              onChange={(e) => setExpiryInput(e.target.value)}
              className="h-10 max-w-xs rounded-lg border border-border bg-background px-3 text-sm"
            />
          </label>
          <ImpactPreview change={expiryPreview} title="Expiry impact" />
          <p className="m-0 text-xs leading-5 text-muted-foreground">
            Checked when a visa is minted, not on every call — so a passport that lapses mid-visa
            keeps working until that visa runs out, at most{" "}
            {Math.round(visaTtlSeconds / 60)} minutes. To stop an agent now, suspend it.
          </p>
          {error ? (
            <p role="alert" className="m-0 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="ghost"
              disabled={pending}
              onClick={() => {
                setExpiryInput(expiresAt ? new Date(expiresAt).toISOString().slice(0, 16) : "");
                setError(null);
                setEditingExpiry(false);
              }}
            >
              Cancel
            </button>
            {expiresAt ? (
              <button
                type="button"
                className="ghost"
                disabled={pending}
                onClick={() => {
                  setExpiryInput("");
                }}
              >
                Never expire
              </button>
            ) : null}
            <button type="submit" disabled={pending || (!expiryInput && !expiresAt)}>
              {pending ? "Saving…" : expiryInput ? "Save expiry" : "Save — never expire"}
            </button>
          </div>
        </form>
      ) : rotating ? (
        <div className="grid gap-3 rounded-lg border border-border bg-secondary/40 p-4">
          <p className="m-0 text-sm font-semibold text-foreground">
            How long should the current key keep working?
          </p>
          <div className="grid gap-2">
            {GRACE_CHOICES.map((choice) => (
              <label key={choice.seconds} className="flex items-start gap-3 text-sm">
                <input
                  type="radio"
                  name="grace"
                  checked={grace === choice.seconds}
                  onChange={() => setGrace(choice.seconds)}
                  className="mt-1"
                />
                <span>
                  <strong className="text-foreground">{choice.label}</strong>
                  <span className="block text-xs leading-5 text-muted-foreground">
                    {choice.hint}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <ImpactPreview change={rotationPreview} title="Rotation impact" />
          <p className="m-0 text-xs leading-5 text-muted-foreground">
            The new keypair is generated in this browser. Only the public half is sent — the
            gateway never receives a passport private key, and the secret is shown once on this
            screen. <strong>Both keys authenticate until the window closes.</strong> Rotating
            because a key leaked? Choose <strong>Immediately</strong>: any window is a window for
            whoever has it.
          </p>
          {error ? (
            <p role="alert" className="m-0 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="ghost"
              disabled={pending}
              onClick={() => {
                setError(null);
                setRotating(false);
              }}
            >
              Cancel
            </button>
            <button type="button" disabled={pending} onClick={rotate}>
              {pending ? "Rotating…" : "Rotate now"}
            </button>
          </div>
        </div>
      ) : (
        <>
          {error ? (
            <p role="alert" className="m-0 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="ghost" disabled={pending} onClick={() => setEditingExpiry(true)}>
              {expiresAt ? "Change expiry" : "Set an expiry"}
            </button>
            {active ? (
              <button
                type="button"
                disabled={pending || windowOpen}
                onClick={() => setRotating(true)}
                title={
                  windowOpen
                    ? "A previous key is still inside its grace window."
                    : undefined
                }
              >
                Rotate passport key
              </button>
            ) : null}
          </div>
          {!active ? (
            <p className="m-0 text-xs leading-5 text-muted-foreground">
              Only an active passport can be rotated. This one is {status}.
            </p>
          ) : windowOpen ? (
            <p className="m-0 text-xs leading-5 text-muted-foreground">
              Rotating again is blocked while a key is still inside its grace window — there is
              room for one retired key, so a second rotation would cut the first window short and
              lock out whatever is still using it.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
