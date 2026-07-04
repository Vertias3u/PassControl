// Structured security-event logging. Emits one JSON line per event to stdout
// (captured by Vercel logs, queryable). Deliberately excludes secrets and raw
// PII — emails are masked, passwords/tokens are never passed in.
//
// All string field values are sanitized (control chars stripped, bounded length)
// so attacker-controlled input can't forge log lines or split entries — see
// log-injection hardening (security #100).

export function sanitizeValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  // Strip CR/LF and other control chars; bound length.
  return v.replace(/[\r\n\t\x00-\x1f\x7f]/g, " ").slice(0, 256);
}

/** Mask an email for logs: keep enough to correlate, hide the local-part. */
export function maskEmail(email: string): string {
  const e = String(email);
  const at = e.indexOf("@");
  if (at < 1) return "***";
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const shown = local.slice(0, 2);
  return `${shown}${"*".repeat(Math.max(1, local.length - 2))}@${domain}`.slice(0, 128);
}

export function logSecurityEvent(event: string, fields: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) safe[k] = sanitizeValue(v);
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({ ts: new Date().toISOString(), kind: "security", evt: event, ...safe })
  );
}
