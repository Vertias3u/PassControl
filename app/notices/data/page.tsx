import styles from "../notices.module.css";

export default function InstanceDataNoticePage() {
  return (
    <>
      <h1>How the software handles data.</h1>
      <p className={styles.intro}>
        This is a technical notice about PassControl&rsquo;s default behaviour. The operator of this
        instance decides where it runs, who may use it, and which infrastructure providers receive data.
      </p>
      <section>
        <h2>Records kept by PassControl</h2>
        <p>
          The database stores operator account identifiers, agent records, public passport keys,
          scopes, policies, budgets, credential hashes, audit events, call metadata, and signed
          receipts. Provider API keys are held through Supabase Vault rather than returned to agents.
        </p>
      </section>
      <section>
        <h2>Model traffic</h2>
        <p>
          The gateway processes model requests and responses in transit so it can call the selected
          provider and stream the result. PassControl does not store prompts or model responses in its
          ordinary call log. The selected model provider still receives the request.
        </p>
      </section>
      <section>
        <h2>Deployment-specific details</h2>
        <p>
          Authentication, database, Redis, hosting, telemetry, email, retention, backups, and network
          logs depend on how this instance is configured. The operator is responsible for the terms,
          privacy disclosures, processors, contact route, and retention choices for that deployment.
        </p>
      </section>
    </>
  );
}
