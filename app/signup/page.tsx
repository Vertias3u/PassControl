import { SignupForm } from "@/components/auth/SignupForm";
import { AuthShell } from "@/components/auth/AuthShell";
import { inviteSource, signupMode } from "@/lib/invite-code";

export const metadata = { title: "Create account" };

export default function SignupPage() {
  const mode = signupMode();
  const source = inviteSource();
  if (mode === "closed") {
    return (
      <AuthShell
        eyebrow="Operator access"
        title="Signups are closed"
        description="This deployment is not accepting new operator accounts. Existing operators can still sign in."
      >
        <p className="pc-auth-form__switch"><a href="/login">Return to sign in</a></p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow={mode === "invite" ? "Invite-only access" : "Operator signup"}
      title="Create your control plane"
      description={
        mode === "invite"
          ? source === "database"
            ? "Open your personal invitation link, then create the operator account bound to that invitation."
            : "Use the invite issued for this deployment to create an operator account."
          : "Create an operator account. You may need to confirm your email before signing in."
      }
      showAccountTerms
    >
      <SignupForm mode={mode} inviteSource={source} />
    </AuthShell>
  );
}

export const dynamic = "force-dynamic";
