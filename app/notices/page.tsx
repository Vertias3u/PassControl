import Link from "next/link";
import styles from "./notices.module.css";

export default function InstanceNoticesPage() {
  return (
    <>
      <h1>Notices for this instance.</h1>
      <p className={styles.intro}>
        PassControl is software an operator deploys. These pages describe what the software does;
        they are not the operator&rsquo;s terms of service or a promise about their infrastructure.
      </p>
      <section className={styles.notice}>
        <h2>The operator sets the service relationship</h2>
        <p>
          The operator of this instance is responsible for the terms that apply to its users,
          identifying itself, providing contact details, and explaining any configuration or
          third-party services it adds.
        </p>
      </section>
      <section>
        <h2>What the software notices cover</h2>
        <ul>
          <li><Link href="/notices/data">Data handling</Link> — records PassControl stores and data it processes in transit.</li>
          <li><Link href="/notices/recovery">Recovery</Link> — what a database restore can and cannot recover.</li>
        </ul>
      </section>
    </>
  );
}
