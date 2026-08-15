import { AuthShell } from "@/components/auth/AuthShell";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

export const metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <AuthShell
      eyebrow="Account recovery"
      title="Reset your password"
      description="Enter your operator email. If an account exists, PassControl will send a time-limited recovery link."
    >
      <ForgotPasswordForm />
    </AuthShell>
  );
}

export const dynamic = "force-dynamic";
