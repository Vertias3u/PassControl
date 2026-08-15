// MFA step-up page. Reached after a password login when the account has a TOTP
// factor (session is aal1, dashboard needs aal2). Requires a session; if MFA is
// already satisfied (or none enrolled) it bounces to the dashboard.
import { redirect } from "next/navigation";
import { userClient } from "@/lib/supabase/server";
import { needsMfaStepUp } from "@/lib/mfa";
import { MfaLoginForm } from "@/components/auth/MfaLoginForm";
import { AuthShell } from "@/components/auth/AuthShell";

export const dynamic = "force-dynamic";

export default async function MfaVerifyPage() {
  const supabase = await userClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!(await needsMfaStepUp(supabase))) redirect("/dashboard");

  return (
    <AuthShell
      eyebrow="Security checkpoint"
      title="Two-factor verification"
      description="Confirm this operator session with your authenticator or a recovery code."
    >
      <MfaLoginForm />
    </AuthShell>
  );
}
