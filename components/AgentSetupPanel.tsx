"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Wrench } from "lucide-react";

import { setupExampleModel } from "@/lib/agent-connect";
import { buildDirectConnectSetup, DIRECT_KEY_PLACEHOLDER } from "@/lib/direct-connect-config";
import { buildServiceConnectSetup } from "@/lib/service-connect";
import { SERVICE_CATALOG } from "@/lib/services/catalog";
import { DISPLAYED_SERVICES, SERVICE_DISPLAY } from "@/lib/services/display";
import { isProvider, type ProviderId } from "@/lib/providers";

export interface AgentSetupKey {
  id: string;
  name: string;
  suffix: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

type SetupState = "ready" | "needs-model" | "no-active-key" | "no-provider" | "revoked";
type CopyKind = "install" | "env" | "load" | "smoke";

const PLACEHOLDER_ORIGIN = "https://YOUR-PASSCONTROL-HOST";

function activeKeys(keys: readonly AgentSetupKey[]): AgentSetupKey[] {
  const now = Date.now();
  return keys.filter((key) => !key.revokedAt && !(key.expiresAt && Date.parse(key.expiresAt) <= now));
}

/**
 * The agent's Setup, reopenable at any time after the one-time reveal.
 *
 * Rebuilt from what PassControl stores — the agent, its grant and its
 * installation-key metadata — through the same builder the reveal uses, so the
 * two cannot disagree on URLs or request shapes. It never holds a key: only a
 * hash exists. The worker's saved key goes into the placeholder; a lost key is
 * replaced from the installation-key panel below, never recovered.
 */
export function AgentSetupPanel({
  agentId,
  agentName,
  status,
  scopes,
  keys,
}: {
  agentId: string;
  agentName: string;
  status: string;
  scopes: readonly { provider: string; models: readonly string[] }[];
  keys: readonly AgentSetupKey[];
}) {
  // The real origin only after mount: the server cannot know which host the
  // operator reached, and rendering a different value on each side would be a
  // hydration mismatch.
  const [origin, setOrigin] = useState(PLACEHOLDER_ORIGIN);
  useEffect(() => setOrigin(window.location.origin), []);
  const providers = [...new Set(scopes.map((entry) => entry.provider).filter(isProvider))];
  const [provider, setProvider] = useState<ProviderId | null>(providers[0] ?? null);
  const [copied, setCopied] = useState<CopyKind | null>(null);

  const usable = activeKeys(keys);
  const model = provider ? setupExampleModel(scopes, provider) : null;
  const state: SetupState =
    status === "revoked"
      ? "revoked"
      : !provider
        ? "no-provider"
        : usable.length === 0
          ? "no-active-key"
          : model === null
            ? "needs-model"
            : "ready";
  const setup =
    state === "ready" && provider && model
      ? buildDirectConnectSetup({ origin, provider, key: null, model })
      : null;

  const copy = async (kind: CopyKind, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      // Selecting the text by hand still works; nothing to recover.
    }
  };
  const label = "text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground";
  const block = "overflow-x-auto rounded-xl border border-border bg-black/30 p-4 text-xs leading-6 text-foreground";
  const CopyButton = ({ kind, value, text }: { kind: CopyKind; value: string; text: string }) => (
    <button type="button" className="ghost inline-flex items-center gap-2 justify-self-start" onClick={() => copy(kind, value)}>
      {copied === kind ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied === kind ? "Copied" : text}
    </button>
  );

  return (
    <section
      id="agent-setup"
      className="grid scroll-mt-40 gap-5 rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6"
      aria-labelledby="agent-setup-heading"
      data-setup-state={state}
      data-agent-id={agentId}
    >
      <div>
        <p className="m-0 text-xs font-semibold uppercase tracking-[0.16em] text-primary">Connect the worker</p>
        <h2 id="agent-setup-heading" className="mt-2 flex items-center gap-2 text-lg font-bold">
          <Wrench aria-hidden="true" className="h-5 w-5" /> Setup
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          How {agentName || "this agent"}&apos;s worker reaches PassControl. Use the Direct Agent Key you
          saved when it was created; PassControl keeps only a hash and cannot show it again.
        </p>
      </div>

      {state === "revoked" ? (
        <p className="m-0 text-sm text-muted-foreground">This agent is revoked. Its credentials no longer authenticate, so there is nothing to connect.</p>
      ) : null}
      {state === "no-provider" ? (
        <div className="grid gap-1.5" data-setup-services-only>
          <p className="m-0 text-sm text-muted-foreground">
            This agent has no model access, so every model call is refused. It can call a service through
            the rules under{" "}
            {DISPLAYED_SERVICES.map((service, index) => (
              <span key={service}>
                {index > 0 ? (index === DISPLAYED_SERVICES.length - 1 ? " and " : ", ") : null}
                <a href={`#${SERVICE_DISPLAY[service].sectionId}`}>{SERVICE_CATALOG[service].label} access</a>
              </span>
            ))}
            ; to let it call a model, add a provider and model to its access.
          </p>
          {usable.length > 0 && status !== "revoked" ? (
            <>
              <span className={`${label} mt-2`}>Configuration for the worker</span>
              <pre className={block}>{buildServiceConnectSetup({ origin, key: null }).envBlock}</pre>
              <span className={`${label} mt-2`}>GitHub with Octokit</span>
              <pre className={block}>{buildServiceConnectSetup({ origin, key: null }).octokit}</pre>
            </>
          ) : null}
        </div>
      ) : null}
      {state === "no-active-key" ? (
        <p className="m-0 text-sm text-muted-foreground">
          This agent has no active Direct Agent Key. <a href="#direct-agent-keys">Create an installation key</a> to connect a worker with one.
        </p>
      ) : null}
      {state === "needs-model" ? (
        <p className="m-0 text-sm text-muted-foreground">
          This agent&apos;s grant has only patterns for {provider}, and PassControl will not guess a model name to send.
          Add an exact model id to its <a href="#agent-policy">access</a>, or put one your provider serves in the configuration below yourself.
        </p>
      ) : null}

      {usable.length > 0 && state !== "revoked" ? (
        <div className="grid gap-1.5" data-setup-keys>
          <span className={label}>Active installation keys</span>
          <ul className="m-0 grid list-none gap-1 p-0 text-sm">
            {usable.map((key) => (
              <li key={key.id}>
                <strong>{key.name}</strong> <code className="text-xs text-muted-foreground">pc_agent_…{key.suffix}</code>
              </li>
            ))}
          </ul>
          <p className="m-0 text-xs leading-5 text-muted-foreground">
            Lost the key? It cannot be recovered. <a href="#direct-agent-keys">Issue a replacement installation key</a> and revoke the old one.
          </p>
        </div>
      ) : null}

      {providers.length > 1 && state !== "revoked" ? (
        <label className="grid max-w-xs gap-1.5 text-sm">
          <span className={label}>Provider</span>
          <select value={provider ?? ""} onChange={(event) => setProvider(event.target.value as ProviderId)}>
            {providers.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
      ) : null}

      {setup ? (
        <div className="grid gap-1.5" data-client-family={setup.family}>
          <p className="m-0 text-sm leading-6" data-setup-note="runtime">{setup.runtimeNote}</p>
          <span className={`${label} mt-2`}>1 · Install the SDK</span>
          <pre className={block}>{setup.installCommand}</pre>
          <CopyButton kind="install" value={setup.installCommand} text="Copy install command" />
          <span className={`${label} mt-2`}>2 · {setup.label} — save and load {setup.envFileName}</span>
          <p className="m-0 text-xs leading-5 text-muted-foreground">
            Paste this into a terminal in your project folder, in the shell that starts the worker. It writes {setup.envFileName}, readable only by you, and loads it. Keep it out of git: add {setup.envFileName} to your .gitignore.
          </p>
          <pre className={block}>{setup.saveAndLoadCommand}</pre>
          <CopyButton kind="env" value={setup.saveAndLoadCommand} text="Copy save-and-load command" />
          <p className="m-0 text-xs leading-5 text-muted-foreground">
            The key is shown only once, so this writes a placeholder. Edit {setup.envFileName}, replace{" "}
            <code>{DIRECT_KEY_PLACEHOLDER}</code> with the Direct Agent Key you stored, then load it again with{" "}
            <code>{setup.loadCommand}</code> — the same line a new terminal needs.
          </p>
          <span className={`${label} mt-2`}>3 · Smoke test</span>
          <pre className={block}>{setup.smokeCommand}</pre>
          <CopyButton kind="smoke" value={setup.smokeCommand} text="Copy smoke test" />
          <p className="m-0 text-xs leading-5 text-muted-foreground">
            {setup.authNote} A <code>401 invalid_credential</code> means the key itself was not accepted —
            wrong, revoked or expired — and PassControl writes no call record for it, because it cannot
            tell whose call it was.
          </p>
        </div>
      ) : null}

      {state !== "revoked" ? (
        <details className="text-sm" data-setup-failures>
          <summary className="cursor-pointer font-semibold">If a call fails — which answer came from where</summary>
          {/* Grounded in the gateway's own error codes (the proxy route). The
              three that look alike from a worker — 401, 403, 503 — need three
              different fixes, and only some of them leave a call record. */}
          <ul className="mt-3 grid gap-2 pl-5 text-xs leading-5 text-muted-foreground">
            <li data-failure="invalid_credential">
              <code>401 {"{"}&quot;error&quot;:&quot;invalid_credential&quot;{"}"}</code> — PassControl did not accept the
              key: wrong, revoked or expired, or the worker is still sending the provider key. No call record is
              written. Check <code>{setup?.keyVariable ?? "the key variable"}</code>, or{" "}
              <a href="#direct-agent-keys">issue a replacement installation key</a>.
            </li>
            <li data-failure="provider_401">
              A 401 whose body is <em>the provider&apos;s</em> error format — the key was accepted, the call was
              forwarded, and the provider refused the provider key PassControl holds. It appears in Activity as a
              provider error. Fix it in <a href="/dashboard/settings#provider-credentials">provider credentials</a>,
              not here.
            </li>
            <li data-failure="blocked_scope">
              <code>403 blocked_scope</code> — a deliberate refusal: the model is outside this agent&apos;s allowed
              access. Recorded in Activity. Change the model, or <a href="#agent-access">edit allowed access</a>.
            </li>
            <li data-failure="blocked_suspended">
              <code>403 blocked_suspended</code> or <code>blocked_killed</code> — a stop control is on. See{" "}
              <a href="#agent-operate">Operate</a>.
            </li>
            <li data-failure="blocked_policy_output_limit">
              <code>403 blocked_policy</code> with <code>&quot;rule&quot;: &quot;max_output_tokens&quot;</code> — this
              agent has an output ceiling and the request&apos;s <code>max_tokens</code> (or{" "}
              <code>max_completion_tokens</code> / <code>max_output_tokens</code>) is missing or above the{" "}
              <code>limit</code> in the response. Set it at or under that limit; PassControl never lowers it for you.
            </li>
            <li data-failure="blocked_budget">
              <code>402 blocked_budget</code> — this agent&apos;s cumulative cap is reached.
            </li>
            <li data-failure="blocked_budget_period">
              <code>402 blocked_budget_period</code> — this agent&apos;s daily or monthly limit is used up for the
              current UTC period. The <code>retry-after</code> header says how many seconds until it resets.
            </li>
            <li data-failure="authentication_unavailable">
              <code>503 authentication_unavailable</code> or <code>authentication_rate_limit_unavailable</code> —
              PassControl could not check the key right now. Nothing was forwarded and no call record is written;
              retry, and check <a href="/dashboard/system">System health</a> if it persists.
            </li>
            <li data-failure="rate_limited">
              <code>429 rate_limited</code> — too many key checks from this address. Wait for the{" "}
              <code>retry-after</code> period.
            </li>
          </ul>
        </details>
      ) : null}
    </section>
  );
}
