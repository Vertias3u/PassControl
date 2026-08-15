import { LegalContact, LegalPage } from "@/components/legal/LegalPage";

export const metadata = { title: "Privacy notice" };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy notice." summary="What personal data PassControl and Vertias process, why it is needed, where it goes and what choices you have.">
      <section>
        <h2>1. Who is responsible</h2>
        <p>Kristiyan Ivanov is the controller for PassControl Cloud, passcontrol.vertias.eu and www.vertias.eu, operating under the Vertias name from Sofia, Bulgaria.</p>
        <LegalContact />
        <p><strong>Launch status:</strong> if the page above is marked as a pre-launch draft, its effective date is still unresolved and external beta invitations must not begin.</p>
      </section>
      <section>
        <h2>2. Data we process</h2>
        <ul>
          <li><strong>Account data:</strong> email address, authentication records, session data, MFA state and recovery-code hashes.</li>
          <li><strong>Beta application data:</strong> email address, intended integration and provider, estimated call range, use-case description, consent time, invitation state and optional setup feedback.</li>
          <li><strong>Agent configuration:</strong> agent names, identity keys, direct-key hashes and suffixes, scopes, policies, budgets, suspension state and break-glass settings.</li>
          <li><strong>Call records:</strong> agent and credential identifiers, provider, model, token counts, cost, outcome, latency, time, receipt and shadow-policy verdict.</li>
          <li><strong>Provider credentials:</strong> keys placed in the managed Vault. They are retrieved only after a call passes the gate.</li>
          <li><strong>Security and operations data:</strong> IP-derived rate-limit keys, nonces, budget reservations, audit events and scrubbed error diagnostics.</li>
          <li><strong>Communications:</strong> email address and message content when you contact Vertias or receive authentication, invitation, one-time setup-follow-up, feedback-request or recovery email.</li>
        </ul>
      </section>
      <section>
        <h2>3. Model traffic</h2>
        <p>PassControl must process model requests and responses in plaintext while proxying them so it can apply the gate, add the provider credential and return the result. The selected model provider also receives that content.</p>
        <p><strong>PassControl does not store prompts or model responses in <code>agent_logs</code>.</strong> It stores the call metadata listed above. Infrastructure providers may still process transient request data and operational logs under their own retention and security terms.</p>
      </section>
      <section>
        <h2>4. Why we process it</h2>
        <table><thead><tr><th>Purpose</th><th>Legal basis</th></tr></thead><tbody>
          <tr><td>Provide accounts, agent control, gateway routing and receipts</td><td>Contract and steps requested before entering a contract</td></tr>
          <tr><td>Review beta applications and send personal invitations or the one permitted activation follow-up</td><td>Steps you request before entering the beta agreement and consent to application contact</td></tr>
          <tr><td>Protect the service, enforce limits, investigate abuse and keep reliable records</td><td>Legitimate interests in security, integrity and operating the beta</td></tr>
          <tr><td>Respond to legal requests and exercise or defend claims</td><td>Legal obligation and legitimate interests</td></tr>
          <tr><td>Send optional marketing in the future</td><td>Consent, if such messages are introduced; beta application and setup email is transactional, not a marketing list</td></tr>
        </tbody></table>
      </section>
      <section>
        <h2>5. Who receives data</h2>
        <p>PassControl uses Vercel, Supabase, Upstash, Resend and, when configured, Sentry. Their roles and links are listed on the <a href="/legal/subprocessors">service providers page</a>. Your chosen model provider receives calls you route to it. Data may be processed outside the EEA using the safeguards made available by those providers.</p>
        <p>Personal data is not sold. PassControl currently uses no advertising or behavioural-analytics service. Beta emails are text-only and contain no open-tracking pixel or click-tracking wrapper.</p>
      </section>
      <section>
        <h2>6. Retention</h2>
        <p>Pending or unaccepted beta applications are kept for no more than 180 days. Declined or withdrawn applications are scheduled for deletion after 30 days. Expired, revoked or used invitation metadata is removed after its relevant date is more than 30 days old. Setup feedback is kept for up to 180 days. The raw invitation token is never stored.</p>
        <p>Account, configuration, audit and call metadata are retained while your beta account is active. Permanent workspace deletion removes linked beta application and feedback records through the same account cascade, except for limited records that must be preserved for legal obligations or legal claims. Processor backups and logs expire under each provider's retention process.</p>
        <p>Do not place data in PassControl that you cannot lawfully retain under this model.</p>
      </section>
      <section>
        <h2>7. Your rights</h2>
        <p>Depending on the circumstances, you may request access, correction, deletion, restriction, portability or object to processing based on legitimate interests. Where processing relies on consent, you may withdraw it without affecting earlier processing.</p>
        <p>Authenticated operators can download a machine-readable account export or permanently delete their workspace from Dashboard → Settings → Account data. An MFA step-up is required when MFA is enrolled. You may also email <a href="mailto:hello@vertias.eu">hello@vertias.eu</a>; identity may be verified before acting on a request.</p>
        <p>You may complain to Bulgaria's <a href="https://cpdp.bg/en/lodging-complaints-and-alerts/">Commission for Personal Data Protection</a>.</p>
      </section>
      <section>
        <h2>8. Security, children and automated decisions</h2>
        <p>PassControl applies technical controls intended to protect credentials and tenant data, but this is an early beta and has not been independently audited. No Internet service can promise absolute security.</p>
        <p>The beta is for adults aged 18 or over. Its automated gate controls access to model providers; it is not used to make decisions producing legal or similarly significant effects about people.</p>
      </section>
      <section><h2>9. Changes</h2><p>Material changes will be posted here and, where appropriate, sent to active invitees before taking effect.</p></section>
    </LegalPage>
  );
}
