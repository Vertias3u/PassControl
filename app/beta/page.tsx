import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { BetaApplicationForm } from "@/components/BetaApplicationForm";
import { VertiasLogo, VertiasWordmark } from "@/components/VertiasLogo";
import styles from "./beta.module.css";

export const metadata: Metadata = {
  title: "Request PassControl Cloud beta access",
  description: "Apply for the free, invite-only PassControl Cloud beta.",
};

// This is anonymous, but it contains the application form. Render it per
// request so middleware can nonce the client-side form code instead of adding
// another route to the weaker prerendered-page CSP exception.
export const dynamic = "force-dynamic";

export default function BetaApplicationPage() {
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="PassControl home">
          <VertiasLogo size={25} />
          <VertiasWordmark size={16} />
          <span>/ PassControl</span>
        </Link>
        <Link href="/" className={styles.back}><ArrowLeft aria-hidden="true" /> Product</Link>
      </header>
      <section className={styles.layout}>
        <div className={styles.copy}>
          <p className={styles.eyebrow}>Cloud private beta</p>
          <h1>Put one real agent behind PassControl.</h1>
          <p className={styles.lead}>
            Tell us what you want to connect. Invitations are personal, free during the beta,
            and reviewed for a setup PassControl can support properly.
          </p>
          <ul>
            <li><ShieldCheck aria-hidden="true" /> Your provider key stays server-side.</li>
            <li><ShieldCheck aria-hidden="true" /> Each agent gets its own scope and budget.</li>
            <li><ShieldCheck aria-hidden="true" /> A stored call—not a setup screen—proves activation.</li>
          </ul>
          <p className={styles.note}>No payment card. No automatic mailing list. No guarantee of acceptance.</p>
        </div>
        <div className={styles.card}>
          <div className={styles.cardHeader}>
            <span>Application</span>
            <strong>About 2 minutes</strong>
          </div>
          <BetaApplicationForm />
        </div>
      </section>
    </main>
  );
}
