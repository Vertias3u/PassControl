import { LoginForm } from "@/components/auth/LoginForm";
import { VertiasLogo, VertiasWordmark } from "@/components/VertiasLogo";

export const metadata = { title: "Sign in — PassControl by Vertias" };

export default function LoginPage() {
  return (
    <main className="mx-auto mt-[12vh] grid max-w-sm gap-4 px-4">
      <div className="grid justify-items-center gap-2">
        <VertiasLogo size={48} />
        <VertiasWordmark size={22} />
        <div className="text-center">
          <h1 className="m-0 text-lg font-bold">PassControl</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Agent Control Tower</p>
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card p-6">
        <LoginForm />
      </div>
    </main>
  );
}
