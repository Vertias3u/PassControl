import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, KeyRound, Route, ShieldCheck } from "lucide-react";
import { VertiasLogo, VertiasWordmark } from "@/components/VertiasLogo";
import { instanceLabel } from "@/lib/instance-label";

export function AuthShell({
  eyebrow,
  title,
  description,
  children,
  showAccountTerms = false,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  showAccountTerms?: boolean;
}) {
  const label = instanceLabel();
  return (
    <main className="pc-auth">
      <a href="#auth-form" className="pc-skip-link">
        Skip to form
      </a>
      <section className="pc-auth__brand" aria-label="About PassControl">
        <Link href="/" className="pc-auth__wordmark" aria-label="Back to PassControl home">
          <VertiasLogo size={27} />
          <span>
            <VertiasWordmark size={17} />
            <small>PassControl</small>
          </span>
        </Link>

        <div className="pc-auth__story">
          <p className="pc-kicker">Agent Control Tower</p>
          <h2>Real provider keys stay behind the boundary.</h2>
          <p>
            Sign in to issue scoped agent passports, inspect governed calls, and stop access
            without distributing the credentials that power it.
          </p>

          <div className="pc-auth__boundary" aria-label="PassControl trust boundary">
            <div>
              <Route aria-hidden="true" />
              <span>Agent</span>
              <small>public passport</small>
            </div>
            <span className="pc-auth__boundary-line" aria-hidden="true" />
            <div className="is-control">
              <ShieldCheck aria-hidden="true" />
              <span>PassControl</span>
              <small>policy boundary</small>
            </div>
            <span className="pc-auth__boundary-line" aria-hidden="true" />
            <div>
              <KeyRound aria-hidden="true" />
              <span>Vault</span>
              <small>provider key</small>
            </div>
          </div>
        </div>

        <p className="pc-auth__instance">
          <span className="pc-live-dot" aria-hidden="true" />
          {label}
        </p>
      </section>

      <section className="pc-auth__entry">
        <div id="auth-form" className="pc-auth__card">
          <Link href="/" className="pc-auth__back">
            <ArrowLeft aria-hidden="true" /> Back to product
          </Link>
          <p className="pc-kicker">{eyebrow}</p>
          <h1>{title}</h1>
          <p className="pc-auth__description">{description}</p>
          {showAccountTerms && (
            <p className="pc-auth__privacy">
              By creating an account, you agree to the <Link href="/legal/terms">beta
              terms</Link> and <Link href="/legal/acceptable-use">acceptable use
              policy</Link>, and acknowledge the <Link href="/legal/privacy">privacy
              notice</Link>.
            </p>
          )}
          {children}
          <p className="pc-auth__privacy">
            Your operator session controls privileged actions. Agent private keys remain
            browser-generated and provider keys remain in the Vault.
          </p>
        </div>
      </section>
    </main>
  );
}
