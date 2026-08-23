import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const LEGAL_PAGES = [
  "app/legal/page.tsx",
  "app/legal/privacy/page.tsx",
  "app/legal/terms/page.tsx",
  "app/legal/acceptable-use/page.tsx",
  "app/legal/cookies/page.tsx",
  "app/legal/subprocessors/page.tsx",
  "app/legal/recovery/page.tsx",
] as const;

describe("pre-launch legal surface", () => {
  it("keeps every legal route public while the dashboard remains gated", async () => {
    const middleware = await source("middleware.ts");
    expect(middleware).toContain('"/legal"');
    expect(middleware).toContain("if (!user && !isPublic(pathname))");
  });

  it("marks the whole legal tree noindex while the effective date is unresolved", async () => {
    const [layout, shell] = await Promise.all([
      source("app/legal/layout.tsx"),
      source("components/legal/LegalPage.tsx"),
    ]);
    expect(layout).toContain("index: false");
    expect(layout).toContain("follow: false");
    expect(shell).toContain("Pre-launch draft");
    expect(shell).toContain("effective date");
  });

  it("publishes the supplied operator identity without inventing a company or address", async () => {
    const files = await Promise.all([
      source("app/page.tsx"),
      source("app/llms.txt/route.ts"),
      source("components/legal/LegalPage.tsx"),
      source("LICENSE"),
      ...LEGAL_PAGES.map(source),
    ]);
    const combined = files.join("\n");
    expect(combined).toContain("Kristiyan Ivanov");
    expect(combined).not.toContain("Vertias ЕООД");
    expect(combined).not.toContain('legalName: "Vertias');
    expect(combined).toContain("PUBLIC_SERVICE_ADDRESS &&");
    expect(combined).not.toContain('PUBLIC_SERVICE_ADDRESS ?? "pending"');
  });

  it("states the free invite-only beta terms and the provider-cost boundary", async () => {
    const terms = await source("app/legal/terms/page.tsx");
    expect(terms).toContain("free, invite-only, experimental service");
    expect(terms).toContain("No paid PassControl subscription");
    expect(terms).toContain("model providers may still charge you");
  });

  it("does not make the stored-call record sound like stored prompt content", async () => {
    const privacy = await source("app/legal/privacy/page.tsx");
    expect(privacy).toContain("process model requests and responses in plaintext");
    expect(privacy).toContain("does not store prompts or model responses");
    expect(privacy).toContain("retained while your beta account is active");
    expect(privacy).toContain("Permanent workspace deletion removes linked beta application and feedback records");
  });

  it("names every infrastructure processor and separates model routing destinations", async () => {
    const providers = await source("app/legal/subprocessors/page.tsx");
    for (const name of ["Vercel", "Supabase", "Upstash", "Resend", "Sentry"]) {
      expect(providers).toContain(`\"${name}\"`);
    }
    expect(providers).toContain("User-selected routing destinations");
    for (const name of ["OpenAI", "Anthropic", "Groq", "Mistral", "Together", "DeepSeek"]) {
      expect(providers).toContain(name);
    }
  });

  it("pins the storage disclosures and absence of advertising analytics", async () => {
    const cookies = await source("app/legal/cookies/page.tsx");
    expect(cookies).toContain("pc-password-recovery");
    expect(cookies).toContain("passcontrol.dashboard.time-zone");
    expect(cookies).toContain("no advertising, cross-site tracking or behavioural-analytics cookie");
  });

  it("places the terms acknowledgement on account creation", async () => {
    const [signup, shell] = await Promise.all([
      source("app/signup/page.tsx"),
      source("components/auth/AuthShell.tsx"),
    ]);
    expect(signup).toContain("showAccountTerms");
    expect(shell).toContain("By creating an account");
    expect(shell).toContain('/legal/acceptable-use');
    expect(shell).toContain('/legal/privacy');
  });

  it("links the public homepage to the legal hub", async () => {
    const home = await source("app/page.tsx");
    expect(home).toContain('href="/legal/privacy"');
    expect(home).toContain('href="/legal/terms"');
  });
});
