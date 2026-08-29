import { LegalPage } from "@/components/legal/LegalPage";
import { PASSCONTROL_CONTACT_EMAIL, PASSCONTROL_CONTACT_MAILTO } from "@/lib/contact";

export const metadata = { title: "Service providers" };

const SERVICES = [
  ["Vercel", "Application hosting, edge delivery and operational logs", "https://vercel.com/legal/privacy-notice", "https://vercel.com/legal/dpa", "DPA"],
  ["Supabase", "Authentication, Postgres database, Vault and realtime services", "https://supabase.com/privacy", "https://supabase.com/downloads/docs/Supabase%2BDPA%2B260601.pdf", "DPA"],
  ["Upstash", "Redis-backed nonces, rate limits, kill state, reservations and caches", "https://upstash.com/static/trust/privacy.pdf", "https://upstash.com/trust/dpa.pdf", "DPA"],
  ["Resend", "Transactional authentication, invitation, setup-follow-up, feedback-request and password-recovery email", "https://resend.com/legal/privacy-policy", "https://resend.com/legal/dpa", "DPA"],
  ["ImprovMX", "Inbound forwarding for owner, support, privacy and legal contact mail", "https://improvmx.com/transparency/privacy-policy/", "https://improvmx.com/transparency/gdpr-compliance/", "GDPR"],
  ["Sentry", "Scrubbed error and security monitoring when configured", "https://sentry.io/privacy/", "https://sentry.io/legal/dpa/", "DPA"],
] as const;

export default function SubprocessorsPage() {
  return (
    <LegalPage title="Service providers." summary="The infrastructure services that may process beta data, plus the model providers you choose as routing destinations.">
      <section><h2>PassControl infrastructure</h2><table><thead><tr><th>Provider</th><th>Role</th><th>Legal information</th></tr></thead><tbody>
        {SERVICES.map(([name, role, privacy, dataProtection, dataProtectionLabel]) => <tr key={name}><td><strong>{name}</strong></td><td>{role}</td><td><a href={privacy}>Privacy</a> · <a href={dataProtection}>{dataProtectionLabel}</a></td></tr>)}
      </tbody></table><p>These providers may use further subprocessors and may process data outside Bulgaria or the EEA under the mechanisms described in their legal documents. This list describes the intended beta stack; the final production account settings and contractual coverage must be confirmed before invitations are sent.</p></section>
      <section><h2>User-selected routing destinations</h2><p>OpenAI, Anthropic, Groq, Mistral, Together and DeepSeek are supported model destinations. A provider receives a request only when you configure its credential and route a call to it. Your own contract and privacy terms with that provider govern its handling of the prompt, response and account data.</p></section>
      <section><h2>Website assets</h2><p>PassControl and Vertias package their fonts locally. Loading either site does not require a visitor-data request to Google Fonts.</p></section>
      <section><h2>Changes</h2><p>This page will be updated before a material new service provider is used for beta personal data. Questions can be sent to <a href={PASSCONTROL_CONTACT_MAILTO}>{PASSCONTROL_CONTACT_EMAIL}</a>.</p></section>
    </LegalPage>
  );
}
