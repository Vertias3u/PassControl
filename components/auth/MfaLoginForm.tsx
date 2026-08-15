"use client";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { ShieldCheck } from "lucide-react";
import { submitLoginMfa } from "@/app/dashboard/mfa-actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending}><ShieldCheck aria-hidden="true" /> {pending ? "Verifying…" : "Verify session"}</button>;
}

export function MfaLoginForm() {
  const [state, action] = useActionState(submitLoginMfa, undefined);
  return (
    <form action={action} className="pc-auth-form">
      <label className="pc-field">
        <span>Authenticator or recovery code</span>
        <input
          name="code"
          inputMode="text"
          autoComplete="one-time-code"
          placeholder="123456"
          autoFocus
          required
          className="pc-code-input"
          aria-describedby="mfa-code-note"
        />
      </label>
      <SubmitButton />
      {state?.error ? <p role="alert" className="pc-form-error">{state.error}</p> : null}
      <p id="mfa-code-note" className="pc-field-note">
        Lost your device? Enter a <strong>recovery code</strong> instead — it resets 2FA so you can
        re-enroll from Settings.
      </p>
    </form>
  );
}
