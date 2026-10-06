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
  setProviderEndpoint,
} from "@/app/dashboard/actions-client";
import { PROVIDERS, isProvider, providerRequiresEndpoint, offeredProviders } from "@/lib/providers";
import { useLocalModelsEnabled } from "@/components/dashboard/LocalModels";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  LockKeyhole,
  Globe,
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
  /** Where this credential is sent, or null for the provider's own host. */
  endpoint_base_url?: string | null;
}

type Message = { ok: boolean; text: string } | null;

const AZURE_ENDPOINT_PLACEHOLDER = "https://<resource>.openai.azure.com/openai/v1";
const LOCAL_ENDPOINT_PLACEHOLDER = "http://localhost:11434/v1";

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
  // `local` only where this deployment can reach it (components/dashboard/LocalModels.tsx).
  const localModels = useLocalModelsEnabled();
  const [provider, setProvider] = useState("anthropic");
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [adding, setAdding] = useState(false);
  const [rotating, setRotating] = useState<string | null>(null);
  const [rotateKey, setRotateKey] = useState("");
  const [routing, setRouting] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState("");
  // Only for a provider with no host of its own (Azure): the address is part of
  // the credential, so it is asked for with the key rather than afterwards.
  const [newEndpoint, setNewEndpoint] = useState("");
  const needsEndpoint = isProvider(provider) && providerRequiresEndpoint(provider);
  // A local server usually takes no key; an empty one is stored as "send none".
  const keyOptional = provider === "local";
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
      await addProviderKey({
        provider,
        label: label.trim() || "default",
        key,
        ...(needsEndpoint ? { endpoint: newEndpoint } : {}),
      });
      setKey("");
      setLabel("");
      setNewEndpoint("");
      setAdding(false);
    }, "Stored in Vault (encrypted). Not tested yet — PassControl does not call the provider to check it; the first governed call through it is the test.");

  const submitRotate = (credentialId: string) =>
    run(async () => {
      await rotateProviderKey({ credentialId, key: rotateKey });
      setRotateKey("");
      setRotating(null);
    }, "Replaced the secret behind that credential for every agent that uses it. Cached copies are cleared; any that are missed expire within a minute.");

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
          {/* A provider with a stored credential stays listed whatever the gate
              says, so turning local models off never hides a credential its
              owner can no longer see to delete. */}
          {offeredProviders(PROVIDERS, localModels, [provider, ...credentials.map((c) => c.provider)]).map((p) => <option key={p} value={p}>{p}</option>)}
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
                  <small data-credential-check="stored-not-tested">
                    Added {new Date(credential.created_at).toISOString().slice(0, 10)} · stored, not tested by
                    PassControl
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
                        // Workspace-wide, not agent-local, and the propagation is
                        // bounded rather than instant: cached copies are purged
                        // best-effort, and one that is missed expires within a minute.
                        `Every agent in this workspace that calls ${credential.provider} now uses this credential. Cached copies are cleared; any that are missed expire within a minute.`
                      )
                    }
                  >
                    <Check aria-hidden="true" /> Use this key for every {credential.provider} agent
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
                  disabled={pending}
                  onClick={() => {
                    setEndpoint(credential.endpoint_base_url ?? "");
                    setRouting(routing === credential.id ? null : credential.id);
                  }}
                >
                  <Globe aria-hidden="true" /> Endpoint
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

              {/* Where this credential is SENT, which is a different question
                  from which credential is used — and the more consequential of
                  the two, so it says what it means rather than showing a bare
                  field. Absent from the row until it is opened, because for
                  almost everyone the answer is "the provider", and a form for a
                  thing nobody needs is a form somebody fills in by accident. */}
              {routing === credential.id ? (
                <div className="pc-credential__rotate" data-panel="endpoint">
                  <label className="pc-field">
                    <span>
                      {credential.provider === "azure"
                        ? "Resource address"
                        : credential.provider === "local"
                          ? "Server address"
                          : "Base URL"}
                    </span>
                    <input
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                      placeholder={
                        credential.provider === "azure"
                          ? AZURE_ENDPOINT_PLACEHOLDER
                          : credential.provider === "local"
                            ? LOCAL_ENDPOINT_PLACEHOLDER
                            : `https://api.${credential.provider}.example/v1`
                      }
                      spellCheck={false}
                    />
                  </label>
                  {credential.provider === "azure" ? (
                    <p className="m-0 text-xs leading-5 text-muted-foreground" data-endpoint-copy="azure">
                      The Azure OpenAI resource this key belongs to. Calls through it are recorded
                      with their token counts but <strong>no calculated cost</strong>, because a
                      deployment name does not say which model, or which price, is behind it. An
                      Azure key always needs this address, so it cannot be cleared.
                    </p>
                  ) : credential.provider === "local" ? (
                    <p className="m-0 text-xs leading-5 text-muted-foreground" data-endpoint-copy="local">
                      The OpenAI-compatible server on your machine or network, with its version
                      segment: <code>http://localhost:11434/v1</code> for Ollama,{" "}
                      <code>http://localhost:1234/v1</code> for LM Studio. Calls are recorded with their
                      token counts and no cost. A local credential always needs an address.
                    </p>
                  ) : (
                  <p className="m-0 text-xs leading-5 text-muted-foreground">
                    Sends this credential to your own server instead of{" "}
                    {credential.provider}&rsquo;s. The endpoint must speak{" "}
                    {credential.provider}&rsquo;s API — changing where a call goes does not
                    change what it says — and calls made through it are recorded with their
                    token counts but <strong>no calculated cost</strong>, because we cannot know
                    what your server charges. That is unknown, not free: your server may still
                    bill for them. Leave it empty to go back to {credential.provider}.
                  </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        run(
                          () =>
                            setProviderEndpoint({
                              credentialId: credential.id,
                              endpoint,
                            }),
                          credential.provider === "azure"
                            ? "This key now goes to that Azure resource."
                            : credential.provider === "local"
                            ? "This credential now goes to that server."
                            : endpoint.trim()
                              ? "This credential now goes to your endpoint."
                              : `This credential goes to ${credential.provider} again.`
                        );
                        setRouting(null);
                      }}
                    >
                      Save endpoint
                    </button>
                    <button type="button" className="ghost" onClick={() => setRouting(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : null}

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
            <span>{keyOptional ? "API key (optional)" : "Provider API key"}</span>
            <span className="pc-password-field">
              <input
                type={showKey ? "text" : "password"}
                placeholder={keyOptional ? "Leave empty for Ollama or LM Studio" : "Paste the provider credential"}
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
          {needsEndpoint && keyOptional ? (
            <label className="pc-field" data-field="local-endpoint">
              <span>Server address</span>
              <input
                placeholder={LOCAL_ENDPOINT_PLACEHOLDER}
                value={newEndpoint}
                onChange={(e) => setNewEndpoint(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <small>
                Your OpenAI-compatible server, ending in its version segment (usually{" "}
                <code>/v1</code>). Calls through it have no calculated cost, so an agent with a dollar
                limit cannot use it.
              </small>
            </label>
          ) : needsEndpoint ? (
            <label className="pc-field" data-field="azure-endpoint">
              <span>Resource address</span>
              <input
                placeholder={AZURE_ENDPOINT_PLACEHOLDER}
                value={newEndpoint}
                onChange={(e) => setNewEndpoint(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <small>
                Your Azure OpenAI resource, ending in <code>/openai/v1</code>. An Azure key is
                only ever sent here. Calls through it have no calculated cost, so an agent with a
                dollar limit cannot use it.
              </small>
            </label>
          ) : null}
          <div className="pc-settings-form__actions">
            <span><LockKeyhole aria-hidden="true" /> Plaintext exists only for this write.</span>
            <button type="button" className="ghost" disabled={pending} onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button disabled={(!key && !keyOptional) || (needsEndpoint && !newEndpoint.trim()) || pending} onClick={submitAdd}>
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
