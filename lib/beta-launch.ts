import { createHash, createHmac, randomBytes } from "node:crypto";

export const BETA_INTEGRATIONS = [
  "hermes",
  "openhands",
  "open-webui",
  "sdk",
  "other",
] as const;

export const BETA_PROVIDERS = [
  "openai",
  "anthropic",
  "groq",
  "mistral",
  "together",
  "deepseek",
  "undecided",
] as const;

export const BETA_MONTHLY_CALL_BUCKETS = [
  "under-1000",
  "1000-5000",
  "5000-10000",
  "over-10000",
  "unknown",
] as const;

export type BetaIntegration = (typeof BETA_INTEGRATIONS)[number];
export type BetaProvider = (typeof BETA_PROVIDERS)[number];
export type BetaMonthlyCallBucket = (typeof BETA_MONTHLY_CALL_BUCKETS)[number];
export type BetaInviteSource = "shared" | "database";

type HeaderReader = Pick<Headers, "get">;
interface BetaProxyEnvironment {
  PASSCONTROL_TRUST_CF_CONNECTING_IP?: string;
  VERCEL?: string;
}

export interface BetaApplicationInput {
  email: string;
  integration: BetaIntegration;
  provider: BetaProvider;
  monthlyCallBucket: BetaMonthlyCallBucket;
  useCase: string;
  contactConsent: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function oneOf<T extends readonly string[]>(value: string, choices: T): value is T[number] {
  return choices.includes(value as T[number]);
}

export function betaInviteSource(raw = process.env.PASSCONTROL_INVITE_SOURCE): BetaInviteSource {
  return raw?.trim().toLowerCase() === "database" ? "database" : "shared";
}

export function normalizeBetaEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function betaApplicationIp(
  incoming: HeaderReader,
  environment: BetaProxyEnvironment = {
    PASSCONTROL_TRUST_CF_CONNECTING_IP: process.env.PASSCONTROL_TRUST_CF_CONNECTING_IP,
    VERCEL: process.env.VERCEL,
  }
): string {
  const cloudflareIp = environment.PASSCONTROL_TRUST_CF_CONNECTING_IP === "true"
    ? incoming.get("cf-connecting-ip")?.trim()
    : undefined;
  const vercelIp = environment.VERCEL === "1"
    ? incoming.get("x-vercel-forwarded-for")?.split(",")[0]?.trim()
    : undefined;
  return (
    cloudflareIp ||
    vercelIp ||
    incoming.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    incoming.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

export function parseBetaApplication(formData: FormData):
  | { ok: true; value: BetaApplicationInput }
  | { ok: false; error: string } {
  const email = normalizeBetaEmail(formData.get("email"));
  const integration = String(formData.get("integration") ?? "");
  const provider = String(formData.get("provider") ?? "");
  const monthlyCallBucket = String(formData.get("monthly_call_bucket") ?? "");
  const useCase = String(formData.get("use_case") ?? "").trim();
  const contactConsent = formData.get("contact_consent") === "on";

  if (email.length > 320 || !EMAIL_RE.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (!oneOf(integration, BETA_INTEGRATIONS)) {
    return { ok: false, error: "Choose the tool you plan to connect." };
  }
  if (!oneOf(provider, BETA_PROVIDERS)) {
    return { ok: false, error: "Choose the provider you plan to use." };
  }
  if (!oneOf(monthlyCallBucket, BETA_MONTHLY_CALL_BUCKETS)) {
    return { ok: false, error: "Choose an estimated monthly call range." };
  }
  if (useCase.length < 20 || useCase.length > 1_200) {
    return { ok: false, error: "Describe the use case in 20 to 1,200 characters." };
  }
  if (!contactConsent) {
    return { ok: false, error: "Consent is required so Vertias can respond to this application." };
  }
  return {
    ok: true,
    value: { email, integration, provider, monthlyCallBucket, useCase, contactConsent },
  };
}

export function issueBetaInviteToken(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashBetaInviteToken(raw) };
}

export function hashBetaInviteToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function betaRateLimitSubject(kind: "ip" | "email", value: string): string {
  const secret = process.env.VISA_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error("beta_rate_limit_secret_unavailable");
  return createHmac("sha256", secret)
    .update(`passcontrol:beta-application:${kind}\0${value}`, "utf8")
    .digest("hex");
}

export function betaOperatorEmails(raw = process.env.PASSCONTROL_BETA_OPERATOR_EMAILS): Set<string> {
  return new Set(
    String(raw ?? "")
      .split(",")
      .map((value) => normalizeBetaEmail(value))
      .filter(Boolean)
  );
}

export function betaInviteUrl(rawToken: string): string {
  const issuer = process.env.PASSCONTROL_ISSUER?.trim().replace(/\/+$/u, "");
  if (!issuer || !/^https:\/\//u.test(issuer)) throw new Error("beta_invite_issuer_unavailable");
  return `${issuer}/signup#invite=${encodeURIComponent(rawToken)}`;
}
