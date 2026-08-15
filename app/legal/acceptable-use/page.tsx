import { LegalPage } from "@/components/legal/LegalPage";

export const metadata = { title: "Acceptable use policy" };

export default function AcceptableUsePage() {
  return (
    <LegalPage title="Acceptable use." summary="PassControl is infrastructure for controlled model access, not a way to hide abuse or bypass another service's rules.">
      <section><h2>Use the beta lawfully</h2><p>You may use PassControl only for lawful purposes, with accounts, credentials, systems and data you are authorised to use. Follow the terms and safety requirements of every model provider and connected service.</p></section>
      <section><h2>Do not use PassControl to</h2><ul>
        <li>access, scan, disrupt or test systems without clear authorisation;</li>
        <li>steal, expose, trade or misuse credentials, personal data or confidential information;</li>
        <li>create or distribute malware, phishing, fraud, spam or mechanisms for evading security controls;</li>
        <li>exploit or sexually abuse children, or create, obtain or distribute child sexual abuse material;</li>
        <li>threaten, harass or facilitate unlawful discrimination or physical harm;</li>
        <li>evade sanctions, export controls, court orders or other legal restrictions;</li>
        <li>bypass PassControl rate limits, quotas, invitations, tenant boundaries or access controls;</li>
        <li>overload the service, interfere with other tenants, or probe the beta outside an agreed security-testing scope;</li>
        <li>misrepresent PassControl receipts, agent identity, decisions or audit history.</li>
      </ul></section>
      <section><h2>Enforcement</h2><p>Access may be limited or suspended while suspected abuse is investigated. Where appropriate and lawful, the operator may preserve relevant records, notify affected providers or authorities, and permanently end access. Good-faith vulnerability reports should follow the repository's <a href="https://github.com/Vertias3u/PassControl/blob/main/SECURITY.md">security policy</a>.</p></section>
      <section><h2>Questions</h2><p>If you are unsure whether a use is permitted, ask first at <a href="mailto:hello@vertias.eu">hello@vertias.eu</a>.</p></section>
    </LegalPage>
  );
}
