"use client";
// Settings → Services: the workspace's tokens for non-LLM APIs (any-API, 0074).
//
// Deliberately separate from ProviderKeysManager rather than a new entry in its
// provider dropdown. A GitHub token is not a provider key: it has no endpoint,
// no model, no failover, and holding one grants an agent nothing — access is
// set per agent, by method and path, on the agent's page. Listing it among the
// LLM keys would suggest otherwise.
import { useState, useTransition } from "react";
import { CheckCircle2, Eye, EyeOff, KeyRound, LockKeyhole, Plus, RefreshCw, Trash2, Check } from "lucide-react";
import { deleteProviderKey, rotateProviderKey, setActiveProviderKey } from "@/app/dashboard/actions-client";
import { addServiceToken } from "@/app/dashboard/service-actions";
import type { ProviderCredentialSummary } from "@/components/ProviderKeysManager";
import { ServiceLogo } from "@/components/ServiceLogo";

type Message = { ok: boolean; text: string } | null;

// Where an operator gets a token, and what one looks like. Pointers only:
// PassControl never fetches either page.
const TOKEN_SOURCE: Record<string, { placeholder: string; href: string; text: string }> = {
  github: {
    placeholder: "github_pat_…",
    href: "https://github.com/settings/personal-access-tokens/new",
    text: "Create a fine-grained token on GitHub",
  },
  telegram: {
    placeholder: "123456789:AA…",
    href: "https://t.me/BotFather",
    text: "Create a bot with BotFather",
  },
};

function nickname(credential: ProviderCredentialSummary): string {
  const label = credential.label?.trim();
  if (label) return label;
  return `Unnamed · added ${new Date(credential.created_at).toISOString().slice(0, 10)}`;
}

export function ServiceTokensManager({
  service,
  serviceLabel,
  tokens,
  listUnavailable = false,
  hint,
}: {
  /** What a good token for this service looks like. GitHub's when omitted. */
  hint?: string;
  service: string;
  serviceLabel: string;
  /** This workspace's rows for `svc:<service>`, metadata only. */
  tokens: ProviderCredentialSummary[];
  listUnavailable?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [rotating, setRotating] = useState<string | null>(null);
  const [rotateToken, setRotateToken] = useState("");
  const [msg, setMsg] = useState<Message>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const sorted = [...tokens].sort((a, b) => b.created_at.localeCompare(a.created_at));
  // Mirrors the database's rule (0075): the token in use can be deleted only
  // when it is the only one — then there is nothing to promote in its place.
  const deleteKind = (credential: ProviderCredentialSummary): "idle" | "last" | "switch-first" =>
    !credential.is_active ? "idle" : sorted.length === 1 ? "last" : "switch-first";

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
    start(async () => {
      setMsg(null);
      const result = await addServiceToken({ service, label: label.trim(), token });
      if (result.error) {
        setMsg({ ok: false, text: result.error });
        return;
      }
      setToken("");
      setLabel("");
      setAdding(false);
      setMsg({ ok: true, text: result.notice ?? "Stored in Vault." });
    });

  return (
    <div className="pc-settings-manager" data-service={service}>
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <ServiceLogo service={service} />
        {serviceLabel}
      </h3>
      {listUnavailable ? (
        <p className="pc-inline-notice is-danger" role="alert">
          Stored {serviceLabel} tokens could not be read.
        </p>
      ) : null}

      <ul className="pc-credential-list" aria-label={`Stored ${serviceLabel} tokens`}>
        {sorted.length === 0 ? (
          <li className="pc-credential-list__empty" data-service-tokens="none">
            No {serviceLabel} token stored yet. Agents cannot reach {serviceLabel} through PassControl until
            one is, and then only through the rules you set on each agent.
          </li>
        ) : (
          sorted.map((credential) => (
            <li
              key={credential.id}
              className="pc-credential"
              data-state={credential.is_active ? "active" : "idle"}
              data-service-token={credential.id}
            >
              <div className="pc-credential__identity">
                <KeyRound aria-hidden="true" />
                <span>
                  <strong>{nickname(credential)}</strong>
                  <small>
                    Added {new Date(credential.created_at).toISOString().slice(0, 10)} · stored, not tested by
                    PassControl
                  </small>
                </span>
                {credential.is_active ? <span className="pc-credential__badge">In use</span> : null}
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
                        `Every agent's ${serviceLabel} calls now use this token.`
                      )
                    }
                  >
                    <Check aria-hidden="true" /> Use this token
                  </button>
                )}
                <button
                  type="button"
                  className="ghost"
                  disabled={pending}
                  onClick={() => {
                    setRotateToken("");
                    setRotating(rotating === credential.id ? null : credential.id);
                  }}
                >
                  <RefreshCw aria-hidden="true" /> Replace token
                </button>
                <button
                  type="button"
                  className="ghost"
                  data-action="delete-service-token"
                  data-delete-kind={deleteKind(credential)}
                  disabled={pending || deleteKind(credential) === "switch-first"}
                  title={
                    deleteKind(credential) === "switch-first"
                      ? "This is the token the gateway is using. Add and switch to another one first."
                      : undefined
                  }
                  onClick={() => {
                    if (deleteKind(credential) === "last") {
                      setMsg(null);
                      setConfirmingDelete(credential.id);
                      return;
                    }
                    run(
                      () => deleteProviderKey({ credentialId: credential.id }),
                      "Deleted the token and its Vault secret."
                    );
                  }}
                >
                  <Trash2 aria-hidden="true" /> Delete
                </button>
              </div>
              {confirmingDelete === credential.id ? (
                <div className="pc-settings-form" data-confirm="delete-last-service-token" role="alert">
                  <p className="pc-inline-notice is-danger">
                    This is your only {serviceLabel} token. Once it is deleted, every agent&apos;s{" "}
                    {serviceLabel} calls are refused until you store a token again. Revoke it at{" "}
                    {serviceLabel} too if it may have leaked.
                  </p>
                  <div className="pc-settings-form__actions">
                    <button type="button" className="ghost" disabled={pending} onClick={() => setConfirmingDelete(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      disabled={pending}
                      data-action="confirm-delete-last-service-token"
                      onClick={() =>
                        run(async () => {
                          await deleteProviderKey({ credentialId: credential.id });
                          setConfirmingDelete(null);
                        }, `Deleted. ${serviceLabel} calls are refused until a token is stored again.`)
                      }
                    >
                      Delete the token
                    </button>
                  </div>
                </div>
              ) : null}
              {rotating === credential.id ? (
                <div className="pc-settings-form">
                  <label className="pc-field">
                    <span>New {serviceLabel} token</span>
                    <input
                      type="password"
                      value={rotateToken}
                      onChange={(e) => setRotateToken(e.target.value)}
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                    <small>Replaces the secret in place. The very next call uses it: service tokens are not cached.</small>
                  </label>
                  <div className="pc-settings-form__actions">
                    <button type="button" className="ghost" disabled={pending} onClick={() => setRotating(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!rotateToken.trim() || pending}
                      onClick={() =>
                        run(async () => {
                          await rotateProviderKey({ credentialId: credential.id, key: rotateToken.trim() });
                          setRotateToken("");
                          setRotating(null);
                        }, "Replaced. The next call uses the new token.")
                      }
                    >
                      Replace in Vault
                    </button>
                  </div>
                </div>
              ) : null}
            </li>
          ))
        )}
      </ul>

      {adding ? (
        <div className="pc-settings-form" data-form="add-service-token">
          <label className="pc-field">
            <span>Nickname</span>
            <input
              placeholder="ci-readonly"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoComplete="off"
              autoFocus
            />
            <small>How you will recognise this token here. Not sent to {serviceLabel}.</small>
          </label>
          <label className="pc-field">
            <span>{serviceLabel} token</span>
            <span className="pc-password-field">
              <input
                type={showToken ? "text" : "password"}
                placeholder={TOKEN_SOURCE[service]?.placeholder ?? ""}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="new-password"
                spellCheck={false}
              />
              <button
                type="button"
                className="pc-password-field__toggle"
                aria-label={showToken ? "Hide token" : "Show token"}
                aria-pressed={showToken}
                onClick={() => setShowToken((value) => !value)}
              >
                {showToken ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
              </button>
            </span>
            <small>
              {hint ??
                "Use a fine-grained token limited to the repositories your agents need, read-only unless an agent needs a write."}{" "}
              It is the ceiling; each agent&apos;s rules are the floor. Encrypted in Supabase Vault and never shown again.
              {TOKEN_SOURCE[service] ? (
                <>
                  {" "}
                  <a href={TOKEN_SOURCE[service]!.href} target="_blank" rel="noopener noreferrer" data-token-source={service}>
                    {TOKEN_SOURCE[service]!.text}
                  </a>
                  .
                </>
              ) : null}
            </small>
          </label>
          <div className="pc-settings-form__actions">
            <span>
              <LockKeyhole aria-hidden="true" /> Plaintext exists only for this write.
            </span>
            <button type="button" className="ghost" disabled={pending} onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button type="button" disabled={!token.trim() || pending} onClick={submitAdd}>
              {pending ? "Storing securely…" : "Store in Vault"}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="ghost justify-self-start"
          onClick={() => {
            setMsg(null);
            setAdding(true);
          }}
        >
          <Plus aria-hidden="true" /> Add a {serviceLabel} token
        </button>
      )}

      {msg ? (
        <p
          className={msg.ok ? "pc-inline-notice is-success" : "pc-inline-notice is-danger"}
          role={msg.ok ? "status" : "alert"}
        >
          {msg.ok ? <CheckCircle2 aria-hidden="true" /> : null}
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}
