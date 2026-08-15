"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Mail } from "lucide-react";
import { requestPasswordReset } from "@/app/actions/auth";
import { Honeypot } from "./Honeypot";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} style={{ width: "100%" }}>
      <Mail aria-hidden="true" /> {pending ? "Sending link…" : "Send reset link"}
    </button>
  );
}

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState(requestPasswordReset, undefined);
  return (
    <form action={formAction} className="pc-auth-form">
      <Honeypot />
      <label className="pc-field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="email" required />
      </label>
      {state?.error ? <p role="alert" className="pc-form-error">{state.error}</p> : null}
      {state?.success ? <p role="status" className="pc-form-success">{state.success}</p> : null}
      <SubmitButton />
      <p className="pc-auth-form__switch"><a href="/login">Return to sign in</a></p>
    </form>
  );
}
