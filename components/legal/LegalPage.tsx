import type { ReactNode } from "react";
import Link from "next/link";
import { VertiasLogo } from "@/components/VertiasLogo";
import styles from "@/app/legal/legal.module.css";
import { PASSCONTROL_CONTACT_EMAIL, PASSCONTROL_CONTACT_MAILTO } from "@/lib/contact";
import { LEGAL_IS_DRAFT, PUBLIC_SERVICE_ADDRESS, legalDateLabel } from "@/lib/legal-config";

export const LEGAL_UPDATED = legalDateLabel();

const PAGES = [
  ["Privacy", "/legal/privacy"],
  ["Beta terms", "/legal/terms"],
  ["Acceptable use", "/legal/acceptable-use"],
  ["Cookies", "/legal/cookies"],
  ["Service providers", "/legal/subprocessors"],
  ["Recovery", "/legal/recovery"],
] as const;

export function LegalPage({
  title,
  summary,
  children,
}: {
  title: string;
  summary: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.site}>
      <a className={styles.skip} href="#legal-content">Skip to legal notice</a>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="PassControl home">
          <VertiasLogo size={25} />
          <strong>ver·tias</strong>
          <span>/ PassControl</span>
        </Link>
        <Link href="/" className={styles.back}>Back to PassControl</Link>
      </header>

      {LEGAL_IS_DRAFT && (
        <div className={styles.draft} role="status">
          <strong>Pre-launch draft</strong>
          <span>
            These notices are not yet effective. Configure their effective date before
            external beta invitations begin.
          </span>
        </div>
      )}

      <main className={styles.layout} id="legal-content">
        <aside aria-label="Legal pages">
          <p>Legal</p>
          <nav>
            {PAGES.map(([label, href]) => <Link key={href} href={href}>{label}</Link>)}
          </nav>
          <small>{LEGAL_IS_DRAFT ? "Draft status" : "Effective"}<br />{LEGAL_UPDATED}</small>
        </aside>
        <article className={styles.document}>
          <p className={styles.eyebrow}>PassControl legal</p>
          <h1>{title}</h1>
          <p className={styles.summary}>{summary}</p>
          {children}
        </article>
      </main>

      <footer className={styles.footer}>
        <span>© 2026 Kristiyan Ivanov · Vertias project · Sofia, Bulgaria</span>
        <a href={PASSCONTROL_CONTACT_MAILTO}>{PASSCONTROL_CONTACT_EMAIL}</a>
      </footer>
    </div>
  );
}

export function LegalContact() {
  return (
    <address>
      <strong>Kristiyan Ivanov</strong><br />
      Individual operating the Vertias project<br />
      Sofia, Bulgaria<br />
      {PUBLIC_SERVICE_ADDRESS && <>Public service address: {PUBLIC_SERVICE_ADDRESS}<br /></>}
      <a href={PASSCONTROL_CONTACT_MAILTO}>{PASSCONTROL_CONTACT_EMAIL}</a>
    </address>
  );
}
