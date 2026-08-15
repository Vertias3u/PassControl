"use client";
// Add a provider API key. The plaintext goes straight to the store_provider_key
// RPC, which writes it into Supabase Vault (encrypted) and keeps only a reference
// row. The key is never stored in an app table and never shown again.
import { useState, useTransition } from "react";
import { addProviderKey } from "@/app/dashboard/actions";
import { PROVIDERS } from "@/lib/providers";
import { CheckCircle2, Eye, EyeOff, LockKeyhole } from "lucide-react";

export function ProviderKeysManager() {
  const [provider, setProvider] = useState("anthropic");
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const submit = () =>
    start(async () => {
      setMsg(null);
      try {
        await addProviderKey({ provider, label: label.trim() || "default", key });
        setKey("");
        setLabel("");
        setMsg({ ok: true, text: "Stored in Vault (encrypted)." });
      } catch (e) {
        setMsg({ ok: false, text: (e as Error).message });
      }
    });

  return (
    <div className="pc-settings-manager">
      <div className="pc-settings-form">
        <div className="pc-settings-form__row">
          <label className="pc-field">
            <span>Provider</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="pc-field">
            <span>Vault label</span>
            <input placeholder="production" value={label} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />
            <small>Use a name that identifies the account or environment.</small>
          </label>
        </div>
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
          <button disabled={!key || pending} onClick={submit}>
            {pending ? "Storing securely…" : "Store in Vault"}
          </button>
        </div>
      </div>
      {msg && (
        <p className={msg.ok ? "pc-inline-notice is-success" : "pc-inline-notice is-danger"} role={msg.ok ? "status" : "alert"}>
          {msg.ok ? <CheckCircle2 aria-hidden="true" /> : null}{msg.text}
        </p>
      )}
    </div>
  );
}
