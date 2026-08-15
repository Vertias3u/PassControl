import type { Metadata } from "next";
import {
  ArrowDown,
  ArrowUpRight,
  Check,
  Cloud,
  Server,
  ShieldCheck,
} from "lucide-react";
import {
  CurrentYear,
  DemoConsole,
  SelfHostCommands,
} from "@/components/PassControlSiteClient";
import { VertiasLogo } from "@/components/VertiasLogo";
import { RELEASE_VERSION } from "@/lib/version";
import styles from "./home.module.css";

const REPO_URL = "https://github.com/Vertias3u/PassControl";
const INVITE_URL = "/beta";

// One source for the visible questions and FAQPage structured data.
const FAQ_ITEMS = [
  {
    q: "Where does my provider key live?",
    a: "In PassControl Cloud it is stored server-side and fetched only after a call passes the gate. In a self-hosted deployment it remains in infrastructure you operate. The agent does not receive it.",
  },
  {
    q: "Does my agent need a new SDK?",
    a: "Usually not. Compatible tools use a PassControl base URL and scoped agent credential. Passport authentication remains available when stronger cryptographic identity is needed.",
  },
  {
    q: "Can I inspect or run PassControl myself?",
    a: "Yes. The core is source-available under BSL 1.1 and includes a self-hosted deployment path.",
  },
] as const;

const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Person",
      "@id": "https://vertias.eu/#owner",
      name: "Kristiyan Ivanov",
      alternateName: "Vertias",
      url: "https://vertias.eu",
      email: "hello@vertias.eu",
      address: {
        "@type": "PostalAddress",
        addressLocality: "Sofia",
        addressCountry: "BG",
      },
      sameAs: [REPO_URL],
    },
    {
      "@type": "WebSite",
      "@id": "https://passcontrol.vertias.eu/#website",
      url: "https://passcontrol.vertias.eu",
      name: "PassControl",
      inLanguage: "en",
      publisher: { "@id": "https://vertias.eu/#owner" },
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://passcontrol.vertias.eu/#software",
      name: "PassControl",
      applicationCategory: "SecurityApplication",
      applicationSubCategory: "AI agent identity and credential gateway",
      operatingSystem: "Cross-platform (self-hosted; Docker)",
      url: "https://passcontrol.vertias.eu",
      downloadUrl: REPO_URL,
      softwareVersion: RELEASE_VERSION,
      license: "https://spdx.org/licenses/BUSL-1.1.html",
      publisher: { "@id": "https://vertias.eu/#owner" },
      description:
        "Give every AI agent its own identity, scope and budget. PassControl checks each model call while keeping provider keys out of agent environments.",
      featureList: [
        "Per-agent identity and credentials",
        "Provider and model scope",
        "Per-agent token and cost budgets",
        "Layered kill switch",
        "Verifiable call receipts",
        "Server-side provider-key use",
      ],
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
        description: "Free invite-only Cloud beta and a free self-hosted path under BSL 1.1.",
      },
    },
    {
      "@type": "FAQPage",
      "@id": "https://passcontrol.vertias.eu/#faq",
      mainEntity: FAQ_ITEMS.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    },
  ],
};

export const metadata: Metadata = {
  title: "PassControl — API key control for AI agents",
  description:
    "Give every AI agent its own identity, scope and budget. PassControl checks each model call while keeping provider keys out of agent environments.",
  alternates: { canonical: "https://passcontrol.vertias.eu" },
  openGraph: {
    title: "PassControl — Agents get access. You keep control.",
    description:
      "Identity, scope and budgets for every model call, without putting provider keys in agent environments.",
    type: "website",
    url: "https://passcontrol.vertias.eu",
    siteName: "PassControl",
  },
  twitter: {
    card: "summary_large_image",
    title: "PassControl — Agents get access. You keep control.",
    description:
      "Check identity, scope and budget before each model call while provider keys stay server-side.",
  },
};

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={styles.brand}>
      <VertiasLogo size={compact ? 24 : 27} />
      <span className={styles.wordmark}>ver<span>·</span>tias</span>
      {!compact && <span className={styles.productName}>/ PassControl</span>}
    </span>
  );
}

const CALL_STEPS = [
  "Identity verified",
  "Scope allowed",
  "Budget reserved",
  "Provider call dispatched",
  "Receipt returned",
];

export default function LandingPage() {
  return (
    <div className={styles.site} id="top">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />
      <a className={styles.skipLink} href="#main-content">
        Skip to content
      </a>

      <header className={styles.header}>
        <nav className={`${styles.container} ${styles.nav}`} aria-label="Primary navigation">
          <a className={styles.brandLink} href="#top" aria-label="PassControl home">
            <Brand />
          </a>
          <div className={styles.navLinks}>
            <a href="#how-it-works">How it works</a>
            <a href="#live-demo">Live demo</a>
            <a href={REPO_URL} target="_blank" rel="noreferrer">Source</a>
            <a href="/login">Sign in</a>
          </div>
          <a className={styles.navCta} href={INVITE_URL}>
            Request beta access
          </a>
        </nav>
      </header>

      <main id="main-content">
        <section className={styles.hero} aria-labelledby="hero-title">
          <div className={`${styles.container} ${styles.heroGrid}`}>
            <div className={styles.heroCopy}>
              <p className={styles.eyebrow}>Private beta <span>·</span> Source available</p>
              <h1 id="hero-title">Agents get access. <em>You keep control.</em></h1>
              <p className={styles.heroLead}>
                PassControl gives every AI agent its own identity, scope and budget. Each
                model call is checked before PassControl uses your provider key server-side.
              </p>
              <div className={styles.heroActions}>
                <a className={styles.primaryButton} href={INVITE_URL}>Request beta access</a>
                <a className={styles.secondaryButton} href="#live-demo">
                  Run the live demo <ArrowDown aria-hidden="true" />
                </a>
                <a className={styles.textLink} href={REPO_URL} target="_blank" rel="noreferrer">
                  Inspect the source <ArrowUpRight aria-hidden="true" />
                </a>
              </div>
              <p className={styles.availability}>
                Cloud access is invite-only. Self-hosting is available now.
              </p>
            </div>

            <div className={styles.callPanel} aria-label="Governed model call">
              <div className={styles.callPanelHeader}>
                <div>
                  <span className={styles.statusDot} aria-hidden="true" />
                  <span>governed call</span>
                </div>
                <strong>allowed</strong>
              </div>
              <div className={styles.callIdentity}>
                <span>Agent</span>
                <strong>research-assistant</strong>
                <code>openai / gpt-5</code>
              </div>
              <ol className={styles.callSteps}>
                {CALL_STEPS.map((step, index) => (
                  <li key={step}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <strong>{step}</strong>
                    <Check aria-hidden="true" />
                  </li>
                ))}
              </ol>
              <div className={styles.callPanelFooter}>
                <span>provider key</span>
                <strong>server-side only</strong>
              </div>
            </div>
          </div>

          <div className={`${styles.container} ${styles.proofBar}`} aria-label="PassControl guarantees">
            <p><ShieldCheck aria-hidden="true" /> Provider keys stay out of agent environments.</p>
            <p><ShieldCheck aria-hidden="true" /> Suspend one agent without rotating shared keys.</p>
            <p><ShieldCheck aria-hidden="true" /> Allowed calls return a verifiable receipt.</p>
          </div>
        </section>

        <section className={`${styles.section} ${styles.demoSection}`} id="live-demo" aria-labelledby="demo-title">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>Live control-path demo</p>
              <h2 id="demo-title">Test the boundary.</h2>
              <p>
                Send a call through PassControl&apos;s real identity, scope, budget and
                kill-switch path. Then block the agent and try again.
              </p>
            </div>
            <DemoConsole />
            <p className={styles.demoDisclosure}>
              This demo does not contact a paid model or access a provider key. The control
              decisions are real; the model response is simulated.
            </p>
          </div>
        </section>

        <section className={styles.section} id="how-it-works" aria-labelledby="how-title">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>One boundary per agent</p>
              <h2 id="how-title">What happens before the provider sees a call.</h2>
            </div>

            <div className={styles.decisionGrid}>
              <article>
                <span>01</span>
                <h3>Identify</h3>
                <p>PassControl resolves the individual agent instead of trusting a shared provider key.</p>
              </article>
              <article>
                <span>02</span>
                <h3>Decide</h3>
                <p>Kill state, suspension, provider and model scope, live policy, rate limit and budget are checked.</p>
              </article>
              <article>
                <span>03</span>
                <h3>Dispatch</h3>
                <p>If allowed, PassControl uses the provider credential server-side and returns the result with a signed receipt.</p>
              </article>
            </div>

            <div className={styles.consequence}>
              <ShieldCheck aria-hidden="true" />
              <strong>A blocked call never reaches the provider.</strong>
            </div>

            <div className={styles.audienceGrid}>
              <p><strong>For builders</strong> Change the model API base URL and give the agent a scoped PassControl credential.</p>
              <p><strong>For operators</strong> Limit, suspend or investigate one agent without disrupting the rest of the fleet.</p>
            </div>
          </div>
        </section>

        <section className={`${styles.section} ${styles.launchSection}`} id="start" aria-labelledby="start-title">
          <div className={styles.container}>
            <div className={styles.sectionIntro}>
              <p className={styles.eyebrow}>Choose the operating model</p>
              <h2 id="start-title">Use our Cloud. Or run the same core yourself.</h2>
            </div>

            <div className={styles.pathGrid}>
              <article className={styles.pathCard}>
                <Cloud aria-hidden="true" />
                <span>Hosted</span>
                <h3>PassControl Cloud</h3>
                <p>Start without operating the gateway. PassControl Cloud stores provider credentials server-side and gives each agent its own controlled access.</p>
                <a className={styles.primaryButton} href={INVITE_URL}>Request beta access</a>
              </article>

              <article className={`${styles.pathCard} ${styles.selfHostCard}`}>
                <Server aria-hidden="true" />
                <span>Your infrastructure</span>
                <h3>Run it yourself</h3>
                <p>Inspect the source and run PassControl in infrastructure you control.</p>
                <SelfHostCommands />
                <div className={styles.cardLinks}>
                  <a href={REPO_URL} target="_blank" rel="noreferrer">View source <ArrowUpRight aria-hidden="true" /></a>
                  <a href={`${REPO_URL}#quickstart-self-host`} target="_blank" rel="noreferrer">Read self-hosting guide <ArrowUpRight aria-hidden="true" /></a>
                </div>
              </article>
            </div>

            <div className={styles.faqBlock} id="faq">
              <div>
                <p className={styles.eyebrow}>Straight answers</p>
                <h2>Before you put it in the path.</h2>
              </div>
              <div className={styles.faqList}>
                {FAQ_ITEMS.map((item) => (
                  <details key={item.q}>
                    <summary>{item.q}<span aria-hidden="true">+</span></summary>
                    <p>{item.a}</p>
                  </details>
                ))}
              </div>
            </div>

            <div className={styles.finalCta}>
              <p className={styles.eyebrow}>Start with one agent</p>
              <h2>Put one real agent behind PassControl.</h2>
              <div>
                <a className={styles.primaryButton} href={INVITE_URL}>Request beta access</a>
                <a className={styles.secondaryButton} href="#live-demo">Run the live demo <ArrowDown aria-hidden="true" /></a>
              </div>
              <p className={styles.auditNote}>
                Early and not yet independently audited. Start with a non-critical provider key.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={`${styles.container} ${styles.footerGrid}`}>
          <div>
            <Brand compact />
            <p className={styles.signature}>Identity crosses the boundary. Secrets do not.</p>
          </div>
          <div className={styles.footerLinks}>
            <a href="/verify">Verify a receipt</a>
            <a href="/legal/privacy">Privacy</a>
            <a href="/legal/terms">Beta terms</a>
            <a href={REPO_URL} target="_blank" rel="noreferrer">Source</a>
            <a href={`${REPO_URL}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer">Security</a>
            <a href="mailto:hello@vertias.eu">Contact</a>
          </div>
          <p className={styles.legal}>
            Source-available under BSL 1.1 · © <CurrentYear /> Kristiyan Ivanov · Vertias project · Sofia, Bulgaria
          </p>
        </div>
      </footer>
    </div>
  );
}
