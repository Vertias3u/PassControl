import type { Metadata } from "next";
import Link from "next/link";
import styles from "./notices.module.css";

export const metadata: Metadata = {
  title: { default: "Instance notices", template: "%s · PassControl instance notices" },
  description: "Generic software and data-handling notices for this PassControl instance.",
};

export default function NoticesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <header className={styles.bar}>
        <Link className={styles.brand} href="/">PassControl</Link>
        <nav className={styles.nav} aria-label="Instance notices">
          <Link href="/notices">Overview</Link>
          <Link href="/notices/data">Data</Link>
          <Link href="/notices/recovery">Recovery</Link>
        </nav>
      </header>
      <main className={styles.main}>{children}</main>
      <footer className={styles.footer}>
        These pages describe the software&rsquo;s default behaviour. The operator of this instance
        is responsible for the terms, privacy information, contact details, and legal notices
        required for their deployment.
      </footer>
    </div>
  );
}
