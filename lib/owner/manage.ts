// Owner-binding mutations. Server-side only, service_role, tenant-scoped.
//
// Migration 0017 grants the client SELECT and nothing else: every write runs
// through here so the verification ladder cannot be skipped. The rule that
// makes the tier worth anything is enforced in one place —
//
//   A CALLER MAY NEVER SET `tier` OR `verified_at`.
//
// They say what they claim (`kind`, `subject`) and whether to publish it. What
// was actually PROVEN is decided by this module, from evidence it gathered
// itself. tests/owner-manage.test.ts pins that.
import type { SupabaseClient } from "@supabase/supabase-js";

import { purgeOwnerCache } from "../state/redis";
import { classifyCompanyId, lookupCompany } from "./company";
import { isVerifiableDomain, newVerificationToken, verifyDomainControl } from "./domain";
import type { DomainFailure } from "./domain";
import { isVerifiableGithubLogin, looksLikeDomainNotLogin, verifyGithubControl } from "./github";
import type { GithubFailure } from "./github";

type OwnerDatabase = Pick<SupabaseClient, "from">;

export type OwnerKind = "self_attested" | "domain" | "github";

/**
 * The kinds that have something to check. `self_attested` is a name somebody
 * typed and `idv` is reserved for a paid adapter that does not exist, so both
 * are outside the ladder this module runs.
 */
export const VERIFIABLE_KINDS = ["domain", "github"] as const;

/** What a control check can report, whichever identifier it was about. */
export type ControlFailure = DomainFailure | GithubFailure;

export interface OwnerRecord {
  kind: string;
  subject: string;
  tier: string;
  published: boolean;
  verification_token: string | null;
  verified_at: string | null;
  last_checked_at: string | null;
  failure_count: number;
  // Asserted, never proven, and never allowed to influence `tier`. See
  // db/migrations/0048 and lib/owner/company.ts for why this is columns on the
  // proof row rather than a kind of its own.
  company_id: string | null;
  company_source: string | null;
  company_name: string | null;
  company_jurisdiction: string | null;
  company_active: boolean | null;
  company_checked_at: string | null;
}

export type OwnerResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string };

/** How many consecutive re-check failures demote a verified tier. */
export const OWNER_FAILURE_LIMIT = 3;

const MAX_SUBJECT_LENGTH = 200;

// One string literal, deliberately, however long it gets: supabase-js reads this
// at the TYPE level to shape the row it returns, and a `+` concatenation makes it
// an opaque string — every caller then falls back to a generic error type and the
// casts below stop being checked at all.
const PUBLIC_COLS =
  "kind, subject, tier, published, verification_token, verified_at, last_checked_at, failure_count, company_id, company_source, company_name, company_jurisdiction, company_active, company_checked_at";

/**
 * Every company column, written and cleared as one unit.
 *
 * Listed once so a partial clear is not expressible: a row left holding a stale
 * `company_name` beside a cleared `company_id` would publish a legal name that
 * nothing in the record can be checked against.
 */
const COMPANY_COLS = [
  "company_id",
  "company_source",
  "company_name",
  "company_jurisdiction",
  "company_active",
  "company_checked_at",
] as const;

/**
 * Drop the cached owner after a write. Best-effort, exactly like the read side.
 *
 * The database write is the durable thing; the cache purge is not. Letting a
 * Redis blip throw here would return 500 for a mutation that actually SUCCEEDED
 * — the caller would retry a change already applied, and the only real
 * consequence of the miss is a stale owner claim on receipts for up to the 300s
 * TTL. Report success for the thing that succeeded.
 */
async function dropOwnerCache(userId: string): Promise<void> {
  try {
    await purgeOwnerCache(userId);
  } catch {
    // Falls back to the TTL.
  }
}

export async function readOwner(
  db: OwnerDatabase,
  userId: string
): Promise<OwnerResult<OwnerRecord | null>> {
  const { data, error } = await db
    .from("agent_owners")
    .select(PUBLIC_COLS)
    .eq("user_id", userId) // tenant boundary — service_role bypasses RLS
    .maybeSingle();

  if (error) return { ok: false, status: 500, code: "query_failed" };
  return { ok: true, data: (data as OwnerRecord) ?? null };
}

/**
 * Declare an owner. Always lands at tier `unverified`.
 *
 * Even for `kind: "domain"` — claiming a domain and proving control of it are
 * two different acts, and only the second one moves the tier. This function
 * hands back a token to publish; verifyOwnerControl is what checks it.
 */
export async function setOwner(
  db: OwnerDatabase,
  userId: string,
  input: Record<string, unknown>
): Promise<OwnerResult<OwnerRecord>> {
  const kind: OwnerKind | null =
    input.kind === "domain" || input.kind === "github" || input.kind === "self_attested"
      ? input.kind
      : null;
  if (!kind) return { ok: false, status: 400, code: "invalid_kind" };

  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (!subject || subject.length > MAX_SUBJECT_LENGTH) {
    return { ok: false, status: 400, code: "invalid_subject" };
  }
  // Refuse an identifier we would never be able to verify, at declaration time
  // rather than leaving the owner to discover it at verification time.
  if (kind === "domain" && !isVerifiableDomain(subject)) {
    return { ok: false, status: 400, code: "invalid_domain" };
  }
  if (kind === "github" && !isVerifiableGithubLogin(subject)) {
    // A domain typed into the GitHub field fails the login rules on its dots.
    // Reporting that as a malformed login sends the owner hunting for a typo in
    // a string that is perfectly valid — just of the other kind.
    const code = looksLikeDomainNotLogin(subject) ? "looks_like_domain" : "invalid_login";
    return { ok: false, status: 400, code };
  }

  const row = {
    user_id: userId,
    kind,
    // Both provable identifiers are case-insensitive at their source — a
    // hostname by DNS, a GitHub login by GitHub — so the casing somebody typed
    // must not become part of the stored claim, or the subject and the path we
    // verified would disagree on sight.
    subject: kind === "self_attested" ? subject : subject.toLowerCase(),
    // Never taken from the caller. Changing the claim always resets the proof:
    // an owner who re-points a binding at a new domain must prove that one too.
    tier: "unverified",
    verified_at: null,
    failure_count: 0,
    verification_token: kind === "self_attested" ? null : newVerificationToken(),
    published: input.published === true,
  };

  const { data, error } = await db
    .from("agent_owners")
    .upsert(row, { onConflict: "user_id" })
    .select(PUBLIC_COLS)
    .maybeSingle();

  if (error || !data) return { ok: false, status: 500, code: "write_failed" };
  await dropOwnerCache(userId);
  return { ok: true, data: data as OwnerRecord };
}

/** Publish or unpublish an existing binding. The only field a caller may toggle freely. */
export async function setOwnerPublished(
  db: OwnerDatabase,
  userId: string,
  published: boolean
): Promise<OwnerResult<OwnerRecord>> {
  const { data, error } = await db
    .from("agent_owners")
    .update({ published })
    .eq("user_id", userId)
    .select(PUBLIC_COLS)
    .maybeSingle();

  if (error) return { ok: false, status: 500, code: "write_failed" };
  if (!data) return { ok: false, status: 404, code: "no_owner" };
  await dropOwnerCache(userId);
  return { ok: true, data: data as OwnerRecord };
}

/**
 * Run the control check for whichever identifier this owner declared, and
 * record the outcome.
 *
 * On success the tier becomes the kind that was proven — `domain` or `github`,
 * which are peers rather than a ladder: both prove control of a public
 * identifier, and neither proves who the human behind it is. On failure the
 * tier is only demoted after OWNER_FAILURE_LIMIT consecutive failures, and even
 * then the SUBJECT and the original verified_at are kept — degrade the label,
 * never silently delete someone's binding because their web server had a bad day.
 *
 * Returns 409 `owner_changed` if the binding was re-declared while the check was
 * in flight. Nothing is written in that case: the result belongs to a claim that
 * no longer exists, and applying it to its replacement is how an unproven domain
 * gets a proven label. See the note at the update below.
 */
export async function verifyOwnerControl(
  db: OwnerDatabase,
  userId: string,
  options: { fetch?: typeof fetch; now?: () => Date } = {}
): Promise<OwnerResult<{ owner: OwnerRecord; verified: boolean; reason?: ControlFailure }>> {
  const current = await readOwner(db, userId);
  if (!current.ok) return current;
  const owner = current.data;
  if (!owner) return { ok: false, status: 404, code: "no_owner" };
  const kind = VERIFIABLE_KINDS.find((candidate) => candidate === owner.kind);
  if (!kind) return { ok: false, status: 400, code: "not_verifiable_kind" };
  if (!owner.verification_token) return { ok: false, status: 409, code: "no_verification_token" };

  const now = (options.now ?? (() => new Date()))().toISOString();
  const overrides = options.fetch ? { fetch: options.fetch } : {};
  const result =
    kind === "github"
      ? await verifyGithubControl(owner.subject, owner.verification_token, overrides)
      : await verifyDomainControl(owner.subject, owner.verification_token, overrides);

  const patch = result.ok
    ? { tier: kind, verified_at: now, last_checked_at: now, failure_count: 0 }
    : nextFailureState(owner, now, result.reason);

  // Compare-and-set on the claim that was actually checked.
  //
  // Everything above this line happened BEFORE an HTTPS fetch of a host the
  // owner named — and the owner of that host decides how long it takes. Hold
  // the response open and the tenant has an arbitrarily long window in which to
  // re-declare, which resets the tier and issues a new token. `user_id` alone
  // then lands this patch on whatever row is there now: a valid proof for
  // acme.com promoting a brand-new claim on some other domain to `tier:
  // "domain"`, which /verify and every signed receipt then assert to strangers.
  // The UI's pending state is not the control — a Server Action is addressable
  // over HTTP by its id, extractable from the built client chunks.
  //
  // So the write states the row it believes it is patching. `subject` and
  // `verification_token` are both required: re-declaring the SAME domain keeps
  // the subject and rotates only the token (setOwner above), and that re-declare
  // is precisely the reset a stale success would undo. No new column, no
  // migration — the token already IS a per-declaration nonce.
  //
  // Both branches are conditioned. A stale FAILURE is the same defect wearing
  // the other face: it would spend one of three strikes against a binding
  // nothing has checked yet, and three of them demote it.
  const { data, error } = await db
    .from("agent_owners")
    .update(patch)
    .eq("user_id", userId) // tenant boundary — service_role bypasses RLS
    .eq("kind", owner.kind)
    .eq("subject", owner.subject)
    .eq("verification_token", owner.verification_token)
    .select(PUBLIC_COLS)
    .maybeSingle();

  // Order matters: a database that is down is not a row that moved. Reporting
  // one as the other would tell an operator their binding changed when it did
  // not, and would bury a real outage under a reassuring message.
  if (error) return { ok: false, status: 500, code: "write_failed" };
  // No match, no error: the row is no longer the row that was proven. Say so
  // and change nothing. The evidence gathered was real — it was just about a
  // claim this tenant has since withdrawn, and re-checking is one click.
  if (!data) return { ok: false, status: 409, code: "owner_changed" };
  await dropOwnerCache(userId);

  return {
    ok: true,
    data: {
      owner: data as OwnerRecord,
      verified: result.ok,
      ...(result.ok ? {} : { reason: result.reason }),
    },
  };
}

/**
 * What a failed check costs the binding.
 *
 * The asymmetry here is deliberate and must not be homogenised. For a DOMAIN,
 * `unreachable` means the owner's own web server did not answer, and 0017's
 * design is right that three of those in a row is a claim that no longer holds.
 * For GITHUB it means raw.githubusercontent.com did not answer — a CDN that
 * neither we nor the owner operates. Spending strikes on somebody else's outage
 * would demote a binding that is still perfectly valid, and the owner could do
 * nothing about it but wait and re-verify.
 *
 * So a GitHub `unreachable` records only that we looked. Every other failure,
 * on either kind, is evidence about the claim itself and is counted.
 */
function nextFailureState(owner: OwnerRecord, now: string, reason: ControlFailure) {
  if (owner.kind === "github" && reason === "unreachable") {
    return { last_checked_at: now };
  }

  const failures = owner.failure_count + 1;
  return {
    failure_count: failures,
    last_checked_at: now,
    // One bad check is a blip; three in a row is a claim that no longer holds.
    // verified_at is deliberately NOT cleared — the page can then say when the
    // binding was last genuinely confirmed, which is more useful than silence.
    ...(failures >= OWNER_FAILURE_LIMIT ? { tier: "unverified" } : {}),
  };
}

/**
 * Record a company register line against an existing binding.
 *
 * THE INVARIANT, and the reason this is a separate function rather than a field
 * on setOwner: **nothing here may write `tier`, `verified_at`, `kind`,
 * `subject`, `published` or `verification_token`.** A register lookup confirms
 * that an entry exists, is active and resolves to a legal name. It does not and
 * cannot show that this tenant is that company — a register is a public record
 * anyone can quote, with nowhere to publish a token. See db/migrations/0048.
 *
 * The patch below therefore contains exactly the company columns and nothing
 * else, which is a property tests/owner-manage-evidence.test.ts asserts by
 * enumerating the forbidden keys rather than by reading this comment.
 *
 * It also requires an owner row to already exist. A company line rides on a
 * binding; it is not a binding of its own, and writing one for a tenant who has
 * declared nothing would produce an owner whose kind and subject were never
 * stated by anybody.
 */
export async function setOwnerCompany(
  db: OwnerDatabase,
  userId: string,
  rawId: unknown,
  options: { fetch?: typeof fetch; now?: () => Date } = {}
): Promise<OwnerResult<OwnerRecord>> {
  const current = await readOwner(db, userId);
  if (!current.ok) return current;
  if (!current.data) return { ok: false, status: 404, code: "no_owner" };

  const classified = classifyCompanyId(rawId);
  if (!classified) return { ok: false, status: 400, code: "invalid_company_id" };

  const found = await lookupCompany(classified.id, classified.source, {
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  if (!found.ok) {
    // A register that would not answer is not a company that is not in it.
    // Collapsing the two would tell an owner their real company does not exist
    // because a public service was down.
    return found.reason === "unreachable"
      ? { ok: false, status: 502, code: "register_unreachable" }
      : { ok: false, status: 400, code: "company_not_found" };
  }

  const now = (options.now ?? (() => new Date()))().toISOString();
  const { data, error } = await db
    .from("agent_owners")
    .update({
      company_id: classified.id,
      company_source: classified.source,
      company_name: found.name,
      company_jurisdiction: found.jurisdiction,
      // Found but lapsed is a fact a reader of /verify wants, not an error.
      company_active: found.active,
      company_checked_at: now,
    })
    .eq("user_id", userId) // tenant boundary — service_role bypasses RLS
    .select(PUBLIC_COLS)
    .maybeSingle();

  if (error) return { ok: false, status: 500, code: "write_failed" };
  if (!data) return { ok: false, status: 404, code: "no_owner" };
  await dropOwnerCache(userId);
  return { ok: true, data: data as OwnerRecord };
}

/**
 * Withdraw the company claim. Every column together, never a subset — a row
 * holding a stale `company_name` beside a cleared `company_id` would publish a
 * legal name with nothing in the record to check it against.
 */
export async function clearOwnerCompany(
  db: OwnerDatabase,
  userId: string
): Promise<OwnerResult<OwnerRecord>> {
  const patch = Object.fromEntries(COMPANY_COLS.map((column) => [column, null]));

  const { data, error } = await db
    .from("agent_owners")
    .update(patch)
    .eq("user_id", userId) // tenant boundary — service_role bypasses RLS
    .select(PUBLIC_COLS)
    .maybeSingle();

  if (error) return { ok: false, status: 500, code: "write_failed" };
  if (!data) return { ok: false, status: 404, code: "no_owner" };
  await dropOwnerCache(userId);
  return { ok: true, data: data as OwnerRecord };
}
