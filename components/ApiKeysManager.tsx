"use client";
// Developer API keys for the public control-plane API. The full token is shown
// exactly ONCE on creation (we store only its hash). Owners can revoke anytime.
import { useState, useTransition } from "react";
import { createApiKey, revokeApiKey } from "@/app/dashboard/actions";
import { Check, Copy, KeyRound, Plus, ShieldAlert } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { DashboardTimestamp } from "@/components/dashboard/DashboardTime";

export interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  scope: "read" | "write";
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export function ApiKeysManager({ keys }: { keys: ApiKeyRow[] }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [created, setCreated] = useState<string | null>(null); // token shown once
  const [storedAck, setStoredAck] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      setErr(null);
      try {
        const { token } = await createApiKey({ name: name.trim(), scope });
        setName("");
        setStoredAck(false);
        setCopyState("idle");
        setCreated(token);
      } catch (e) {
        setErr((e as Error).message);
      }
    });

  const revoke = (id: string) =>
    start(async () => {
      setErr(null);
      try {
        await revokeApiKey(id);
        setRevokeTarget(null);
      } catch (e) {
        setErr((e as Error).message);
      }
    });

  return (
    <div className="pc-settings-manager">
      {/* Create */}
      <div className="pc-settings-form pc-settings-form--api">
        <label className="pc-field">
          <span>Key name</span>
          <input
            placeholder="ci-pipeline"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <small>Name the workload or person that will hold this key.</small>
        </label>
        <label className="pc-field">
          <span>Permission</span>
          <select value={scope} onChange={(e) => setScope(e.target.value as "read" | "write")}>
            <option value="read">Read · inspect only</option>
            <option value="write">Write · may change controls</option>
          </select>
          <small>{scope === "read" ? "May inspect fleet and activity." : "May mutate the control plane. Grant deliberately."}</small>
        </label>
        <button disabled={!name.trim() || pending} onClick={submit} className="inline-flex items-center gap-1">
          <Plus className="h-4 w-4" /> {pending ? "Creating…" : "Create key"}
        </button>
      </div>
      {err && <p style={{ color: "var(--danger)", margin: 0 }}>{err}</p>}

      {/* Existing keys */}
      {keys.length === 0 ? (
        <div className="pc-empty-state">
          <KeyRound aria-hidden="true" />
          <strong>No control API keys</strong>
          <p>The dashboard does not need one. Create a key only for approved automation.</p>
        </div>
      ) : (
        <div className="pc-table-scroll">
        <table className="pc-data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Scope</th>
              <th>Last used</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.name}</td>
                <td className="mono">{k.key_prefix}…</td>
                <td>{k.scope}</td>
                <td className="muted">
                  {k.last_used_at ? <DashboardTimestamp value={k.last_used_at} kind="date" /> : "Never"}
                </td>
                <td>
                  {k.revoked_at ? (
                    <span style={{ color: "var(--danger)" }}>revoked</span>
                  ) : (
                    <span style={{ color: "var(--green)" }}>active</span>
                  )}
                </td>
                <td>
                  {!k.revoked_at && (
                    <button
                      onClick={() => setRevokeTarget(k)}
                      disabled={pending}
                      className="rounded-md border border-border bg-secondary px-2 py-1 text-xs font-semibold hover:bg-secondary/80"
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {/* Reveal-once modal */}
      <Dialog
        open={Boolean(created)}
        onOpenChange={(open) => {
          if (!open && storedAck) {
            setCreated(null);
            setStoredAck(false);
            setCopyState("idle");
          }
        }}
        title={<span className="inline-flex items-center gap-2"><KeyRound className="h-5 w-5 text-primary" /> Save your API key</span>}
        description="This is the only time the complete key is available."
        preventClose={!storedAck}
        showClose={storedAck}
      >
        {created ? (
          <div className="pc-dialog__body">
            <p className="m-0 text-sm text-muted-foreground">
              Shown <strong className="text-foreground">once</strong>. We store only its hash — you
              can&apos;t retrieve it again. Send it as <code>Authorization: Bearer …</code>.
            </p>
            <pre className="pc-secret-block">
              {created}
            </pre>
            <div className="pc-dialog__actions pc-dialog__actions--spread">
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(created);
                    setCopyState("copied");
                  } catch {
                    setCopyState("failed");
                  }
                }}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold hover:bg-secondary/80"
              >
                {copyState === "copied" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copyState === "copied" ? "Copied" : "Copy key"}
              </button>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={storedAck}
                  onChange={(e) => setStoredAck(e.target.checked)}
                />
                I&apos;ve stored this securely
              </label>
            </div>
            <p className="pc-field-note" role="status" aria-live="polite">
              {copyState === "failed" ? "Clipboard access was blocked. Select and copy the key manually." : copyState === "copied" ? "Copied. Store it in the intended secret manager now." : "Do not paste this key into chat, issue trackers, or source control."}
            </p>
            <div className="pc-dialog__actions">
              <button
                disabled={!storedAck}
                onClick={() => {
                  setCreated(null);
                  setStoredAck(false);
                }}
                className="inline-flex items-center gap-1"
              >
                Done
              </button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={Boolean(revokeTarget)}
        onOpenChange={(open) => { if (!open && !pending) setRevokeTarget(null); }}
        title={<span className="inline-flex items-center gap-2"><ShieldAlert className="h-5 w-5 text-destructive" /> Revoke control API key?</span>}
        description={revokeTarget ? `“${revokeTarget.name}” will stop authorizing future control-plane requests.` : undefined}
        preventClose={pending}
      >
        <div className="pc-dialog__body">
          <p className="m-0 text-sm text-muted-foreground">This cannot be undone. Create a new key if that integration needs access again.</p>
          <div className="pc-dialog__actions">
            <button type="button" className="ghost" disabled={pending} onClick={() => setRevokeTarget(null)}>Keep key</button>
            <button type="button" className="pc-button-danger" disabled={pending || !revokeTarget} onClick={() => revokeTarget && revoke(revokeTarget.id)}>
              {pending ? "Revoking…" : "Revoke key"}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
