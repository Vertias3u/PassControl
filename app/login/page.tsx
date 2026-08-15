import { LoginForm } from "@/components/auth/LoginForm";
import { AuthShell } from "@/components/auth/AuthShell";
import { signupMode } from "@/lib/invite-code";

export const metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string; error?: string; deleted?: string }>;
}) {
  const query = await searchParams;
  const notice = query.deleted === "1"
    ? "Your PassControl account and tenant data were deleted."
    : query.reset === "success"
      ? "Password updated. Sign in with your new password."
      : undefined;
  const initialError = query.error === "auth" ? "This sign-in link is invalid or expired." : undefined;
  return (
    <AuthShell
      eyebrow="Operator access"
      title="Welcome back"
      description="Sign in to inspect and operate your governed agent fleet."
    >
      <LoginForm notice={notice} initialError={initialError} signupMode={signupMode()} />
    </AuthShell>
  );
}

export const dynamic = "force-dynamic";
