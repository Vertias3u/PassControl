"use client";
// Dashboard "Security" panel — enable/disable TOTP MFA + recovery codes. The
// QR + secret come from Supabase; recovery codes are shown ONCE on enrollment.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { enrollMfa, verifyMfaEnrollment, unenrollMfa, regenerateRecoveryCodes } from "@/app/dashboard/mfa-actions";
import { ShieldCheck, Copy } from "lucide-react";

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
      if (!confirm("Disable two-factor authentication for this account?")) return;
      const r = await unenrollMfa();
      if ("error" in r) return setErr(r.error);
      router.refresh();
    });

  const regen = () =>
    start(async () => {
      setErr(null);
      const r = await regenerateRecoveryCodes();
      if ("error" in r) return setErr(r.error);
      setCodes(r.recoveryCodes);
    });

  const closeCodes = () => {
    setCodes(null);
    setAck(false);
    router.refresh();
  };

  return (
    <div className="grid gap-3">
      {err && <p style={{ color: "var(--danger)", margin: 0 }}>{err}</p>}

      {/* Enrolled state */}
      {status.enrolled && !enroll && (
        <div className="grid gap-2">
          <p className="m-0 inline-flex items-center gap-2 text-sm" style={{ color: "var(--green)" }}>
            <ShieldCheck className="h-4 w-4" /> Two-factor is <strong>on</strong> ·{" "}
            {status.recoveryRemaining} recovery code{status.recoveryRemaining === 1 ? "" : "s"} left
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button onClick={regen} disabled={pending} className="rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold hover:bg-secondary/80">
              Regenerate recovery codes
            </button>
            <button onClick={disable} disabled={pending} className="rounded-md border px-3 py-1.5 text-sm font-semibold" style={{ borderColor: "var(--danger)", color: "var(--danger)" }}>
              Disable 2FA
            </button>
          </div>
        </div>
      )}

      {/* Not enrolled, not mid-flow */}
      {!status.enrolled && !enroll && (
        <div className="grid gap-2">
          <p className="m-0 text-sm text-muted-foreground">
            Protect the Control Tower with an authenticator app (TOTP). Recommended — this account can
            issue passports and arm the kill switch.
          </p>
          <button onClick={begin} disabled={pending} className="inline-flex w-fit items-center gap-1">
            <ShieldCheck className="h-4 w-4" /> {pending ? "Starting…" : "Enable two-factor"}
          </button>
        </div>
      )}

      {/* Enrollment: scan + verify */}
      {enroll && (
        <div className="grid gap-3">
          <p className="m-0 text-sm text-muted-foreground">Scan this in your authenticator app, then enter the 6-digit code.</p>
          {/* Supabase returns an SVG data-URL — rendered as an image, no HTML injection. */}
          <img src={enroll.qr} alt="TOTP QR code" width={176} height={176} style={{ background: "#fff", borderRadius: 8 }} />
          <div className="grid gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Or enter this secret manually</span>
            <code className="mono break-all text-xs">{enroll.secret}</code>
          </div>
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
      {codes && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60">
          <div className="grid w-[460px] max-w-[90vw] gap-4 rounded-lg border border-border bg-card p-6">
            <h2 className="m-0 text-lg font-bold">Save your recovery codes</h2>
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
                onClick={() => navigator.clipboard.writeText(codes.join("\n"))}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-secondary px-3 py-1.5 text-sm font-semibold hover:bg-secondary/80"
              >
                <Copy className="h-4 w-4" /> Copy all
              </button>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" style={{ width: "auto" }} checked={ack} onChange={(e) => setAck(e.target.checked)} />
                I&apos;ve saved these
              </label>
            </div>
            <div className="flex justify-end">
              <button disabled={!ack} onClick={closeCodes}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
