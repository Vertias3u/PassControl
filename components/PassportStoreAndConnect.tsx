"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Radio, ShieldAlert, ShieldCheck } from "lucide-react";

import { buildConfigureSnippet } from "@/app/dashboard/key-import-snippet";
import { buttonVariants } from "@/components/ui/button";
import {
  activationDiagnosis,
  authenticationProofLabel,
  type FirstCallRow,
} from "@/lib/first-call-activation";
import { buildPassportConnectSetup } from "@/lib/passport-connect-config";
import type { ProviderId } from "@/lib/providers";
import { browserClient } from "@/lib/supabase/client";

type CopyKind = "env" | "install" | "client" | "smoke" | "sidecar";

function gatewayOrigin(): string {
  return typeof window === "undefined" ? "https://passcontrol.vertias.eu" : window.location.origin;
}

export function PassportStoreAndConnect({
  userId,
  agentId,
  issuedAt,
  provider,
  model,
  passportId,
  passportSecret,
  integrations,
  stored,
  onStoredChange,
  onFinish,
}: {
  userId: string;
  agentId: string;
  /** Database timestamp from which THIS passport could have signed anything: the
   *  agent row's creation for a new agent, the rotation time for a replacement. A
   *  stored call older than this proves the previous key, so it must not count.
   *  Required rather than optional — a caller that has no floor has no proof. */
  issuedAt: string;
  provider: ProviderId;
  model: string;
  passportId: string;
  passportSecret: string;
  integrations: readonly string[];
  stored: boolean;
  onStoredChange: (stored: boolean) => void;
  onFinish: () => void;
}) {
  const [origin, setOrigin] = useState(gatewayOrigin);
  const [row, setRow] = useState<FirstCallRow | null>(null);
  const [live, setLive] = useState(false);
  const [copyState, setCopyState] = useState<CopyKind | "failed" | null>(null);
  const [sidecarIntegration, setSidecarIntegration] = useState(
    integrations.includes("generic") ? "generic" : integrations[0] ?? ""
  );

  useEffect(() => setOrigin(window.location.origin), []);

  useEffect(() => {
    if (stored) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const warnBeforeLinkNavigation = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!target) return;
      if (!window.confirm("Leave before saving the passport? This private key cannot be shown again.")) {
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

  useEffect(() => {
    let active = true;
    const db = browserClient();
    void db
      .from("agent_logs")
      .select("id, agent_id, provider, model, status, receipt, auth_method, created_at")
      .eq("agent_id", agentId)
      .eq("auth_method", "passport")
      .gt("created_at", issuedAt)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (active && data) setRow(data as FirstCallRow);
      });

    const channel = db
      .channel(`passport-connect:${userId}:${agentId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "agent_logs", filter: `user_id=eq.${userId}` },
        (payload) => {
          const next = payload.new as FirstCallRow;
          // Same three conditions as the historical read, applied to the live feed:
          // this agent, a passport-derived visa, and stored after this passport
          // existed. The row records which credential authenticated the call, not
          // a per-call signature — see authenticationProofLabel for why that
          // distinction is load-bearing here.
          if (next.agent_id === agentId && next.auth_method === "passport" && next.created_at > issuedAt) {
            setRow(next);
          }
        }
      )
      .subscribe((status) => setLive(status === "SUBSCRIBED"));

    return () => {
      active = false;
      void db.removeChannel(channel);
    };
  }, [agentId, issuedAt, userId]);

  const setup = useMemo(
    () => buildPassportConnectSetup({ origin, provider, passportId, passportSecret, model }),
    [model, origin, passportId, passportSecret, provider]
  );
  const sidecarSnippet = sidecarIntegration
    ? buildConfigureSnippet({
        passportId,
        passportSecret,
        provider,
        model,
        integration: sidecarIntegration,
        allowedIntegrations: integrations,
      })
    : "";
  const diagnosis = row && row.status !== "ok" ? activationDiagnosis(row) : null;
  const verified = row?.status === "ok" && row.auth_method === "passport";

  const copy = async (kind: CopyKind, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState(kind);
      window.setTimeout(() => setCopyState(null), 1800);
    } catch {
      setCopyState("failed");
    }
  };

  const copyButton = (kind: CopyKind, label: string, value: string) => (
    <button type="button" className="ghost" onClick={() => void copy(kind, value)}>
      {copyState === kind ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copyState === kind ? "Copied" : label}
    </button>
  );

  return (
    <div className="grid gap-4" data-passport-connect-state={verified ? "verified" : row ? "recorded" : "waiting"}>
      <div className="pc-secret-warning">
        <strong>Shown once.</strong>
        <span>
          Save this only in the agent&apos;s private runtime or secret manager. Do not paste it into source code,
          chat, tickets, logs or a browser-exposed environment variable.
        </span>
      </div>

      <div className="pc-boundary-note">
        <ShieldCheck aria-hidden="true" />
        <span><strong>{setup.integrationLabel}.</strong> The private key signs locally. Cloud receives the public Passport ID and signatures, never the secret.</span>
      </div>

      <section className="grid gap-2" aria-labelledby="passport-env-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><strong id="passport-env-heading">1. Store in the private runtime</strong><small className="block text-muted-foreground">This is the only block containing the secret.</small></div>
          {copyButton("env", "Copy private environment", setup.envBlock)}
        </div>
        <pre className="pc-secret-block is-secret">{setup.envBlock}</pre>
      </section>

      <section className="grid gap-2" aria-labelledby="passport-install-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong id="passport-install-heading">2. Install the SDK</strong>
          {copyButton("install", "Copy install command", setup.installCommand)}
        </div>
        <pre className="pc-secret-block is-public">{setup.installCommand}</pre>
      </section>

      <section className="grid gap-2" aria-labelledby="passport-client-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><strong id="passport-client-heading">3. Connect the provider SDK</strong><small className="block text-muted-foreground">Save as <code>{setup.clientFilename}</code>. This code contains no private key.</small></div>
          {copyButton("client", "Copy application code", setup.clientCode)}
        </div>
        <pre className="pc-secret-block is-public overflow-x-auto">{setup.clientCode}</pre>
      </section>

      <section className="grid gap-2" aria-labelledby="passport-smoke-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><strong id="passport-smoke-heading">4. Run one smoke call</strong><small className="block text-muted-foreground">Save as <code>{setup.smokeFilename}</code>, then run <code>{setup.smokeCommand}</code>.</small></div>
          {copyButton("smoke", "Copy smoke-test code", setup.smokeCode)}
        </div>
        <pre className="pc-secret-block is-public overflow-x-auto">{setup.smokeCode}</pre>
        <p className="pc-field-note">Running this makes one real provider call and may use provider credits. PassControl will not mark setup complete until the resulting call is stored.</p>
      </section>

      {/* The DOM-level contract for this panel, so the token has to carry the same
          semantics as the copy: a passport-derived VISA was accepted, not a
          per-call passport signature. Anything asserting on this panel reads
          `passport-visa-ok`. */}
      <section className="pc-first-call__diagnosis" aria-live="polite" data-passport-proof={verified ? "passport-visa-ok" : row ? row.status : "none"}>
        {verified ? <Check aria-hidden="true" /> : row ? <ShieldAlert aria-hidden="true" /> : <Radio aria-hidden="true" />}
        <div>
          <span>{live ? "Watching immutable call records" : "Connecting to call records"}</span>
          {verified ? (
            <>
              {/* `verified` already pins auth_method === "passport", so the literal
                  argument is the guard restated — and the phrase itself comes from
                  the one helper the dashboard uses, so the two cannot drift apart. */}
              <strong>{authenticationProofLabel("passport")}.</strong>
              <p>
                The passport signed the challenge, PassControl issued a short-lived visa, and this call
                presented that visa. Cloud then used the provider credential server-side and stored the
                governed call.
              </p>
              <small data-receipt-state={row?.receipt ? "recorded" : "missing"}>
                {row?.receipt
                  ? "Signed receipt attached to the stored call."
                  : "The call was stored, but no receipt is attached; it is not receipt-verified."}
              </small>
            </>
          ) : diagnosis ? (
            <>
              <strong>{diagnosis.title}</strong>
              <p>Recorded as <code>{row?.status}</code>. {diagnosis.detail}</p>
            </>
          ) : (
            <>
              <strong>Waiting for a stored Passport call.</strong>
              <p>No stored call yet. Authentication failures happen before a tenant call row exists. Check the Passport ID, secret, gateway origin and system clock.</p>
            </>
          )}
        </div>
      </section>

      <details className="rounded-md border border-border bg-secondary/30 p-3">
        <summary className="cursor-pointer text-sm font-semibold">Advanced · passport sidecar for static-key tools</summary>
        <p className="text-sm text-muted-foreground">Need passport identity in a static-key tool? The local sidecar remains available, but it requires a process running beside the application. For Cloud without a local process, use a Direct Agent Key instead.</p>
        {integrations.length ? (
          <>
            <label className="grid gap-1 text-sm">
              <span>Sidecar preset</span>
              <select value={sidecarIntegration} onChange={(event) => setSidecarIntegration(event.target.value)}>
                {integrations.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <pre className="pc-secret-block is-secret overflow-x-auto">{sidecarSnippet}</pre>
            {copyButton("sidecar", "Copy advanced sidecar setup", sidecarSnippet)}
          </>
        ) : null}
      </details>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="w-auto" checked={stored} onChange={(event) => onStoredChange(event.target.checked)} />
          I&apos;ve stored the private passport securely
        </label>
        <button type="button" disabled={!stored} onClick={onFinish} className={buttonVariants({ size: "lg" })}>
          {verified ? "Done" : "Finish later"}
        </button>
      </div>
      {copyState === "failed" ? <p role="alert" className="pc-inline-error">Clipboard access was blocked. Select and copy the intended block manually.</p> : null}
    </div>
  );
}
