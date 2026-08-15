"use client";

import { useState, useTransition } from "react";
import { Download, Trash2, TriangleAlert } from "lucide-react";
import { deleteAccount } from "@/app/dashboard/settings/account-actions";

export function AccountLifecycle() {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const remove = () => start(async () => {
    setError(null);
    const result = await deleteAccount(confirmation);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    window.location.assign("/login?deleted=1");
  });

  return (
    <div className="pc-account-lifecycle">
      <div className="pc-account-lifecycle__row">
        <div>
          <strong>Download your data</strong>
          <p>Export account settings, agent configuration, call metadata, receipts and audit history as JSON. Secret values and hashes are never included.</p>
        </div>
        <a className="pc-account-lifecycle__export" href="/api/account/export">
          <Download aria-hidden="true" /> Download JSON
        </a>
      </div>

      <div className="pc-account-lifecycle__row is-danger">
        <div>
          <strong>Delete this account</strong>
          <p>Erase agents, logs, audit history, stored provider credentials and operator access. This cannot be undone.</p>
        </div>
        {!open && (
          <button type="button" onClick={() => setOpen(true)}>
            <Trash2 aria-hidden="true" /> Delete account…
          </button>
        )}
      </div>

      {open && (
        <div className="pc-account-lifecycle__confirm" data-state={pending ? "deleting" : "ready"}>
          <TriangleAlert aria-hidden="true" />
          <div>
            <strong>Permanent deletion</strong>
            <p>Download an export first if you need one. Then type <code>DELETE MY ACCOUNT</code> exactly.</p>
            <label className="pc-field">
              <span>Confirmation phrase</span>
              <input
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <div className="pc-account-lifecycle__actions">
              <button type="button" onClick={() => { setOpen(false); setConfirmation(""); setError(null); }} disabled={pending}>Cancel</button>
              <button type="button" className="is-danger" onClick={remove} disabled={pending || confirmation !== "DELETE MY ACCOUNT"}>
                {pending ? "Deleting permanently…" : "Permanently delete account"}
              </button>
            </div>
            {error && <p className="pc-inline-notice is-danger" role="alert">{error}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
