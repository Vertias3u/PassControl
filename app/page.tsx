import type { Metadata } from "next";
import {
  ArrowDown,
  ArrowRight,
  Check,
  KeyRound,
  Server,
  ShieldCheck,
  Terminal,
} from "lucide-react";
import styles from "./home.module.css";

export const metadata: Metadata = {
  title: "PassControl — Self-hosted control for AI agents",
  description:
    "Run an identity, scope, budget, and credential boundary for AI agents on infrastructure you control.",
};

const controls = [
  {
    number: "01",
    title: "Identify every caller",
    copy: "Give each agent a short-lived passport tied to a tenant, environment, and workload instead of handing it a provider credential.",
  },
  {
    number: "02",
    title: "Decide before dispatch",
    copy: "Check scope, budget, rate limits, and kill state before a request can leave your boundary.",
  },
  {
    number: "03",
    title: "Keep the evidence",
    copy: "Emit a signed receipt for every allowed or denied call so operators can reconstruct what happened.",
  },
];

const requirements = [
  ["Docker Desktop", "Runs the local Supabase and Redis services."],
  ["Supabase CLI", "Boots the local database, Auth, and Vault stack."],
  ["Node 18+", "Runs the control plane and PassControl CLI."],
] as const;

export default function SelfHostHome() {
  return (
    <div className={styles.site}>
      <a className={styles.skipLink} href="#main">
        Skip to content
      </a>

      <header className={styles.header}>
        <nav className={`${styles.container} ${styles.nav}`} aria-label="Primary navigation">
          <a className={styles.brandLink} href="#top" aria-label="PassControl home">
            <span className={styles.brand}>
              <ShieldCheck size={22} aria-hidden="true" />
              <span className={styles.wordmark}>PassControl</span>
              <span className={styles.productName}>Self-host</span>
            </span>
          </a>
          <div className={styles.navLinks}>
            <a href="#how-it-works">How it works</a>
            <a href="#quickstart">Quickstart</a>
            <a href="#trust">Trust model</a>
          </div>
          <a className={styles.navCta} href="#quickstart">
            Install and run <ArrowDown aria-hidden="true" />
          </a>
        </nav>
      </header>

      <main id="main">
        <section className={styles.hero} id="top">
          <div className={`${styles.container} ${styles.heroGrid}`}>
            <div className={styles.heroCopy}>
              <p className={styles.eyebrow}>Self-hosted agent control plane</p>
              <h1>
                Run the boundary. <em>Keep the keys.</em>
              </h1>
              <p className={styles.heroLead}>
                PassControl puts identity, scope, budget, and kill controls between AI agents and
                the services they call. Provider keys stay server-side, inside infrastructure you
                operate.
              </p>
              <div className={styles.heroActions}>
                <a className={styles.primaryButton} href="#quickstart">
                  Start the local stack <ArrowRight aria-hidden="true" />
                </a>
                <a className={styles.textLink} href="#how-it-works">
                  Inspect the control path <ArrowDown aria-hidden="true" />
                </a>
              </div>
              <p className={styles.availability}>
                Source-available · Business Source License 1.1 · Runs on your machine
              </p>
            </div>

            <aside className={styles.callPanel} aria-label="Example PassControl request">
              <div className={styles.callPanelHeader}>
                <div>
                  <span className={styles.statusDot} aria-hidden="true" />
                  control path
                </div>
                <strong>local</strong>
              </div>
              <div className={styles.callIdentity}>
                <span>Agent passport</span>
                <strong>deploy-reviewer</strong>
                <code>environment: staging · tenant: acme</code>
              </div>
              <ol className={styles.callSteps}>
                <li>
                  <span>01</span><strong>Identity verified</strong><Check aria-hidden="true" />
                </li>
                <li>
                  <span>02</span><strong>Scope allows provider call</strong><Check aria-hidden="true" />
                </li>
                <li>
                  <span>03</span><strong>Budget reserved</strong><Check aria-hidden="true" />
                </li>
                <li>
                  <span>04</span><strong>Kill state clear</strong><Check aria-hidden="true" />
                </li>
              </ol>
              <div className={styles.callPanelFooter}>
                <span>Signed receipt</span>
                <strong>issued</strong>
              </div>
            </aside>
          </div>

          <div className={`${styles.container} ${styles.proofBar}`} aria-label="Core properties">
            <p><KeyRound aria-hidden="true" /> Provider credentials never enter agent environments.</p>
            <p><Server aria-hidden="true" /> The gateway, database, Vault, and Redis run locally.</p>
            <p><ShieldCheck aria-hidden="true" /> Every decision produces an auditable receipt.</p>
          </div>
        </section>

        <section className={styles.section} id="how-it-works">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>The control path</p>
              <h2>One boundary before every provider call.</h2>
              <p>
                Agents carry identity, not long-lived secrets. PassControl evaluates the request,
                retrieves the provider credential only after approval, and records the outcome.
              </p>
            </div>
            <div className={styles.decisionGrid}>
              {controls.map((control) => (
                <article key={control.number}>
                  <span>{control.number}</span>
                  <h3>{control.title}</h3>
                  <p>{control.copy}</p>
                </article>
              ))}
            </div>
            <div className={styles.consequence}>
              <ShieldCheck aria-hidden="true" />
              <strong>The agent receives a result, never the provider key that produced it.</strong>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.launchSection}`} id="quickstart">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>Self-host quickstart</p>
              <h2>From checkout to a running Control Tower.</h2>
              <p>
                Install the CLI, let it verify the local prerequisites, and start the complete
                Supabase and Redis-backed stack.
              </p>
            </div>

            <div className={styles.pathGrid}>
              <article className={`${styles.pathCard} ${styles.selfHostCard}`}>
                <Terminal aria-hidden="true" />
                <span>01 · Run</span>
                <h3>Two commands.</h3>
                <p>
                  The setup command checks prerequisites, fetches the self-host stack, starts its
                  services, applies migrations, seeds local data, and opens the dashboard.
                </p>
                <div className={styles.commandBlock} aria-label="PassControl installation commands">
                  <pre><code><span>npm install -g passcontrol</span>{"\n"}<span>passcontrol setup</span></code></pre>
                </div>
              </article>

              <article className={styles.pathCard}>
                <Server aria-hidden="true" />
                <span>02 · Prerequisites</span>
                <h3>Bring a local container stack.</h3>
                <p>
                  Setup checks these dependencies before it changes anything, then reports the
                  exact repair command if one is missing.
                </p>
                <div className={styles.cardLinks}>
                  {requirements.map(([name, description]) => (
                    <p key={name}>
                      <strong>{name}</strong><br />{description}
                    </p>
                  ))}
                </div>
              </article>
            </div>

            <div className={styles.audienceGrid}>
              <p>
                <strong>Ports already occupied?</strong>
                Run <code>passcontrol setup --port-offset 100</code> to move the local stack as a unit.
              </p>
              <p>
                <strong>Working from a checkout?</strong>
                Run <code>npm run cli -- setup</code> to use the repository CLI without a global install.
              </p>
            </div>
          </div>
        </section>

        <section className={styles.section} id="trust">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>Trust model</p>
              <h2>Own the system that owns the credentials.</h2>
              <p>
                Self-hosting keeps the control plane, encrypted provider credentials, policy state,
                and audit trail inside your operational boundary.
              </p>
            </div>
            <div className={styles.decisionGrid}>
              <article>
                <span>Keys</span>
                <h3>Server-side by construction</h3>
                <p>Provider secrets are retrieved only inside the gateway after policy approval.</p>
              </article>
              <article>
                <span>Control</span>
                <h3>Immediate suspension</h3>
                <p>Tenant and agent kill controls stop new work before another provider call is made.</p>
              </article>
              <article>
                <span>Evidence</span>
                <h3>Receipts over guesswork</h3>
                <p>Signed receipts preserve the identity, decision, timing, and outcome of each call.</p>
              </article>
            </div>

            <div className={styles.finalCta}>
              <p className={styles.eyebrow}>Ready to inspect it locally?</p>
              <h2>Install PassControl and run the stack you control.</h2>
              <div>
                <a className={styles.primaryButton} href="#quickstart">
                  Open the quickstart <ArrowRight aria-hidden="true" />
                </a>
                <a className={styles.secondaryButton} href="#how-it-works">
                  Review the boundary
                </a>
              </div>
              <p className={styles.auditNote}>No account required. No hosted control plane in the path.</p>
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={`${styles.container} ${styles.footerGrid}`}>
          <div>
            <span className={styles.brand}>
              <ShieldCheck size={20} aria-hidden="true" />
              <span className={styles.wordmark}>PassControl</span>
            </span>
            <p className={styles.signature}>Agent access with an operator in the loop.</p>
          </div>
          <div className={styles.footerLinks}>
            <a href="#how-it-works">How it works</a>
            <a href="#quickstart">Quickstart</a>
            <a href="#trust">Trust model</a>
          </div>
          <p className={styles.legal}>
            Source-available under the Business Source License 1.1. Review the repository license
            before production use.
          </p>
          <p className={styles.cloudAlternative}>
            Prefer not to operate Postgres, Redis, or migrations? <a href="https://passcontrol.vertias.eu/beta">PassControl Cloud</a>
            {" "}runs them and signs receipts under a permanent public issuer. Access is invite-only.
          </p>
        </div>
      </footer>
    </div>
  );
}
