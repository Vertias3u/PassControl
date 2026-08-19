"use client";
// Provider credentials: add, switch, rotate, delete.
//
// The plaintext goes straight to store_provider_key_for_user, which writes it into
// Supabase Vault and keeps only a reference row. It is never stored in an app
// table and never shown again — so everything below identifies a credential by
// its NICKNAME and its date, and there is nothing here that could render a key.
//
// ── Why the list exists at all ──────────────────────────────────────────────
//
// This panel used to be an add-only form. get_provider_key picked the OLDEST
// credential for a (user, provider) pair, `unique (user_id, provider, label)`
// let a second one exist, and storing only ever INSERTed — so on
// 2026-08-17 an expired Anthropic key could not be replaced through this
// screen at all. Every attempt added another row the gateway would never reach,
// with no list to reveal that and no way to switch or delete. The fix needed SQL
// against the live database. A credential store you cannot see is not a store.
import { useMemo, useState, useTransition } from "react";
import {
  addProviderKey,
  deleteProviderKey,
  rotateProviderKey,
  setActiveProviderKey,
} from "@/app/dashboard/actions";
import { PROVIDERS } from "@/lib/providers";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";

export interface ProviderCredentialSummary {
  id: string;
  provider: string;
  /** The operator's nickname for this credential. Never the secret. */
  label: string | null;
  created_at: string;
  /** The one the gateway injects for this provider. */
  is_active: boolean;
}

type Message = { ok: boolean; text: string } | null;

/** A credential with no label is still identifiable by when it was stored. */
function nickname(credential: ProviderCredentialSummary): string {
  const label = credential.label?.trim();
  if (label) return label;
  return `Unnamed · added ${new Date(credential.created_at).toISOString().slice(0, 10)}`;
}

export function ProviderKeysManager({
  credentials = [],
  listUnavailable = false,
}: {
  credentials?: ProviderCredentialSummary[];
  /** True when the list could not be read — see the settings page for why. */
  listUnavailable?: boolean;
}) {
  const [provider, setProvider] = useState("anthropic");
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [adding, setAdding] = useState(false);
  const [rotating, setRotating] = useState<string | null>(null);
  const [rotateKey, setRotateKey] = useState("");
  const [msg, setMsg] = useState<Message>(null);
  const [pending, start] = useTransition();

  const forProvider = useMemo(
    () =>
      credentials
        .filter((c) => c.provider === provider)
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
    [credentials, provider]
  );
  const active = forProvider.find((c) => c.is_active) ?? null;
  // The warning that would have saved the incident: adding here does NOT replace.
  const duplicate = forProvider.length > 0;

  const run = (work: () => Promise<void>, done: string) =>
    start(async () => {
      setMsg(null);
      try {
        await work();
        setMsg({ ok: true, text: done });
      } catch (e) {
        setMsg({ ok: false, text: (e as Error).message });
      }
    });

  const submitAdd = () =>
    run(async () => {
      await addProviderKey({ provider, label: label.trim() || "default", key });
      setKey("");
      setLabel("");
      setAdding(false);
    }, "Stored in Vault (encrypted).");

  const submitRotate = (credentialId: string) =>
    run(async () => {
      await rotateProviderKey({ credentialId, key: rotateKey });
      setRotateKey("");
      setRotating(null);
    }, "Replaced the secret behind that credential. In effect immediately.");

  return (
    <div className="pc-settings-manager">
      <label className="pc-field">
        <span>Provider</span>
        <select
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setRotating(null);
            setAdding(false);
            setMsg(null);
          }}
        >
          {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <small>Stored credentials are listed by nickname. The keys themselves are in Vault and are never shown.</small>
      </label>

      {listUnavailable ? (
        <p className="pc-inline-notice is-danger" role="alert">
          <AlertTriangle aria-hidden="true" />
          Stored credentials could not be read. You can still add one, but check that migration
          0027 has been applied before relying on this screen.
        </p>
      ) : null}

      <ul className="pc-credential-list" aria-label={`Stored ${provider} credentials`}>
        {forProvider.length === 0 ? (
          <li className="pc-credential-list__empty">
            No {provider} credential stored yet.
          </li>
        ) : (
          forProvider.map((credential) => (
            <li
              key={credential.id}
              className="pc-credential"
              data-state={credential.is_active ? "active" : "idle"}
            >
              <div className="pc-credential__identity">
                <KeyRound aria-hidden="true" />
                <span>
                  <strong>{nickname(credential)}</strong>
                  <small>
                    Added {new Date(credential.created_at).toISOString().slice(0, 10)}
                  </small>
                </span>
                {credential.is_active ? (
                  <span className="pc-credential__badge">In use</span>
                ) : null}
              </div>

              <div className="pc-credential__actions">
                {credential.is_active ? null : (
                  <button
                    type="button"
                    className="ghost"
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => setActiveProviderKey({ credentialId: credential.id }),
                        "The gateway will inject that credential. In effect immediately."
                      )
                    }
                  >
                    <Check aria-hidden="true" /> Use this key
                  </button>
                )}
                <button
                  type="button"
                  className="ghost"
                  disabled={pending}
                  onClick={() => {
                    setRotateKey("");
                    setRotating(rotating === credential.id ? null : credential.id);
                  }}
                >
                  <RefreshCw aria-hidden="true" /> Replace secret
                </button>
                <button
                  type="button"
                  className="ghost"
                  // The database refuses this for the active credential; disabling
                  // it here states the rule before the operator hits it, rather
                  // than letting a deliberate refusal read as a failure.
                  disabled={pending || credential.is_active}
                  title={
                    credential.is_active
                      ? "This is the credential the gateway is using. Switch to another one first."
                      : undefined
                  }
                  onClick={() =>
                    run(
                      () => deleteProviderKey({ credentialId: credential.id }),
                      "Deleted the credential and its Vault secret."
                    )
                  }
                >
                  <Trash2 aria-hidden="true" /> Delete
                </button>
              </div>

              {rotating === credential.id ? (
                <div className="pc-credential__rotate">
                  <label className="pc-field">
                    <span>New secret for “{nickname(credential)}”</span>
                    <input
                      type="password"
                      placeholder="Paste the replacement provider credential"
                      value={rotateKey}
                      onChange={(e) => setRotateKey(e.target.value)}
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                    <small>
                      Replaces the secret behind this nickname. Nothing else changes — the
                      gateway keeps injecting whichever credential is in use.
                    </small>
                  </label>
                  <button
                    disabled={!rotateKey || pending}
                    onClick={() => submitRotate(credential.id)}
                  >
                    {pending ? "Replacing…" : "Replace secret"}
                  </button>
                </div>
              ) : null}
            </li>
          ))
        )}
      </ul>

      {adding ? (
        <div className="pc-settings-form">
          {/* The whole 2026-08-17 failure in one sentence, placed where the
              mistake gets made rather than in documentation nobody re-reads. */}
          {duplicate ? (
            <p className="pc-inline-notice is-warning" role="status">
              <AlertTriangle aria-hidden="true" />
              You already store a {provider} credential
              {active ? ` (“${nickname(active)}” is in use)` : ""}. Adding another does
              <strong> not </strong>
              replace it — the new key sits alongside, and you switch to it explicitly.
              To swap the secret in place, use <em>Replace secret</em> instead.
            </p>
          ) : null}
          <label className="pc-field">
            <span>Nickname</span>
            <input
              placeholder="production"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoComplete="off"
              autoFocus
            />
            <small>How you will recognise this credential here. Not sent to the provider.</small>
          </label>
          <label className="pc-field">
            <span>Provider API key</span>
            <span className="pc-password-field">
              <input
                type={showKey ? "text" : "password"}
                placeholder="Paste the provider credential"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="new-password"
                spellCheck={false}
              />
              <button
                type="button"
                className="pc-password-field__toggle"
                aria-label={showKey ? "Hide provider key" : "Show provider key"}
                aria-pressed={showKey}
                onClick={() => setShowKey((value) => !value)}
              >
                {showKey ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </span>
            <small>The key is encrypted in Supabase Vault and is never shown again.</small>
          </label>
          <div className="pc-settings-form__actions">
            <span><LockKeyhole aria-hidden="true" /> Plaintext exists only for this write.</span>
            <button type="button" className="ghost" disabled={pending} onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button disabled={!key || pending} onClick={submitAdd}>
              {pending ? "Storing securely…" : "Store in Vault"}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="ghost justify-self-start"
          onClick={() => { setMsg(null); setAdding(true); }}
        >
          <Plus aria-hidden="true" /> Add a new {provider} key
        </button>
      )}

      {msg && (
        <p className={msg.ok ? "pc-inline-notice is-success" : "pc-inline-notice is-danger"} role={msg.ok ? "status" : "alert"}>
          {msg.ok ? <CheckCircle2 aria-hidden="true" /> : null}{msg.text}
        </p>
      )}
    </div>
  );
}
