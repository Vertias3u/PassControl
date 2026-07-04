// MFA step-up page. Reached after a password login when the account has a TOTP
// factor (session is aal1, dashboard needs aal2). Requires a session; if MFA is
// already satisfied (or none enrolled) it bounces to the dashboard.
import { redirect } from "next/navigation";
import { userClient } from "@/lib/supabase/server";
import { needsMfaStepUp } from "@/lib/mfa";
import { MfaLoginForm } from "@/components/auth/MfaLoginForm";

export const dynamic = "force-dynamic";

export default async function MfaVerifyPage() {
  const supabase = await userClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  if (!(await needsMfaStepUp(supabase))) redirect("/dashboard");

  return (
    <main className="mx-auto mt-[12vh] grid max-w-md gap-4 rounded-lg border border-border bg-card p-6">
      <h1 className="m-0 text-xl font-bold">Two-factor verification</h1>
      <p className="m-0 text-sm text-muted-foreground">
        Enter the 6-digit code from your authenticator app to finish signing in.
      </p>
      <MfaLoginForm />
    </main>
  );
}
