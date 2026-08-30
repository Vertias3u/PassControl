import styles from "../notices.module.css";

export default function InstanceRecoveryNoticePage() {
  return (
    <>
      <h1>What a restore can recover.</h1>
      <p className={styles.intro}>
        PassControl cannot tell whether this instance has a working backup. The operator of this
        instance is responsible for the terms and procedures governing backup and recovery.
      </p>
      <section>
        <h2>Database-backed configuration</h2>
        <p>
          A database restore can recover agents, passport public keys, scopes, policies, budgets,
          ownership declarations, call metadata, receipts, and audit rows when those records were
          included in the backup.
        </p>
      </section>
      <section className={styles.notice}>
        <h2>Secrets need a separate recovery path</h2>
        <p>
          Provider API keys are not portable through a database dump alone. Supabase Vault encrypts
          them with key material held by the original project, so re-enter them after losing or moving
          to a different Vault project.
        </p>
        <p>
          Control API keys and Direct Agent Keys are stored only as hashes. A database restore can
          restore those verifier rows, so a client that retained its key may still authenticate, but
          the database cannot reveal the original bearer values. A configuration export contains
          neither the hashes nor the bearer values. Revoke and reissue a credential when its client no
          longer holds it, or when the operator&rsquo;s recovery policy requires rotation.
        </p>
        <p>
          Authentication and MFA recovery depend on the Supabase Auth backup. After project loss,
          verify them separately; re-enrol factors and sign in again if they were not restored.
        </p>
      </section>
      <section>
        <h2>Configuration exports</h2>
        <p>
          A workspace export contains agents, scopes, policies, budgets, failover order, and ownership
          declarations, but no provider keys, key hashes, MFA material, or private signing keys. Import
          it into a fresh instance; a passport public key identifies one agent per instance.
        </p>
      </section>
    </>
  );
}
