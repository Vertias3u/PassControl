import type { SupabaseClient, User } from "@supabase/supabase-js";
import { mfaAuthorizedUser } from "@/lib/mfa";
import { userClient } from "@/lib/supabase/server";

/**
 * Why System Health was refused. These are deliberately finer-grained than the
 * gate needs to fail closed, because a refusal nobody can act on is how a
 * correctly-sealed surface reads as a broken link:
 *
 *   step_up_required    — has TOTP, session is aal1. /login/verify fixes it.
 *   enrollment_required — has NO verified TOTP. /login/verify would bounce this
 *                         account straight back to /dashboard (it calls
 *                         needsMfaStepUp, which is false when nothing is
 *                         enrolled), so sending them there was a two-hop dead
 *                         end. They need to enrol, not to step up.
 *   not_configured      — the instance names no operators, so it authorizes
 *                         nobody, including whoever is reading this.
 *   misconfigured       — the allowlist IS set but does not parse, which fails
 *                         closed silently and is otherwise undiagnosable.
 *   forbidden           — the instance names operators; this account isn't one.
 *
 * The split is presentation only. Every one of them is still a refusal, and the
 * order below means only an authenticated operator who has cleared TOTP ever
 * learns anything about how this deployment is configured.
 */
export type SystemOperatorReason =
  | "unauthenticated"
  | "step_up_required"
  | "enrollment_required"
  | "not_configured"
  | "misconfigured"
  | "forbidden";
export type SystemOperatorGate =
  | { ok: true; user: User }
  | { ok: false; reason: SystemOperatorReason; user?: User };

export type SystemOperatorAllowlistState = "unset" | "malformed" | "configured";

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const normalizeEmail = (value: string) => value.trim().toLowerCase();

/**
 * Exact, normalized values only; a missing or malformed allowlist authorizes
 * nobody. `state` distinguishes the two, which `emails` alone cannot: both come
 * back as an empty set, but "you never set this" and "you set this and it was
 * thrown away" call for opposite fixes.
 */
export function systemOperatorAllowlist(): { state: SystemOperatorAllowlistState; emails: Set<string> } {
  const raw = process.env.PASSCONTROL_SYSTEM_OPERATOR_EMAILS;
  if (!raw || !raw.trim()) return { state: "unset", emails: new Set() };
  const emails = raw.split(",").map(normalizeEmail);
  // One bad entry rejects the whole list rather than applying it in part: a
  // partly-applied allowlist is an authorization decision made by a typo.
  if (emails.some((email) => !emailPattern.test(email))) return { state: "malformed", emails: new Set() };
  return { state: "configured", emails: new Set(emails) };
}

export function systemOperatorEmails(): Set<string> {
  return systemOperatorAllowlist().emails;
}

function verifiedTotp(user: User): boolean {
  return (user.factors ?? []).some((factor) => factor.factor_type === "totp" && factor.status === "verified");
}

/** The allowlist decision, split so the caller can say which half failed. */
function authorize(user: User): { ok: true } | { ok: false; reason: SystemOperatorReason } {
  const allowlist = systemOperatorAllowlist();
  if (allowlist.state === "unset") return { ok: false, reason: "not_configured" };
  if (allowlist.state === "malformed") return { ok: false, reason: "misconfigured" };
  const email = typeof user.email === "string" ? normalizeEmail(user.email) : "";
  return email && allowlist.emails.has(email) ? { ok: true } : { ok: false, reason: "forbidden" };
}

/** Browser/session gate. It is intentionally separate from the API-key route. */
export async function systemOperatorGate(): Promise<SystemOperatorGate> {
  const db = await userClient();
  const mfa = await mfaAuthorizedUser(db);
  if (!mfa.ok) return { ok: false, reason: mfa.reason === "unauthenticated" ? "unauthenticated" : "step_up_required" };
  if (!verifiedTotp(mfa.user)) return { ok: false, reason: "enrollment_required", user: mfa.user };
  const allowed = authorize(mfa.user);
  // The user rides along on a refusal so the page can explain itself inside the
  // dashboard shell without a second round trip to Auth.
  return allowed.ok ? { ok: true, user: mfa.user } : { ok: false, reason: allowed.reason, user: mfa.user };
}

/** Headless control-key gate: Auth-admin is authoritative for the key owner. */
export async function systemOperatorForControl(db: SupabaseClient, userId: string): Promise<SystemOperatorGate> {
  try {
    const { data, error } = await db.auth.admin.getUserById(userId);
    const user = data?.user;
    if (error || !user || user.id !== userId) return { ok: false, reason: "forbidden" };
    if (!verifiedTotp(user)) return { ok: false, reason: "enrollment_required" };
    const allowed = authorize(user);
    return allowed.ok ? { ok: true, user } : { ok: false, reason: allowed.reason };
  } catch {
    return { ok: false, reason: "forbidden" };
  }
}
