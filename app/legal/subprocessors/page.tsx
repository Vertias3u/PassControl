import { LegalPage } from "@/components/legal/LegalPage";

export const metadata = { title: "Service providers" };

const SERVICES = [
  ["Vercel", "Application hosting, edge delivery and operational logs", "https://vercel.com/legal/privacy-notice", "https://vercel.com/legal/dpa"],
  ["Supabase", "Authentication, Postgres database, Vault and realtime services", "https://supabase.com/privacy", "https://supabase.com/downloads/docs/Supabase%2BDPA%2B260601.pdf"],
  ["Upstash", "Redis-backed nonces, rate limits, kill state, reservations and caches", "https://upstash.com/static/trust/privacy.pdf", "https://upstash.com/trust/dpa.pdf"],
  ["Resend", "Transactional authentication, invitation, setup-follow-up, feedback-request and password-recovery email", "https://resend.com/legal/privacy-policy", "https://resend.com/legal/dpa"],
  ["Sentry", "Scrubbed error and security monitoring when configured", "https://sentry.io/privacy/", "https://sentry.io/legal/dpa/"],
] as const;

export default function SubprocessorsPage() {
  return (
    <LegalPage title="Service providers." summary="The infrastructure services that may process beta data, plus the model providers you choose as routing destinations.">
      <section><h2>PassControl infrastructure</h2><table><thead><tr><th>Provider</th><th>Role</th><th>Legal information</th></tr></thead><tbody>
        {SERVICES.map(([name, role, privacy, dpa]) => <tr key={name}><td><strong>{name}</strong></td><td>{role}</td><td><a href={privacy}>Privacy</a> · <a href={dpa}>DPA</a></td></tr>)}
      </tbody></table><p>These providers may use further subprocessors and may process data outside Bulgaria or the EEA under the mechanisms described in their legal documents. This list describes the intended beta stack; the final production account settings and contractual coverage must be confirmed before invitations are sent.</p></section>
      <section><h2>User-selected routing destinations</h2><p>OpenAI, Anthropic, Groq, Mistral, Together and DeepSeek are supported model destinations. A provider receives a request only when you configure its credential and route a call to it. Your own contract and privacy terms with that provider govern its handling of the prompt, response and account data.</p></section>
      <section><h2>Website assets</h2><p>PassControl and Vertias package their fonts locally. Loading either site does not require a visitor-data request to Google Fonts.</p></section>
      <section><h2>Changes</h2><p>This page will be updated before a material new service provider is used for beta personal data. Questions can be sent to <a href="mailto:hello@vertias.eu">hello@vertias.eu</a>.</p></section>
    </LegalPage>
  );
}
