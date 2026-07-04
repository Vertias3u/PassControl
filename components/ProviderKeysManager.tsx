"use client";
// Add a provider API key. The plaintext goes straight to the store_provider_key
// RPC, which writes it into Supabase Vault (encrypted) and keeps only a reference
// row. The key is never stored in an app table and never shown again.
import { useState, useTransition } from "react";
import { addProviderKey } from "@/app/dashboard/actions";

export function ProviderKeysManager() {
  const [provider, setProvider] = useState("anthropic");
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
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
    <div className="grid" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          style={{ width: "auto" }}
        >
          <option value="anthropic">anthropic</option>
          <option value="openai">openai</option>
        </select>
        <input
          placeholder="label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          style={{ flex: 1, minWidth: 120 }}
        />
      </div>
      <input
        type="password"
        placeholder="Provider API key (e.g. sk-ant-…)"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        autoComplete="off"
      />
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="muted">Encrypted in Supabase Vault — never shown again.</span>
        <button disabled={!key || pending} onClick={submit}>
          {pending ? "Storing…" : "Add key"}
        </button>
      </div>
      {msg && (
        <p style={{ color: msg.ok ? "var(--green)" : "var(--red)", margin: 0 }}>{msg.text}</p>
      )}
    </div>
  );
}
