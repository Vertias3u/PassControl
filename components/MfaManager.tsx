"use client";
// Dashboard "Security" panel — enable/disable TOTP MFA + recovery codes. The
// QR + secret come from Supabase; recovery codes are shown ONCE on enrollment.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { enrollMfa, verifyMfaEnrollment, unenrollMfa, regenerateRecoveryCodes } from "@/app/dashboard/mfa-actions";
import { AlertTriangle, Check, Copy, ShieldCheck, ShieldOff } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";

type Status = { enrolled: boolean; recoveryRemaining: number };

export function MfaManager({ status }: { status: Status }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  // enrollment flow
  const [enroll, setEnroll] = useState<{ factorId: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  // reveal-once recovery codes
  const [codes, setCodes] = useState<string[] | null>(null);
  const [ack, setAck] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [disableOpen, setDisableOpen] = useState(false);

  const begin = () =>
    start(async () => {
      setErr(null);
      const r = await enrollMfa();
      if ("error" in r) return setErr(r.error);
      setEnroll(r);
    });

  const verify = () =>
    start(async () => {
      setErr(null);
      if (!enroll) return;
      const r = await verifyMfaEnrollment(enroll.factorId, code);
      if ("error" in r) return setErr(r.error);
      setEnroll(null);
      setCode("");
      setCodes(r.recoveryCodes); // show once
    });

  const disable = () =>
    start(async () => {
      setErr(null);
      const r = await unenrollMfa();
      if ("error" in r) return setErr(r.error);
      setDisableOpen(false);
      router.refresh();
    });

  const regen = () =>
    start(async () => {
      setErr(null);
      const r = await regenerateRecoveryCodes();
      if ("error" in r) return setErr(r.error);
      setCodes(r.recoveryCodes);
      setCopyState("idle");
    });

  const closeCodes = () => {
    setCodes(null);
    setAck(false);
    setCopyState("idle");
    router.refresh();
  };

  return (
    <div className="pc-settings-manager">
      {err && <p className="pc-inline-notice is-danger" role="alert">{err}</p>}

      {/* Enrolled state */}
      {status.enrolled && !enroll && (
        <div className="pc-security-state" data-state={status.recoveryRemaining <= 2 ? "warning" : "ready"}>
          <ShieldCheck aria-hidden="true" />
          <div>
            <strong>Two-factor authentication is on</strong>
            <p>{status.recoveryRemaining} recovery code{status.recoveryRemaining === 1 ? "" : "s"} remaining{status.recoveryRemaining <= 2 ? " · regenerate soon" : ""}.</p>
          </div>
          <div className="pc-security-state__actions">
            <button onClick={regen} disabled={pending} className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold hover:bg-secondary/80">
              Regenerate recovery codes
            </button>
            <button onClick={() => setDisableOpen(true)} disabled={pending} className="rounded-md border px-3 py-1.5 text-sm font-semibold" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
              Disable 2FA
            </button>
          </div>
        </div>
      )}

      {/* Not enrolled, not mid-flow */}
      {!status.enrolled && !enroll && (
        <div className="pc-security-state" data-state="attention">
          <ShieldOff aria-hidden="true" />
          <div>
          <strong>Two-factor authentication is off</strong>
          <p>
            Protect the Control Tower with an authenticator app (TOTP). Recommended — this account can
            issue passports and arm the kill switch.
          </p>
          </div>
          <button onClick={begin} disabled={pending} className="inline-flex w-fit items-center gap-1">
            <ShieldCheck className="h-4 w-4" /> {pending ? "Starting…" : "Enable two-factor"}
          </button>
        </div>
      )}

      {/* Enrollment: scan + verify */}
      {enroll && (
        <div className="pc-mfa-enroll">
          <div><span>1</span><p><strong>Scan the QR code</strong><small>Add PassControl to your authenticator app.</small></p></div>
          {/* Supabase returns an SVG data-URL — rendered as an image, no HTML injection. */}
          <img src={enroll.qr} alt="TOTP QR code" width={176} height={176} style={{ background: "#fff", borderRadius: 8 }} />
          <div className="grid gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Or enter this secret manually</span>
            <code className="mono break-all text-xs">{enroll.secret}</code>
          </div>
          <div><span>2</span><p><strong>Verify the setup</strong><small>Enter the current six-digit code to enable protection.</small></p></div>
          <div className="row" style={{ gap: 8 }}>
            <input
              inputMode="numeric"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              style={{ width: 120, letterSpacing: "0.2em" }}
            />
            <button onClick={verify} disabled={pending || code.length < 6}>
              {pending ? "Verifying…" : "Verify & enable"}
            </button>
            <button onClick={() => { setEnroll(null); setCode(""); setErr(null); }} className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold hover:bg-secondary/80">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Reveal-once recovery codes */}
      <Dialog
        open={Boolean(codes)}
        onOpenChange={(open) => { if (!open && ack) closeCodes(); }}
        title="Save your recovery codes"
        description="This set is shown once. Each code works one time."
        preventClose={!ack}
        showClose={ack}
      >
        {codes ? (
          <div className="pc-dialog__body">
            <p className="m-0 text-sm text-muted-foreground">
              Shown <strong className="text-foreground">once</strong>. Each works one time if you lose your
              authenticator. Store them somewhere safe.
            </p>
            <pre className="grid grid-cols-2 gap-1 overflow-x-auto rounded-sm border border-border bg-secondary p-3 text-sm">
              {codes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </pre>
            <div className="flex items-center justify-between">
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(codes.join("\n"));
                    setCopyState("copied");
                  } catch {
                    setCopyState("failed");
                  }
                }}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold hover:bg-secondary/80"
              >
                {copyState === "copied" ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copyState === "copied" ? "Copied" : "Copy all"}
              </button>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" style={{ width: "auto" }} checked={ack} onChange={(e) => setAck(e.target.checked)} />
                I&apos;ve saved these
              </label>
            </div>
            <p className="pc-field-note" role="status" aria-live="polite">
              {copyState === "failed" ? "Clipboard access was blocked. Select and copy the codes manually." : copyState === "copied" ? "Recovery codes copied. Store them outside this device if possible." : "Using a recovery code resets MFA and requires re-enrollment."}
            </p>
            <div className="pc-dialog__actions">
              <button disabled={!ack} onClick={closeCodes}>Done</button>
            </div>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={disableOpen}
        onOpenChange={(open) => { if (!pending) setDisableOpen(open); }}
        title={<span className="inline-flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-destructive" /> Disable two-factor authentication?</span>}
        description="Password-only sessions will regain access to privileged Control Tower actions."
        preventClose={pending}
      >
        <div className="pc-dialog__body">
          <p className="m-0 text-sm text-muted-foreground">Existing recovery codes will be cleared. You can enroll again later from this page.</p>
          <div className="pc-dialog__actions">
            <button type="button" className="ghost" disabled={pending} onClick={() => setDisableOpen(false)}>Keep 2FA</button>
            <button type="button" className="pc-button-danger" disabled={pending} onClick={disable}>{pending ? "Disabling…" : "Disable 2FA"}</button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
