"use client";
import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { Eye, EyeOff, UserPlus } from "lucide-react";
import { signup } from "@/app/actions/auth";
import { Honeypot } from "./Honeypot";
import type { InviteSource, SignupMode } from "@/lib/invite-code";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="pc-auth-submit">
      <UserPlus aria-hidden="true" /> {pending ? "Creating account…" : "Create account"}
    </button>
  );
}

export function SignupForm({
  mode,
  inviteSource,
}: {
  mode: Exclude<SignupMode, "closed">;
  inviteSource: InviteSource;
}) {
  const [state, formAction] = useActionState(signup, undefined);
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [inviteToken, setInviteToken] = useState(inviteSource === "database" ? null : "");

  useEffect(() => {
    if (inviteSource !== "database") return;
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/u, ""));
    const token = fragment.get("invite") ?? "";
    setInviteToken(token);
    if (window.location.hash) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }, [inviteSource]);

  return (
    <form action={formAction} className="pc-auth-form">
      <Honeypot />
      {mode === "invite" && inviteSource === "database" ? (
        <input name="invite_token" type="hidden" value={inviteToken ?? ""} readOnly />
      ) : null}
      <label className="pc-field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label className="pc-field">
        <span>Password</span>
        <span className="pc-password-field">
          <input
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            required
            minLength={12}
            onKeyUp={(event) => setCapsLock(event.getModifierState("CapsLock"))}
            onKeyDown={(event) => setCapsLock(event.getModifierState("CapsLock"))}
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
        <small>Use at least 12 characters. The server enforces this requirement.</small>
      </label>
      {capsLock ? <p className="pc-field-note is-warning">Caps Lock is on.</p> : null}
      {mode === "invite" && inviteSource === "shared" ? (
        <label className="pc-field">
          <span>Invite code</span>
          <input name="invite_code" type="text" required />
          <small>Access is invite-only so this control plane cannot be claimed through public sign-up.</small>
        </label>
      ) : null}
      {mode === "invite" && inviteSource === "database" ? (
        <p
          className={`pc-inline-notice ${inviteToken ? "is-success" : "is-danger"}`}
          data-invitation-state={inviteToken === null ? "loading" : inviteToken ? "loaded" : "missing"}
        >
          {inviteToken === null
            ? "Reading the invitation from this link…"
            : inviteToken
              ? "Personal invitation loaded. It will be consumed when you create the account."
              : "This page is missing its personal invitation. Open the complete link from your invitation email."}
        </p>
      ) : null}
      {state?.error ? <p role="alert" className="pc-form-error">{state.error}</p> : null}
      {state?.success ? <p role="status" className="pc-form-success">{state.success}</p> : null}
      {inviteSource !== "database" || inviteToken ? <SubmitButton /> : null}
      <p className="pc-auth-form__switch">
        Already have an account? <a href="/login">Sign in</a>
      </p>
    </form>
  );
}
