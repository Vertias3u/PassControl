import { LegalPage } from "@/components/legal/LegalPage";

export const metadata = { title: "Recovery and backup notice" };

export default function RecoveryPage() {
  return (
    <LegalPage
      title="What survives a restore."
      summary="Provider API keys cannot be recovered from a backup and are re-entered by hand after total project loss. This page says what else does and does not come back, so the answer is known before it matters."
    >
      <section>
        <h2>Why this page exists</h2>
        <p>
          A recovery limit an operator discovers during an outage is a different product from one they
          read about beforehand. This is the second kind. Nothing here is a change of behaviour — it is
          a description of how PassControl already stores things, published so that it can be relied on.
        </p>
      </section>

      <section>
        <h2>What comes back</h2>
        <p>These are configuration, held in ordinary database rows, and restore with the database:</p>
        <ul>
          <li>Agents: names, status, and their passport public keys.</li>
          <li>What each agent may reach — scopes, policy rules and failover order.</li>
          <li>Budgets, in tokens and in currency.</li>
          <li>Your ownership declaration, and whether it was verified.</li>
          <li>Call history, signed receipts and admin audit rows.</li>
        </ul>
        <p>
          Your passport <em>private</em> keys are not in that list and do not need to be: they are
          generated on your own machine and never sent to PassControl, so a restored agent still
          recognises the key you already hold.
        </p>
      </section>

      <section>
        <h2>What does not come back</h2>
        <table>
          <thead><tr><th>Item</th><th>Why</th><th>What to do</th></tr></thead>
          <tbody>
            <tr>
              <td>Provider API keys</td>
              <td>They are encrypted in Supabase Vault with a root key the hosting project holds and never writes into a database dump. A dump therefore contains ciphertext that only the original project can read, and the reference to it restores as a pointer to nothing.</td>
              <td>Re-enter one key per provider. Everything else about the credential — which agents used it, under what policy — is restored around it.</td>
            </tr>
            <tr>
              <td>Control API keys and Direct Agent Keys</td>
              <td>Only a hash of each key is stored, so that a stolen database does not yield working credentials. A hash cannot be turned back into a key.</td>
              <td>Issue new ones and update whatever holds them.</td>
            </tr>
            <tr>
              <td>Two-factor enrolment and recovery codes</td>
              <td>Enrolment lives with the authentication provider, and recovery codes are stored only as verifiers.</td>
              <td>Re-enrol two-factor authentication and generate fresh recovery codes.</td>
            </tr>
            <tr>
              <td>Active sessions</td>
              <td>Sessions are short-lived by design.</td>
              <td>Sign in again.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>Why the provider keys are not in the backup</h2>
        <p>
          Making provider keys recoverable across projects means producing an artifact that contains
          every operator&apos;s plaintext provider keys. That file is precisely what PassControl exists to
          prevent, and holding it would make us custodian of credentials we otherwise never hold. The
          cost of the decision is minutes of re-entry after a rare failure; the cost of the alternative
          is every operator&apos;s provider account, in one file, forever. We took the first.
        </p>
      </section>

      <section>
        <h2>Whether a backup exists at all</h2>
        <p>
          That depends on the hosting plan behind a given deployment, and PassControl cannot see it. The
          dashboard says so rather than displaying a reassuring tick it cannot justify. If you run your
          own deployment, check your database provider&apos;s backup settings directly. If someone else runs
          it for you, ask them what their restore procedure is and when it was last tested.
        </p>
      </section>

      <section>
        <h2>Taking your own copy</h2>
        <p>
          Any operator can export their workspace configuration as JSON at any time, from Dashboard →
          Settings → Recovery, or with <code>passcontrol export</code>. It contains agents, scopes,
          policies, budgets, failover order and your ownership declaration, and it deliberately contains
          no secret values — no provider keys, no key hashes, no two-factor material, no private signing
          keys. It can be restored into a fresh instance with <code>passcontrol import</code>, which
          creates what is missing and never modifies an agent that already exists.
        </p>
        <p>
          A restore goes into a <em>fresh</em> deployment, not alongside the workspace the file came
          from. A passport public key identifies exactly one agent per instance — that is how the
          gateway knows whose call it is holding — so importing a file back into the same instance
          refuses every agent whose passport is still registered there, and says so per agent rather
          than reporting them as already restored.
        </p>
      </section>
    </LegalPage>
  );
}
