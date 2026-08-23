import { LegalPage } from "@/components/legal/LegalPage";

export const metadata = { title: "Cookie and storage notice" };

export default function CookiesPage() {
  return (
    <LegalPage title="Cookies and local storage." summary="PassControl uses storage needed for sign-in, account recovery and operator display preferences. It has no advertising cookies.">
      <section><h2>PassControl storage</h2><table><thead><tr><th>Item</th><th>Purpose</th><th>Duration</th></tr></thead><tbody>
        <tr><td>Supabase authentication cookies</td><td>Keep an operator signed in and refresh the authenticated session.</td><td>Controlled by the authentication session and cleared on sign-out or expiry.</td></tr>
        <tr><td><code>pc-password-recovery</code></td><td>Complete the password-recovery flow safely.</td><td>Up to 15 minutes.</td></tr>
        <tr><td><code>passcontrol.dashboard.time-zone</code> in localStorage</td><td>Remember whether the operator chose UTC or local time.</td><td>Until the browser storage is cleared or the preference changes.</td></tr>
        <tr><td><code>pc-first-call-dismissed</code></td><td>Remember that an operator dismissed the first-governed-call setup guide, so a finished dashboard stays finished. It stores only the operator id that dismissed it and is never read by the gateway.</td><td>One year, or until cookies are cleared.</td></tr>
      </tbody></table>
      <p>These items are used to provide a service or preference you request. PassControl currently sets no advertising, cross-site tracking or behavioural-analytics cookie, so it does not display a consent banner. If optional analytics or marketing storage is introduced, this notice and the consent mechanism must change first.</p></section>
      <section><h2>Vertias.eu</h2><p>The static Vertias page does not set analytics cookies. Its fonts are served from Vertias infrastructure, so loading the page does not make a font request to Google.</p></section>
      <section><h2>Your controls</h2><p>You can delete cookies and local storage in browser settings. Blocking required authentication cookies will prevent dashboard sign-in. Clearing local storage resets the time-zone preference without deleting your account.</p></section>
    </LegalPage>
  );
}
