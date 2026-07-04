import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { VertiasLogo, VertiasWordmark } from "@/components/VertiasLogo";
import {
  Shield,
  Zap,
  BarChart3,
  Lock,
  Eye,
  AlertTriangle,
  ArrowRight,
} from "lucide-react";

export const metadata = { title: "PassControl by Vertias — Identity & Credential Gateway for AI Agents" };

const FEATURES = [
  {
    icon: Shield,
    title: "Cryptographic Passports",
    body: "Each agent gets a unique Ed25519 passport. No agent ever holds the real API key — PassControl brokers all access in-flight.",
  },
  {
    icon: AlertTriangle,
    title: "Global Kill Switch",
    body: "Freeze your entire fleet in one move. When something goes wrong, you have absolute, instant control to suspend every agent.",
  },
  {
    icon: BarChart3,
    title: "Real-Time Spend Tracking",
    body: "Watch token usage and cost stream in live. Set per-agent budgets and hard-stop runaway agents before they burn your spend.",
  },
  {
    icon: Eye,
    title: "Complete Audit Trail",
    body: "Every action is logged and bound to the signing passport — filter by status, model, cost, latency, and JTI for full visibility.",
  },
  {
    icon: Lock,
    title: "Encrypted Vault",
    body: "Provider keys live encrypted in a vault, never in agent runtimes. Decrypted in-flight, cached briefly, purged on revocation.",
  },
  {
    icon: Zap,
    title: "Edge-Fast Verification",
    body: "Passport verification and key injection run at the edge — sub-millisecond crypto, no round-trip on the hot path.",
  },
];

const STEPS = [
  { n: "01", title: "Issue a passport", body: "Generate an Ed25519 keypair in your browser. The agent keeps the private key; we store only the public half." },
  { n: "02", title: "Mint a work visa", body: "The agent signs a challenge and gets a short-lived, scoped JWT — no secret ever travels the wire." },
  { n: "03", title: "Proxy & audit", body: "The gateway injects the real provider key, forwards the call, streams it back, and logs it against the passport." },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <nav className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <VertiasLogo size={24} />
            <VertiasWordmark size={18} />
            <span className="text-muted-foreground">/ PassControl</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="#features" className="text-sm text-muted-foreground transition-colors hover:text-primary">Features</a>
            <a href="#how-it-works" className="text-sm text-muted-foreground transition-colors hover:text-primary">How it works</a>
            <Link href="/login" className={buttonVariants()}>Sign in</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative overflow-hidden px-6 py-20 sm:py-28">
        <div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-2">
          <div className="space-y-8">
            <div className="inline-block rounded-sm border border-primary/30 bg-primary/10 px-3 py-1">
              <span className="text-xs font-medium text-primary">Non-Human Identity for AI agents</span>
            </div>
            <h1 className="text-5xl font-bold leading-tight sm:text-6xl">
              Identity &amp; credential gateway for <span className="text-primary">AI agents</span>
            </h1>
            <p className="max-w-lg text-xl text-muted-foreground">
              Your mission control. Manage autonomous agent fleets, track spend in real time, audit
              every action, and hit a kill switch the moment something goes wrong.
            </p>
            <div className="flex flex-col gap-4 sm:flex-row">
              <Link href="/signup" className={buttonVariants({ size: "lg" })}>
                Get started <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
              <a
                href="#how-it-works"
                className={buttonVariants({ size: "lg", variant: "secondary", className: "border border-border" })}
              >
                How it works
              </a>
            </div>
          </div>

          {/* Dashboard preview visual */}
          <div className="relative">
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-primary/20 to-transparent blur-3xl" />
            <div className="relative space-y-4 rounded-lg border border-border bg-card p-6">
              <div className="flex items-center justify-between rounded-sm border border-border bg-secondary p-4">
                <span className="text-sm font-medium">Kill Switch</span>
                <div className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full" style={{ background: "var(--success)" }} />
                  <span className="text-xs" style={{ color: "var(--success)" }}>DISARMED</span>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-sm border border-border bg-secondary p-3">
                  <p className="mb-1 text-xs text-muted-foreground">Active agents</p>
                  <p className="text-2xl font-bold text-primary">12</p>
                </div>
                <div className="rounded-sm border border-border bg-secondary p-3">
                  <p className="mb-1 text-xs text-muted-foreground">Today&apos;s spend</p>
                  <p className="text-2xl font-bold text-primary">$3.45</p>
                </div>
              </div>
              <div className="rounded-sm border border-border bg-secondary p-3">
                <p className="mb-2 text-xs text-muted-foreground">Budget burn-down</p>
                <div className="h-2 w-full overflow-hidden rounded-sm bg-muted">
                  <div className="h-full bg-primary" style={{ width: "69%" }} />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">69% of $5.00 budget used</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-t border-border px-6 py-20">
        <div className="mx-auto max-w-7xl">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-4xl font-bold">Complete agent management</h2>
            <p className="mx-auto max-w-2xl text-xl text-muted-foreground">
              Everything you need to securely manage, monitor, and control your AI agent fleet.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <Card key={title} className="border-border bg-card transition-colors hover:border-primary/40">
                <CardContent className="space-y-4 p-6">
                  <div className="flex h-12 w-12 items-center justify-center rounded-sm bg-primary/10">
                    <Icon className="h-6 w-6 text-primary" />
                  </div>
                  <h3 className="text-lg font-bold">{title}</h3>
                  <p className="text-muted-foreground">{body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="border-t border-border px-6 py-20">
        <div className="mx-auto max-w-7xl">
          <div className="mb-16 text-center">
            <h2 className="mb-4 text-4xl font-bold">How it works</h2>
            <p className="mx-auto max-w-2xl text-xl text-muted-foreground">
              The agent proves who it is — it never touches your keys.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            {STEPS.map(({ n, title, body }) => (
              <div key={n} className="rounded-lg border border-border bg-card p-6">
                <div className="mb-3 text-3xl font-bold text-primary">{n}</div>
                <h3 className="mb-2 text-lg font-bold">{title}</h3>
                <p className="text-muted-foreground">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t border-border px-6 py-20">
        <div className="mx-auto max-w-3xl space-y-6 text-center">
          <h2 className="text-4xl font-bold">Put your agents on a leash.</h2>
          <p className="text-xl text-muted-foreground">
            Issue a passport, set a budget, watch every call. Take back control of your AI fleet.
          </p>
          <Link href="/signup" className={buttonVariants({ size: "lg" })}>
            Get started <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border px-6 py-10">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 sm:flex-row">
          <div className="flex items-center gap-2">
            <VertiasLogo size={20} />
            <VertiasWordmark size={16} />
            <span className="text-sm text-muted-foreground">© {new Date().getFullYear()} Vertias</span>
          </div>
          <div className="flex items-center gap-6 text-sm text-muted-foreground">
            <a href="#" className="transition-colors hover:text-primary">Docs</a>
            <a href="#" className="transition-colors hover:text-primary">Privacy</a>
            <a href="#" className="transition-colors hover:text-primary">Terms</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
