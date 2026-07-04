"use client";
import { useFormState, useFormStatus } from "react-dom";
import { login } from "@/app/actions/auth";
import { Honeypot } from "./Honeypot";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} style={{ width: "100%" }}>
      {pending ? "Signing in…" : "Sign in"}
    </button>
  );
}

export function LoginForm() {
  const [state, formAction] = useFormState(login, undefined);
  return (
    <form action={formAction} className="grid">
      <Honeypot />
      <label className="grid" style={{ gap: 4 }}>
        <span className="muted">Email</span>
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label className="grid" style={{ gap: 4 }}>
        <span className="muted">Password</span>
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {state?.error && <p style={{ color: "var(--red)", margin: 0 }}>{state.error}</p>}
      <SubmitButton />
      <p className="muted" style={{ margin: 0 }}>
        No account? <a href="/signup">Create one</a>
      </p>
    </form>
  );
}
