"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { resetPassword } from "@/app/actions/auth";
import { Honeypot } from "./Honeypot";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} style={{ width: "100%" }}>
      <KeyRound aria-hidden="true" /> {pending ? "Updating password…" : "Update password"}
    </button>
  );
}

function PasswordField({
  name,
  label,
  autoComplete,
}: {
  name: string;
  label: string;
  autoComplete: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <label className="pc-field">
      <span>{label}</span>
      <span className="pc-password-field">
        <input
          name={name}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          minLength={12}
          required
        />
        <button
          type="button"
          className="pc-password-field__toggle"
          onClick={() => setVisible((value) => !value)}
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          aria-pressed={visible}
        >
          {visible ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
        </button>
      </span>
    </label>
  );
}

export function ResetPasswordForm() {
  const [state, formAction] = useActionState(resetPassword, undefined);
  return (
    <form action={formAction} className="pc-auth-form">
      <Honeypot />
      <PasswordField name="password" label="New password" autoComplete="new-password" />
      <PasswordField
        name="password_confirmation"
        label="Confirm new password"
        autoComplete="new-password"
      />
      <p className="pc-field-note">Use at least 12 characters. The server enforces the same policy as signup.</p>
      {state?.error ? <p role="alert" className="pc-form-error">{state.error}</p> : null}
      <SubmitButton />
    </form>
  );
}
