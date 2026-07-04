// Log-based security alerting. The durable record is the structured line emitted
// by logSecurityEvent (captured by Vercel logs). This layer turns the *high-signal*
// subset of those events into a real-time push notification.
//
// $0 design note: Vercel Log Drains (the "proper" log→alert pipe) require a paid
// plan, so we don't depend on them. Instead we POST a one-line message to a single
// incoming-webhook URL (SECURITY_ALERT_WEBHOOK) — Slack and Discord both accept
// this for free. The payload carries both `text` (Slack) and `content` (Discord)
// so one env var works for either; the other service ignores the extra field.
//
// Alerting is best-effort and MUST NEVER break the request path: a failed/slow
// webhook is swallowed, and only severe events ever touch the network.
import { sanitizeValue } from "./seclog";

export type Severity = "info" | "warning" | "critical";

// Only events that a human should actually look at. Everything else (login
// success/failure, signup, logout, un-suspend, disarming the kill switch) stays
// a log line and never pages anyone. Keyed by the event name passed to
// logSecurityEvent — keep the two in sync.
const SEVERITY: Record<string, Severity> = {
  "auth.login.locked": "critical", // an account hit the lockout threshold — active guessing
  "auth.login.ratelimited": "warning", // throttle tripped — burst of attempts
  "auth.mfa.failed": "warning", // a wrong TOTP / recovery code at login step-up
  "killswitch.master": "critical", // platform-wide kill toggled (see fields.on)
  "agent.suspend": "warning", // an agent was suspended
};

export function alertSeverity(event: string): Severity {
  return SEVERITY[event] ?? "info";
}

/** True if this event warrants a pushed alert (severity above info). */
export function shouldAlert(event: string): boolean {
  return alertSeverity(event) !== "info";
}

/** Build a single sanitized alert line. Fields are sanitized (the same CR/LF +
 *  control-char stripping logSecurityEvent uses) so nothing can forge or split
 *  the message in the destination channel. */
export function formatAlertMessage(event: string, fields: Record<string, unknown>): string {
  const sev = alertSeverity(event).toUpperCase();
  const parts = Object.entries(fields).map(([k, v]) => `${k}=${String(sanitizeValue(v))}`);
  const body = parts.length ? ` — ${parts.join(" ")}` : "";
  return `[PassControl ${sev}] ${event}${body}`.slice(0, 1500);
}

/** Dispatch a security alert if the event is severe and a webhook is configured.
 *  No-op (and no network call) otherwise. Never throws. */
export async function dispatchSecurityAlert(
  event: string,
  fields: Record<string, unknown> = {}
): Promise<void> {
  const url = process.env.SECURITY_ALERT_WEBHOOK;
  if (!url || !shouldAlert(event)) return;
  const message = formatAlertMessage(event, fields);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // text → Slack, content → Discord; each ignores the other's field.
      body: JSON.stringify({ text: message, content: message }),
      // Bound the wait so a slow webhook can't drag out the request path.
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Best-effort: the durable record is already in the logs. Swallow.
  }
}
