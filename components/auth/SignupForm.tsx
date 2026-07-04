"use client";
import { useFormState, useFormStatus } from "react-dom";
import { signup } from "@/app/actions/auth";
import { Honeypot } from "./Honeypot";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} style={{ width: "100%" }}>
      {pending ? "Creating account…" : "Create account"}
    </button>
  );
}

export function SignupForm() {
  const [state, formAction] = useFormState(signup, undefined);
  return (
    <form action={formAction} className="grid">
      <Honeypot />
      <label className="grid" style={{ gap: 4 }}>
        <span className="muted">Email</span>
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label className="grid" style={{ gap: 4 }}>
        <span className="muted">Password</span>
        <input name="password" type="password" autoComplete="new-password" required minLength={12} />
      </label>
      <label className="grid" style={{ gap: 4 }}>
        <span className="muted">Invite code</span>
        <input name="invite_code" type="text" required />
      </label>
      {state?.error && <p style={{ color: "var(--red)", margin: 0 }}>{state.error}</p>}
      <SubmitButton />
      <p className="muted" style={{ margin: 0 }}>
        Already have an account? <a href="/login">Sign in</a>
      </p>
    </form>
  );
}
