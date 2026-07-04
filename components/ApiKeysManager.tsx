"use client";
// Developer API keys for the public control-plane API. The full token is shown
// exactly ONCE on creation (we store only its hash). Owners can revoke anytime.
import { useState, useTransition } from "react";
import { createApiKey, revokeApiKey } from "@/app/dashboard/actions";
import { Copy, KeyRound, Plus } from "lucide-react";

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
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      setErr(null);
      try {
        const { token } = await createApiKey({ name: name.trim(), scope });
        setName("");
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
      } catch (e) {
        setErr((e as Error).message);
      }
    });

  return (
    <div className="grid gap-4">
      {/* Create */}
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input
          placeholder="Key name (e.g. ci-pipeline)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ flex: 1, minWidth: 160 }}
        />
        <select value={scope} onChange={(e) => setScope(e.target.value as "read" | "write")} style={{ width: "auto" }}>
          <option value="read">read</option>
          <option value="write">write</option>
        </select>
        <button disabled={!name.trim() || pending} onClick={submit} className="inline-flex items-center gap-1">
          <Plus className="h-4 w-4" /> {pending ? "Creating…" : "Create key"}
        </button>
      </div>
      {err && <p style={{ color: "var(--danger)", margin: 0 }}>{err}</p>}

      {/* Existing keys */}
      {keys.length === 0 ? (
        <p className="muted">No API keys yet.</p>
      ) : (
        <table>
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
                <td className="muted">{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : "—"}</td>
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
                      onClick={() => revoke(k.id)}
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
      )}

      {/* Reveal-once modal */}
      {created && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60">
          <div className="grid w-[520px] max-w-[90vw] gap-4 rounded-lg border border-border bg-card p-6">
            <h2 className="m-0 flex items-center gap-2 text-lg font-bold">
              <KeyRound className="h-5 w-5 text-primary" /> Save your API key
            </h2>
            <p className="m-0 text-sm text-muted-foreground">
              Shown <strong className="text-foreground">once</strong>. We store only its hash — you
              can&apos;t retrieve it again. Send it as <code>Authorization: Bearer …</code>.
            </p>
            <pre
              className="overflow-x-auto rounded-sm border p-2 text-xs"
              style={{ borderColor: "var(--danger)", background: "rgba(239,68,68,0.08)" }}
            >
              {created}
            </pre>
            <div className="flex items-center justify-between">
              <button
                onClick={() => navigator.clipboard.writeText(created)}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold hover:bg-secondary/80"
              >
                <Copy className="h-4 w-4" /> Copy
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
            <div className="flex justify-end">
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
        </div>
      )}
    </div>
  );
}
