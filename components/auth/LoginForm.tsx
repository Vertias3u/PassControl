"use client";
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Eye, EyeOff, LogIn } from "lucide-react";
import { login } from "@/app/actions/auth";
import { Honeypot } from "./Honeypot";
import type { SignupMode } from "@/lib/invite-code";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="pc-auth-submit">
      <LogIn aria-hidden="true" /> {pending ? "Signing in…" : "Sign in"}
    </button>
  );
}

export function LoginForm({
  notice,
  initialError,
  signupMode,
}: {
  notice?: string;
  initialError?: string;
  signupMode: SignupMode;
}) {
  const [state, formAction] = useActionState(login, undefined);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  return (
    <form action={formAction} className="pc-auth-form">
      <Honeypot />
      <label className="pc-field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="email" required aria-describedby={state?.error ? "login-error" : undefined} />
      </label>
      <label className="pc-field">
        <span>Password</span>
        <span className="pc-password-field">
          <input
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            onKeyUp={(event) => setCapsLock(event.getModifierState("CapsLock"))}
            onKeyDown={(event) => setCapsLock(event.getModifierState("CapsLock"))}
            aria-describedby={[state?.error ? "login-error" : "", capsLock ? "login-caps" : ""].filter(Boolean).join(" ") || undefined}
          />
          <button
            type="button"
            className="pc-password-field__toggle"
            onClick={() => setShowPassword((value) => !value)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
          >
            {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
        </span>
      </label>
      {capsLock ? <p id="login-caps" className="pc-field-note is-warning">Caps Lock is on.</p> : null}
      {state?.error ? <p id="login-error" role="alert" className="pc-form-error">{state.error}</p> : null}
      {!state?.error && initialError ? <p role="alert" className="pc-form-error">{initialError}</p> : null}
      {notice ? <p role="status" className="pc-form-success">{notice}</p> : null}
      <p className="pc-auth-form__assist"><a href="/login/forgot">Forgot your password?</a></p>
      <SubmitButton />
      <p className="pc-auth-form__switch">
        {signupMode === "closed" ? (
          "Need an account? Ask this deployment's operator."
        ) : (
          <>No account? <a href="/signup">{signupMode === "invite" ? "Create one with an invite" : "Create one"}</a></>
        )}
      </p>
    </form>
  );
}
