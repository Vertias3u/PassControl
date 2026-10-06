"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, Copy } from "lucide-react";

import { buildDirectConnectSetup, buildHermesCloudSetup } from "@/lib/direct-connect-config";
import { buildServiceConnectSetup } from "@/lib/service-connect";
import type { ProviderId } from "@/lib/providers";
import { buttonVariants } from "@/components/ui/button";
import { serviceNames } from "@/lib/services/display";

export interface RevealedDirectAgent {
  agentId: string;
  keyId: string;
  key: string;
  name: string;
  keyName: string;
  expiresAt: string | null;
  /** Null for an agent created to call services only (no model access). */
  provider: ProviderId | null;
  model: string | null;
}

type CopyKind = "key" | "install" | "env" | "load" | "smoke" | "code" | "hermes" | "svc-env" | "octokit" | "telegram";

function gatewayOrigin(): string {
  return typeof window === "undefined" ? "https://YOUR-PASSCONTROL-HOST" : window.location.origin;
}

/**
 * The one reveal of a new Direct Agent Key, shared by the Connect dialog and
 * the key-import on-ramp so the two cannot drift.
 *
 * The key exists only in the `issued` prop: PassControl stores a hash. Its
 * owner keeps this mounted until `stored` is acknowledged and must defer any
 * route refresh until then. Everything except the key itself is available
 * again later from the agent's Setup section, which is said here so nobody
 * treats this screen as the only copy of the configuration.
 */
export function DirectAgentKeyReveal({
  issued,
  stored,
  onStoredChange,
  onDone,
}: {
  issued: RevealedDirectAgent;
  stored: boolean;
  onStoredChange: (stored: boolean) => void;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState<CopyKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Same guard as the passport reveal (PassportStoreAndConnect): until storage is
  // acknowledged, a reload or an in-tab link would destroy a key that exists
  // nowhere else. A dialog's preventClose does not cover either, and the
  // key-import on-ramp renders this outside any dialog.
  useEffect(() => {
    if (stored) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const warnBeforeLinkNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!target || target.getAttribute("target") === "_blank") return;
      if (!window.confirm("Leave before saving the Direct Agent Key? It cannot be shown again.")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", warnBeforeLinkNavigation, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", warnBeforeLinkNavigation, true);
    };
  }, [stored]);
  const setup =
    issued.provider && issued.model
      ? buildDirectConnectSetup({ origin: gatewayOrigin(), provider: issued.provider, key: issued.key, model: issued.model })
      : null;
  const hermesSetup =
    issued.provider && issued.model
      ? buildHermesCloudSetup({ origin: gatewayOrigin(), provider: issued.provider, key: issued.key, model: issued.model })
      : null;
  const serviceSetup = setup ? null : buildServiceConnectSetup({ origin: gatewayOrigin(), key: issued.key });
  const label = "text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground";
  const block = "overflow-x-auto rounded-xl border border-border bg-black/30 p-4 text-xs leading-6 text-foreground";

  const copy = async (kind: CopyKind, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setError("Clipboard access was blocked. Select and copy the value manually.");
    }
  };

  const CopyButton = ({ kind, value, text }: { kind: CopyKind; value: string; text: string }) => (
    <button type="button" className="ghost inline-flex items-center gap-2 justify-self-start" onClick={() => copy(kind, value)}>
      {copied === kind ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied === kind ? "Copied" : text}
    </button>
  );

  return (
    <div className="grid gap-5" data-direct-connect-state="issued">
      <div className="grid gap-3 rounded-xl border border-success/30 bg-success/8 p-4">
        <div className="flex items-center gap-2 text-sm font-bold text-success">
          <Check aria-hidden="true" className="h-4 w-4" /> Credential created for {issued.name}
        </div>
        <p className="m-0 text-sm leading-6 text-muted-foreground">
          This is not yet proof that traffic reached the gateway. A stored call row will provide that evidence after the worker makes its first request.
        </p>
      </div>
      <div className="pc-secret-warning">
        <strong>Shown once.</strong>
        <span>Store this credential only in the intended worker or secret manager. PassControl keeps a hash and cannot show it again.</span>
      </div>
      <div className="grid gap-1.5">
        <span className={label}>Direct Agent Key · {issued.keyName}</span>
        <pre className="pc-secret-block is-secret whitespace-pre-wrap break-all">{issued.key}</pre>
        <CopyButton kind="key" value={issued.key} text="Copy credential" />
      </div>
      {serviceSetup ? (
        <div className="grid gap-1.5" data-client-family="services">
          <p className="m-0 text-sm leading-6" data-setup-note="services-only">
            This agent has no model access. It can call {serviceNames()} once you give it rules on{" "}
            {/* A new tab: navigating THIS tab away would destroy an unacknowledged key. */}
            <Link href={`/dashboard/agents/${issued.agentId}#agent-services`} target="_blank" rel="noreferrer">
              its page
            </Link>
            ; until then every call is refused.
          </p>
          <span className={`${label} mt-2`}>1 · Configuration for the worker</span>
          <pre className={block}>{serviceSetup.envBlock}</pre>
          <CopyButton kind="svc-env" value={serviceSetup.envBlock} text="Copy configuration" />
          <span className={`${label} mt-2`}>2 · GitHub with Octokit</span>
          <pre className={block}>{serviceSetup.octokit}</pre>
          <CopyButton kind="octokit" value={serviceSetup.octokit} text="Copy Octokit example" />
          <span className={`${label} mt-2`}>3 · Telegram</span>
          <pre className={block}>{serviceSetup.telegram}</pre>
          <CopyButton kind="telegram" value={serviceSetup.telegram} text="Copy Telegram example" />
        </div>
      ) : null}
      {setup ? <div className="grid gap-1.5" data-client-family={setup.family}>
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
          In a new terminal, load it again with <code>{setup.loadCommand}</code>
        </p>
        <span className={`${label} mt-2`}>3 · First-call smoke test</span>
        <pre className={block}>{setup.smokeCommand}</pre>
        <CopyButton kind="smoke" value={setup.smokeCommand} text="Copy smoke test" />
        <p className="m-0 text-xs leading-5 text-muted-foreground">
          After loading the configuration above, this command makes one real provider request without copying the credential into shell history. A successful response is useful, but the stored call row is the dashboard&apos;s proof that PassControl governed it.
        </p>
        <span className={`${label} mt-2`}>Minimal SDK call</span>
        <pre className={block}>{setup.example}</pre>
        <CopyButton kind="code" value={setup.example} text="Copy SDK example" />
        <p className="m-0 text-xs leading-5 text-muted-foreground">{setup.authNote}</p>
      </div> : null}
      {hermesSetup ? <div className="grid gap-1.5" data-first-class-integration="hermes">
        <span className={label}>Hermes Agent {hermesSetup.version}</span>
        <p className="m-0 text-xs leading-5 text-muted-foreground">
          Merge this <code>model</code> block into <code>{hermesSetup.configPath}</code>, then run <code>hermes chat</code>. This uses Hermes&apos;s current custom-provider configuration; the removed legacy <code>OPENAI_BASE_URL</code> path is not used.
        </p>
        <pre className={block}>{hermesSetup.config}</pre>
        <CopyButton kind="hermes" value={hermesSetup.config} text="Copy Hermes configuration" />
        <p className="m-0 text-xs leading-5 text-muted-foreground">
          Hermes stores this scoped Direct Agent Key, never your provider key. Auxiliary providers or fallback tools configured elsewhere in Hermes are outside this route and can bypass PassControl.
        </p>
      </div> : null}
      <p className="m-0 text-xs leading-5 text-muted-foreground" data-setup-note="reopen">
        Everything above except the key stays available on{" "}
        {/* A new tab on purpose: navigating THIS tab away would unmount the
            reveal and destroy a key that has not been acknowledged yet. */}
        <Link href={`/dashboard/agents/${issued.agentId}#agent-setup`} target="_blank" rel="noreferrer">
          this agent&apos;s Setup
        </Link>.
        A lost key is replaced there with a new one; it is never recovered.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 w-auto" checked={stored} onChange={(event) => onStoredChange(event.target.checked)} />
        <span>I&apos;ve stored this credential securely</span>
      </label>
      {error ? <p role="alert" className="pc-inline-error">{error}</p> : null}
      <div className="flex justify-end">
        <button type="button" className={buttonVariants({ size: "lg" })} disabled={!stored} onClick={onDone}>Done</button>
      </div>
    </div>
  );
}
