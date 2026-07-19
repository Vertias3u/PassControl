import type { Metadata } from "next";
import {
  CurrentYear,
  DemoConsole,
  InstallCommand,
} from "@/components/PassControlSiteClient";

const REPO_URL = "https://github.com/Vertias3u/PassControl";

// FAQ — rendered visibly in the page AND emitted as FAQPage structured data from
// this one source, so the two never drift (search + AI engines require a match).
const FAQ_ITEMS: { q: string; a: string }[] = [
  {
    q: "What is PassControl?",
    a: "PassControl is a source-available identity and credential gateway for AI agents. Instead of putting your OpenAI or Anthropic key inside an agent, each agent gets a cryptographic identity and a short-lived, scoped token — and the gateway injects the real key only after the request passes policy.",
  },
  {
    q: "Does my agent ever hold my real API key?",
    a: "No. The agent holds a sign-only Ed25519 passport and mints a short-lived work-visa; the gateway resolves the real provider key from a vault and injects it in-flight, then proxies the call. The key never enters the agent runtime.",
  },
  {
    q: "Is PassControl open source?",
    a: "It's source-available under the Business Source License 1.1 — the full working core is free to inspect and self-host, but it is not an OSI open-source license. The plan is open-core: paid hosting and an accountability layer come later.",
  },
  {
    q: "Is it production-ready and audited?",
    a: "It's early (v0.2.x), built solo, and not yet independently audited — run it against a non-critical key first. It is built security-first (RLS on every table, a single service-role-only decrypt path, an append-only audit log, tenant-isolation tests), but test-covered and careful is not the same as audited.",
  },
  {
    q: "Which providers does it support?",
    a: "OpenAI, Anthropic, Groq, Mistral, Together, and DeepSeek today. Because it is a drop-in gateway, you keep your existing SDK and just point its base URL at PassControl.",
  },
  {
    q: "How is it different from LiteLLM, Portkey, or an LLM gateway?",
    a: "Those center on routing, caching, and observability behind a shared key. PassControl centers on per-agent cryptographic identity, capability scoping, per-agent budgets, and instant revocation — and it runs drop-in alongside them.",
  },
  {
    q: "Won't a 5-minute token break a long-running agent?",
    a: "No — the agent does not hold the visa. A local sidecar mints and auto-refreshes it (and re-mints instantly on a 401), so a multi-hour session never times out mid-task while revocation stays near-instant. A single long streaming call is verified once at the start and finishes regardless.",
  },
];

// Structured data (Schema.org) for search + AI answer engines. Truthful only:
// no ratings/reviews (there are none), price 0 = free to self-host under BSL 1.1.
const JSON_LD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://vertias.eu/#org",
      name: "Vertias",
      legalName: "Vertias ЕООД",
      url: "https://vertias.eu",
      email: "hello@vertias.eu",
      address: {
        "@type": "PostalAddress",
        addressLocality: "Sofia",
        addressCountry: "BG",
      },
      sameAs: ["https://github.com/Vertias3u/PassControl"],
    },
    {
      "@type": "WebSite",
      "@id": "https://passcontrol.vertias.eu/#website",
      url: "https://passcontrol.vertias.eu",
      name: "PassControl",
      inLanguage: "en",
      publisher: { "@id": "https://vertias.eu/#org" },
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
      softwareVersion: "0.2.0",
      license: "https://spdx.org/licenses/BUSL-1.1.html",
      publisher: { "@id": "https://vertias.eu/#org" },
      description:
        "Source-available identity and credential gateway for AI agents. Agents hold a sign-only Ed25519 passport and mint short-lived scoped work-visas; the gateway injects the real provider key from a vault, so the agent never holds your API key. Per-agent budgets, instant kill switch, and full audit.",
      featureList: [
        "Cryptographic agent identity (Ed25519 passport, sign-only)",
        "Short-lived scoped work-visas",
        "Per-agent token and dollar budgets enforced before the call",
        "Layered instant kill switch (platform, tenant, agent)",
        "Per-agent audit trail",
        "Vaulted provider keys, injected only after policy passes",
        "Drop-in gateway via OpenAI/Anthropic SDK base-URL swap",
        "Native MCP server",
      ],
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
        description: "Free to self-host (source-available, BSL 1.1).",
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
  title: "PassControl — Keep real API keys out of AI agents",
  description:
    "Source-available identity and credential gateway for AI agents. Enforce scope, budgets, revocation, and audit without giving agents real provider keys.",
  alternates: { canonical: "https://passcontrol.vertias.eu" },
  openGraph: {
    title: "PassControl — Your AI agents should never hold your real API keys",
    description:
      "Cryptographic agent identity, short-lived work-visas, budgets, instant revocation, and vaulted provider credentials.",
    type: "website",
    url: "https://passcontrol.vertias.eu",
    siteName: "PassControl",
  },
  twitter: {
    card: "summary",
    title: "PassControl — Keep real API keys out of AI agents",
    description:
      "Source-available identity and credential infrastructure for governed AI agent calls.",
  },
};

const CAPABILITIES = [
  {
    icon: "KV",
    title: "Keys stay vaulted",
    body: "Real OpenAI and Anthropic credentials are resolved inside the gateway only after a request passes policy. They never enter the agent runtime.",
  },
  {
    icon: "01",
    title: "Token + cost budgets",
    body: "Set both limits per agent. PassControl reserves budget atomically before the provider call, when enforcement can still prevent spend.",
  },
  {
    icon: "×",
    title: "Instant tenant kill switch",
    body: "Stop new requests at the gateway without rotating every provider key or reaching into every running agent process.",
  },
  {
    icon: "LOG",
    title: "Control Tower audit",
    body: "Inspect calls per agent and passport, with provider, model, status, token usage, cost, latency, and request identity in one operator view.",
  },
  {
    icon: "URL",
    title: "Drop-in gateway",
    body: "Keep the OpenAI or Anthropic SDK you already use. Re-point its base URL and pass a work-visa instead of a real provider credential.",
  },
  {
    icon: "MCP",
    title: "Native MCP server",
    body: "Run PassControl as an MCP server for Claude Desktop, Cursor, or Claude Code—the same scope, budgets, audit, and kill switch still apply.",
  },
];

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`pc-brand ${compact ? "pc-brand-compact" : ""}`}>
      <svg viewBox="0 0 58 62" fill="none" aria-hidden="true">
        <path d="M29 57C25 47 12 36 10 20 8 9 14 3 19 6c6 4 7 20 9 33 1 8 1 13 1 18Z" fill="#7fa933" />
        <path d="M29 57c-2-12-5-29-3-43 1-8 4-13 7-12 4 1 5 8 3 19-2 13-5 26-7 36Z" fill="#b7f34a" />
        <path d="M29 57c4-10 14-21 19-37 3-10-2-17-7-14-6 4-8 20-10 33-1 8-2 13-2 18Z" fill="#94c63b" />
      </svg>
      <span className="pc-wordmark">
        ver<span>·</span>tias
      </span>
      {!compact && <span className="pc-brand-product">/ PassControl</span>}
    </span>
  );
}

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

export default function LandingPage() {
  // Show a login entry only on local dev (`npm run dev`). The public
  // production build (passcontrol.vertias.eu) renders no login button for now.
  const showLogin = process.env.NODE_ENV === "development";

  return (
    <div className="pc-site" id="top">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />
      <a className="pc-skip-link" href="#main-content">
        Skip to content
      </a>

      <header className="pc-header">
        <nav className="pc-nav pc-container" aria-label="Primary navigation">
          <a href="#top" aria-label="PassControl home">
            <Brand />
          </a>
          <div className="pc-nav-links">
            <a href="#how-it-works">How it works</a>
            <a href="#live-demo">Live demo</a>
            <a href="#capabilities">Capabilities</a>
            {showLogin && (
              <a className="pc-nav-login" href="/login">
                Log in
              </a>
            )}
          </div>
          <a className="pc-source-pill" href={REPO_URL} target="_blank" rel="noreferrer">
            <span className="pc-signal-dot" aria-hidden="true" />
            Source-available
          </a>
        </nav>
      </header>

      <main id="main-content">
        <section className="pc-hero" aria-labelledby="hero-title">
          <div className="pc-hero-grid pc-container">
            <div className="pc-hero-copy">
              <p className="pc-kicker">PassControl / Agent credential gateway</p>
              <h1 id="hero-title">
                Your AI agents should never hold your <em>real API keys.</em>
              </h1>
              <p className="pc-hero-lead">
                <strong>Give agents cryptographic identity—not the credentials that pay for their calls.</strong>{" "}
                PassControl verifies each agent, enforces scope and budget, injects the vaulted provider key, and proxies the request. The key never reaches the agent.
              </p>
              <InstallCommand />
              <div className="pc-hero-actions">
                <a className="pc-primary-link" href="#live-demo">
                  Try the live gateway <span aria-hidden="true">↓</span>
                </a>
                <a className="pc-text-link" href={REPO_URL} target="_blank" rel="noreferrer">
                  View source <Arrow />
                </a>
              </div>
            </div>

            <div className="pc-hero-visual" aria-label="What the agent holds and what stays outside its runtime">
              <div className="pc-orbit pc-orbit-one" aria-hidden="true" />
              <div className="pc-orbit pc-orbit-two" aria-hidden="true" />
              <article className="pc-exposure-card">
                <div className="pc-card-bar">
                  <span>Agent runtime / credential exposure</span>
                  <span className="pc-live-state"><i /> protected</span>
                </div>
                <div className="pc-holds-row">
                  <span className="pc-mini-label">Agent holds</span>
                  <strong>Ed25519 passport</strong>
                  <code>sign-only private key</code>
                </div>
                <div className="pc-signature-bars" aria-hidden="true">
                  {[18, 32, 23, 38, 14, 29, 20, 35, 16, 26, 11, 31].map((height, index) => (
                    <i key={index} style={{ height }} />
                  ))}
                  <span>signs locally</span>
                </div>
                <div className="pc-never-row">
                  <span className="pc-mini-label">Agent never receives</span>
                  <code>sk-proj-••••••••••••••••</code>
                  <span className="pc-vaulted-state">vaulted</span>
                </div>
              </article>
              <div className="pc-visa-float" aria-hidden="true">
                <span>Work-visa</span>
                <strong>scope · budget · 05:00</strong>
              </div>
              <p className="pc-visual-caption">Identity travels · provider secrets do not</p>
            </div>
          </div>
        </section>

        <aside className="pc-trust-strip" aria-label="Product facts">
          <div className="pc-trust-grid pc-container">
            <div><strong>Source-available</strong><span>Full working core · BSL 1.1</span></div>
            <div><strong>Self-hostable</strong><span>Your infrastructure and vault</span></div>
            <div><strong>Short-lived access</strong><span>Five-minute scoped work-visas</span></div>
            <div><strong>MCP + SDKs</strong><span>Meet agents where they already run</span></div>
          </div>
        </aside>

        <section className="pc-section" id="how-it-works" aria-labelledby="how-title">
          <div className="pc-container">
            <div className="pc-section-heading">
              <div>
                <p className="pc-section-kicker">01 / Trust boundary</p>
                <h2 id="how-title">Identity crosses the boundary. Secrets do not.</h2>
              </div>
              <p>
                The passport only signs. A short-lived work-visa carries identity and policy into a gateway that checks every request before resolving a provider credential.
              </p>
            </div>

            <figure className="pc-trust-diagram">
              <div className="pc-diagram-labels" aria-hidden="true">
                <span>Untrusted agent runtime</span>
                <span>PassControl security boundary</span>
                <span>Provider edge</span>
              </div>
              <div className="pc-diagram-track">
                <article className="pc-zone pc-agent-zone">
                  <span className="pc-zone-number">01</span>
                  <div className="pc-zone-icon">ED</div>
                  <h3>Passport signs</h3>
                  <p>The private Ed25519 key signs a one-time challenge locally. It is never sent on the wire.</p>
                  <code>signature(challenge)</code>
                </article>

                <div className="pc-diagram-connector">
                  <span>signed proof</span>
                  <i aria-hidden="true" />
                </div>

                <article className="pc-zone pc-gateway-zone">
                  <span className="pc-zone-number">02—05</span>
                  <div className="pc-visa-chip">
                    <span>Work-visa minted</span>
                    <strong>agent · scope · budget · jti</strong>
                  </div>
                  <h3>Gateway governs</h3>
                  <ol className="pc-policy-stack">
                    <li><span>01</span><strong>Verify visa</strong><small>identity + expiry</small></li>
                    <li><span>02</span><strong>Check kill switch</strong><small>platform + tenant + agent</small></li>
                    <li><span>03</span><strong>Enforce scope</strong><small>provider + model + endpoint</small></li>
                    <li><span>04</span><strong>Reserve budget</strong><small>tokens + cost before call</small></li>
                  </ol>
                  <div className="pc-vault-branch">
                    <span className="pc-zone-icon">KV</span>
                    <div><strong>Provider vault</strong><code>key injected only after ✓</code></div>
                  </div>
                </article>

                <div className="pc-diagram-connector pc-diagram-connector-out">
                  <span>governed request</span>
                  <i aria-hidden="true" />
                </div>

                <article className="pc-zone pc-provider-zone">
                  <span className="pc-zone-number">06</span>
                  <div className="pc-zone-icon">AI</div>
                  <h3>Provider receives</h3>
                  <p>PassControl injects the real key in-flight, proxies the call, streams the response, and records the audit.</p>
                  <div className="pc-provider-list"><span>OpenAI</span><span>Anthropic</span></div>
                </article>
              </div>
              <figcaption>
                <span>Policy order is the security boundary</span>
                verify → kill → scope → budget → key → provider
              </figcaption>
            </figure>
          </div>
        </section>

        <section className="pc-section pc-demo-section" id="live-demo" aria-labelledby="demo-title">
          <div className="pc-container">
            <div className="pc-section-heading pc-demo-heading">
              <div>
                <p className="pc-section-kicker">02 / Live keyless demo</p>
                <h2 id="demo-title">Feel the control boundary.</h2>
              </div>
              <p>
                This is a synthesized response, clearly marked <code>[demo]</code>. The surrounding pipeline is real: challenge signing, work-visa, scope, budget, audit, and the demo tenant kill switch.
              </p>
            </div>
            <DemoConsole />
            <div className="pc-demo-footnotes">
              <span><i>✓</i> Real gateway policy checks</span>
              <span><i>✓</i> No provider call</span>
              <span><i>✓</i> No Vault access</span>
              <span><i>✓</i> Demo-only tenant + scope</span>
            </div>
          </div>
        </section>

        <section className="pc-section pc-capabilities" id="capabilities" aria-labelledby="capabilities-title">
          <div className="pc-container">
            <div className="pc-section-heading">
              <div>
                <p className="pc-section-kicker">03 / Control Tower</p>
                <h2 id="capabilities-title">Control each agent at the gateway.</h2>
              </div>
              <p>
                One inspectable policy boundary for agent identity, credential access, spend, revocation, and the record of every governed call.
              </p>
            </div>
            <div className="pc-capability-grid">
              {CAPABILITIES.map((capability) => (
                <article className="pc-capability-card" key={capability.title}>
                  <span className="pc-capability-icon" aria-hidden="true">{capability.icon}</span>
                  <h3>{capability.title}</h3>
                  <p>{capability.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="pc-section pc-drop-in" aria-labelledby="drop-in-title">
          <div className="pc-drop-in-grid pc-container">
            <div className="pc-drop-in-copy">
              <p className="pc-section-kicker">04 / Drop-in adoption</p>
              <h2 id="drop-in-title">Change the route, not the agent.</h2>
              <p>
                Keep the SDK and call shape you already use. Point the base URL at PassControl and supply the short-lived work-visa where the SDK expects an API key.
              </p>
              <div className="pc-integration-tags" aria-label="Supported integration patterns">
                <span>OpenAI SDK</span><span>Anthropic SDK</span><span>Claude Desktop</span><span>Cursor</span><span>Claude Code</span>
              </div>
              <a className="pc-inline-link" href={REPO_URL} target="_blank" rel="noreferrer">
                Inspect the complete core <Arrow />
              </a>
            </div>

            <div className="pc-code-window" aria-label="Example OpenAI SDK configuration">
              <div className="pc-code-bar">
                <span>agent.ts</span>
                <span><i /><i /><i /></span>
              </div>
              <pre><code><span className="pc-code-comment">// Same SDK. Governed credential path.</span>{"\n"}<span className="pc-code-key">const</span> client = <span className="pc-code-key">new</span> OpenAI({`{`}{"\n"}  baseURL: <span className="pc-code-value">&quot;https://your-gateway/api/v1/openai&quot;</span>,{"\n"}  apiKey: workVisa,{"\n"}{`}`});{"\n\n"}<span className="pc-code-key">const</span> response = <span className="pc-code-key">await</span> client.chat.completions.create({`{`}{"\n"}  model: <span className="pc-code-value">&quot;your-model&quot;</span>,{"\n"}  messages,{"\n"}{`}`});</code></pre>
              <div className="pc-mcp-line"><span>MCP</span><code>passcontrol mcp</code><small>same policy boundary</small></div>
            </div>
          </div>
        </section>

        <section className="pc-section pc-faq-section" id="faq" aria-labelledby="faq-title">
          <div className="pc-container">
            <div className="pc-section-heading">
              <div>
                <p className="pc-section-kicker">05 / FAQ</p>
                <h2 id="faq-title">Questions, answered honestly.</h2>
              </div>
              <p>
                The short version of what PassControl is, what it protects, and what it does
                not — no marketing gloss.
              </p>
            </div>
            <div className="pc-faq">
              {FAQ_ITEMS.map((item) => (
                <details className="pc-faq-item" key={item.q}>
                  <summary>
                    <span>{item.q}</span>
                    <i aria-hidden="true" />
                  </summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className="pc-cta-section" aria-labelledby="cta-title">
          <div className="pc-cta pc-container">
            <p className="pc-section-kicker">Source-available / Self-host</p>
            <h2 id="cta-title">Your agents need identity. Your keys need distance.</h2>
            <p>Run the complete PassControl core on your own infrastructure and inspect every line in the credential path.</p>
            <div>
              <a className="pc-dark-button" href={REPO_URL} target="_blank" rel="noreferrer">View on GitHub <Arrow /></a>
              <a className="pc-dark-text" href="mailto:hello@vertias.eu">hello@vertias.eu</a>
            </div>
            <p>
              Early (v0.1.x), built in the open, not yet independently audited — run it against a
              non-critical key first.{" "}
              <a
                className="pc-dark-text"
                href={`${REPO_URL}/blob/main/SECURITY.md`}
                target="_blank"
                rel="noreferrer"
              >
                Security policy <Arrow />
              </a>
            </p>
          </div>
        </section>
      </main>

      <footer className="pc-footer">
        <div className="pc-footer-grid pc-container">
          <Brand compact />
          <p>
            Source-available under BSL 1.1 · free to self-host<br />
            © <CurrentYear /> Vertias ЕООД · Sofia, Bulgaria · <a href="mailto:hello@vertias.eu">hello@vertias.eu</a>
          </p>
          <a href="#top">Back to top ↑</a>
        </div>
      </footer>
    </div>
  );
}
