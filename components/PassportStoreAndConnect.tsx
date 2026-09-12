"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Radio, ShieldAlert, ShieldCheck } from "lucide-react";

import { buildConfigureSnippet, buildPassportImportCommand } from "@/app/dashboard/key-import-snippet";
import { buttonVariants } from "@/components/ui/button";
import {
  activationDiagnosis,
  authenticationProofLabel,
  type FirstCallRow,
} from "@/lib/first-call-activation";
import { buildPassportConnectSetup } from "@/lib/passport-connect-config";
import type { ProviderId } from "@/lib/providers";
import { browserClient } from "@/lib/supabase/client";

type CopyKind = "secret" | "env" | "install" | "client" | "smoke" | "sidecar" | "import" | "mcp";
type ConnectMode = "sdk" | "sidecar" | "mcp";
const PASSPORT_AUTH_METHODS = ["passport", "passport_proof_per_request"] as const;

function isPassportAuthMethod(value: FirstCallRow["auth_method"]): boolean {
  return value === "passport" || value === "passport_proof_per_request";
}

function gatewayOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

export function PassportStoreAndConnect({
  userId,
  agentId,
  issuedAt,
  provider,
  model,
  passportId,
  passportSecret,
  initialMode,
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
  initialMode: ConnectMode;
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
  const [mode, setMode] = useState<ConnectMode>(initialMode);

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
      .in("auth_method", [...PASSPORT_AUTH_METHODS])
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
          // existed. The row records the exact assurance the gateway enforced:
          // bearer passport visa or passport proof per request. See
          // authenticationProofLabel for why that distinction is load-bearing.
          if (next.agent_id === agentId && isPassportAuthMethod(next.auth_method) && next.created_at > issuedAt) {
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
        gateway: origin,
        passportId,
        provider,
        model,
        integration: sidecarIntegration,
        allowedIntegrations: integrations,
      })
    : "";
  const importCommand = buildPassportImportCommand({ gateway: origin, passportId });
  const diagnosis = row && row.status !== "ok" ? activationDiagnosis(row) : null;
  const verified = row?.status === "ok" && isPassportAuthMethod(row.auth_method);
  const proofedPerRequest = row?.auth_method === "passport_proof_per_request";

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

      <div className="pc-segmented" aria-label="Passport connection method">
        {(["sdk", "sidecar", "mcp"] as const).map((option) => (
          <button key={option} type="button" aria-pressed={mode === option} onClick={() => setMode(option)}>
            {option === "sdk" ? "SDK" : option === "sidecar" ? "Sidecar / static-key tool" : "MCP"}
          </button>
        ))}
      </div>

      <div className="pc-boundary-note">
        <ShieldCheck aria-hidden="true" />
        <span>
          <strong>{mode === "sdk" ? setup.integrationLabel : mode === "sidecar" ? "Local Passport sidecar" : "Passport MCP"}.</strong>{" "}
          {mode === "sidecar"
            ? "The sidecar listens on http://127.0.0.1:8788 and attaches per-request sender proof before forwarding to the PassControl gateway."
            : "The private key signs locally. PassControl receives the public Passport ID and signatures, never the secret."}
        </span>
      </div>

      {mode === "sdk" ? (
        <>
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
            <p className="pc-field-note">SDK and MCP calls present bearer visas. They do not satisfy required per-request sender-proof mode.</p>
          </section>
        </>
      ) : (
        <>
          <section className="grid gap-2" aria-labelledby="passport-secret-heading">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><strong id="passport-secret-heading">1. Copy the one-time Passport secret</strong><small className="block text-muted-foreground">The CLI asks for this with hidden input. It is never part of the command.</small></div>
              {copyButton("secret", "Copy Passport secret", passportSecret)}
            </div>
            <pre className="pc-secret-block is-secret whitespace-pre-wrap break-all">{passportSecret}</pre>
          </section>
          <section className="grid gap-2" aria-labelledby="passport-import-heading">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><strong id="passport-import-heading">2. Import into the OS credential store</strong><small className="block text-muted-foreground">This command contains only the public gateway and Passport ID.</small></div>
              {copyButton("import", "Copy import command", importCommand)}
            </div>
            <pre className="pc-secret-block is-public overflow-x-auto">{importCommand}</pre>
          </section>
          {mode === "sidecar" ? (
            <section className="grid gap-2" aria-labelledby="passport-sidecar-heading">
              <label className="grid gap-1 text-sm">
                <strong id="passport-sidecar-heading">3. Configure and start the sidecar</strong>
                <span>Static-key tool preset</span>
                <select value={sidecarIntegration} onChange={(event) => setSidecarIntegration(event.target.value)}>
                  {integrations.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <pre className="pc-secret-block is-public overflow-x-auto">{sidecarSnippet}</pre>
              {copyButton("sidecar", "Copy sidecar setup", sidecarSnippet)}
              <p className="pc-field-note">Point the tool at the sidecar URL, not the PassControl gateway. Direct Agent Keys use the gateway directly and are issued through the separate Direct Agent Key flow.</p>
            </section>
          ) : (
            <section className="grid gap-2" aria-labelledby="passport-mcp-heading">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div><strong id="passport-mcp-heading">3. Configure the MCP client</strong><small className="block text-muted-foreground">Choose the client in the CLI. MCP currently uses bearer visas.</small></div>
                {copyButton("mcp", "Copy MCP command", "passcontrol mcp")}
              </div>
              <pre className="pc-secret-block is-public">passcontrol mcp</pre>
            </section>
          )}
        </>
      )}

      {/* The DOM-level contract follows the STORED method, not this agent's
          setting. A setup call can prove bearer visa acceptance or the stronger
          per-request private-key proof, and the two must not collapse here. */}
      <section className="pc-first-call__diagnosis" aria-live="polite" data-passport-proof={verified ? proofedPerRequest ? "passport-proof-per-request-ok" : "passport-visa-ok" : row ? row.status : "none"}>
        {verified ? <Check aria-hidden="true" /> : row ? <ShieldAlert aria-hidden="true" /> : <Radio aria-hidden="true" />}
        <div>
          <span>{live ? "Watching immutable call records" : "Connecting to call records"}</span>
          {verified ? (
            <>
              {/* `verified` pins the two passport-family methods and excludes
                  Direct Agent Keys. The row's actual method chooses the claim. */}
              <strong>{authenticationProofLabel(row?.auth_method)}.</strong>
              {proofedPerRequest ? (
                <p>
                  This call presented the visa and a fresh passport proof bound to that visa, method,
                  and path. The gateway verified both before using the provider credential server-side.
                </p>
              ) : (
                <p>
                  The passport signed the challenge, PassControl issued a short-lived visa, and this call
                  presented that bearer visa. Cloud then used the provider credential server-side and stored
                  the governed call.
                </p>
              )}
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
