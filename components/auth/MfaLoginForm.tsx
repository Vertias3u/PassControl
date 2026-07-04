"use client";
import { useFormState, useFormStatus } from "react-dom";
import { submitLoginMfa } from "@/app/dashboard/mfa-actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending}>{pending ? "Verifying…" : "Verify"}</button>;
}

export function MfaLoginForm() {
  const [state, action] = useFormState(submitLoginMfa, undefined);
  return (
    <form action={action} className="grid" style={{ gap: 12 }}>
      <label className="grid" style={{ gap: 4 }}>
        <span className="muted">Authenticator code</span>
        <input
          name="code"
          inputMode="text"
          autoComplete="one-time-code"
          placeholder="123456"
          autoFocus
          required
          style={{ letterSpacing: "0.15em" }}
        />
      </label>
      <SubmitButton />
      {state?.error && <p style={{ color: "var(--danger)", margin: 0 }}>{state.error}</p>}
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>
        Lost your device? Enter a <strong>recovery code</strong> instead — it resets 2FA so you can
        re-enroll from Settings.
      </p>
    </form>
  );
}
