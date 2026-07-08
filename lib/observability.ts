import { sanitizeValue } from "./seclog";

type SentryEvent = Record<string, unknown>;
type SentryModule = typeof import("@sentry/nextjs");
type SafeScalar = string | number | boolean;

export interface ObservabilityContext {
  route: string;
  method?: string;
  status?: number;
  provider?: string;
  agentId?: string;
  jti?: string;
  requestId?: string;
  controlScope?: string;
  code?: string;
  event?: string;
}

const SAFE_TAG_KEYS = new Set(["route", "method", "status", "provider", "code", "event", "controlScope"]);
const SAFE_CONTEXT_KEYS = new Set([
  "route",
  "method",
  "status",
  "provider",
  "agentId",
  "jti",
  "requestId",
  "controlScope",
  "code",
  "event",
]);

const SECRET_FIELD_RE =
  /(auth|authorization|cookie|token|secret|password|key|visa|passport|signature|payload|body|dsn|supabase|service|cache|plaintext)/i;

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9._-]{6,}\b/g,
  /\bpc_[A-Za-z0-9._-]{6,}\b/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];

let sentryPromise: Promise<SentryModule | null> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactString(value: string): string {
  let out = String(sanitizeValue(value));
  for (const pattern of SECRET_VALUE_PATTERNS) out = out.replace(pattern, "[redacted]");
  return out;
}

function scrubUnknown(value: unknown, key = ""): unknown {
  if (key && SECRET_FIELD_RE.test(key)) return "[redacted]";
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => scrubUnknown(entry));
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === "vars") continue;
    out[childKey] = scrubUnknown(childValue, childKey);
  }
  return out;
}

function toSafeScalar(value: unknown): SafeScalar | undefined {
  if (typeof value === "string") return redactString(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function safeFields(input: unknown, allowed: Set<string>): Record<string, SafeScalar> | undefined {
  if (!isRecord(input)) return undefined;
  const out: Record<string, SafeScalar> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) continue;
    const scalar = toSafeScalar(value);
    if (scalar !== undefined) out[key] = scalar;
  }
  return Object.keys(out).length ? out : undefined;
}

function captureShape(context: ObservabilityContext) {
  const safeContext = safeFields(context, SAFE_CONTEXT_KEYS) ?? {};
  const tags = safeFields(context, SAFE_TAG_KEYS) ?? {};
  return { tags, contexts: { passcontrol: safeContext } };
}

/** Final hard scrub before an event can leave the process. Request/response
 * bodies, headers, cookies, user objects, breadcrumbs, and arbitrary extras are
 * removed wholesale. Only allowlisted PassControl context survives. */
export function scrubSentryEvent(event: unknown): SentryEvent {
  const scrubbed = scrubUnknown(event);
  const out: SentryEvent = isRecord(scrubbed) ? { ...scrubbed } : {};
  delete out.request;
  delete out.user;
  delete out.extra;
  delete out.breadcrumbs;

  const tags = safeFields(out.tags, SAFE_TAG_KEYS);
  if (tags) out.tags = tags;
  else delete out.tags;

  const rawContexts = isRecord(out.contexts) ? out.contexts : undefined;
  const passcontrol = rawContexts ? safeFields(rawContexts.passcontrol, SAFE_CONTEXT_KEYS) : undefined;
  if (passcontrol) out.contexts = { passcontrol };
  else delete out.contexts;

  return out;
}

export function isSentryConfigured(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}

async function sentry(): Promise<SentryModule | null> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return null;
  if (!sentryPromise) {
    sentryPromise = import("@sentry/nextjs")
      .then((Sentry) => {
        Sentry.init({
          dsn,
          sendDefaultPii: false,
          tracesSampleRate: 0,
          beforeSend: (event) => scrubSentryEvent(event) as never,
          beforeSendTransaction: (event) => scrubSentryEvent(event) as never,
        });
        return Sentry;
      })
      .catch((error: unknown) => {
        // Best-effort observability must not break the credential path.
        // eslint-disable-next-line no-console
        console.error("[sentry:init]", error instanceof Error ? redactString(error.message) : "unknown");
        return null;
      });
  }
  return sentryPromise;
}

export async function captureError(error: unknown, context: ObservabilityContext): Promise<void> {
  const Sentry = await sentry();
  if (!Sentry) return;
  const shape = captureShape({ ...context, status: context.status ?? 500 });
  Sentry.captureException(error instanceof Error ? error : new Error(String(sanitizeValue(error))), {
    level: "error",
    ...shape,
  });
}

export async function captureSecurityEvent(event: string, context: ObservabilityContext): Promise<void> {
  const Sentry = await sentry();
  if (!Sentry) return;
  const safeEvent = redactString(event);
  const shape = captureShape({ ...context, event: safeEvent });
  Sentry.captureMessage(`security:${safeEvent}`, {
    level: "warning",
    ...shape,
  });
}
