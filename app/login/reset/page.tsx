import { AuthShell } from "@/components/auth/AuthShell";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

export const metadata = { title: "Choose a new password" };

export default function ResetPasswordPage() {
  return (
    <AuthShell
      eyebrow="Account recovery"
      title="Choose a new password"
      description="This recovery session is temporary. After the password changes, every active session is signed out."
    >
      <ResetPasswordForm />
    </AuthShell>
  );
}

export const dynamic = "force-dynamic";
