// Company-register lookup — a checkable claim, deliberately NOT a proof.
//
// ── Read this before wiring it to a tier ────────────────────────────────────
//
// This module does NOT prove that a tenant is the company they name. Nothing
// free can. A domain or a GitHub account can be proven because the owner
// publishes a token somewhere only they control; a company register has no such
// place — the register is a public record anyone can read and anyone can quote.
// Paid identity/business verification exists precisely because of this gap.
//
// So the company line never touches `tier`, and lib/owner/manage.ts must keep it
// that way. `kind`/`tier` mean "what control was proven". The company columns
// mean something narrower and separately useful: THIS REGISTER ENTRY EXISTS, is
// active, and resolves to THIS legal name. Every surface that renders it has to
// say that it is asserted rather than proven.
//
// Which is still worth having, because it composes. "Agents belonging to the
// proven controller of acme.com, who states they are ACME LTD (IE6388047V,
// active)" is a claim a stranger can go and falsify — the domain half is proven
// by us, and the company half is checkable by them against the same register we
// used. That is the accountability the binding exists for, and it is a strictly
// stronger statement than either half alone.
//
// ── Why the identifier is one field ─────────────────────────────────────────
//
// An LEI and an EU VAT number have unambiguous, non-overlapping shapes, so the
// string says which register to ask. A "which register?" dropdown would be a
// question the input already answers, and a wrong answer to it would send a
// lookup to a register that cannot possibly hold the number.
//
// ── The third-party question, answered honestly ─────────────────────────────
//
// lib/owner/domain.ts refuses DNS-over-HTTPS partly because it would route every
// self-hosted verification through Google or Cloudflare. The same objection
// applies here and has a different answer: for a company register there IS no
// local alternative — the register is the register. What keeps it acceptable is
// that this runs once, on an explicit action by the owner, never on the request
// path, and never for a tenant who has not asked for it.

/** Bounded so a register that starts serving HTML cannot make us buffer it. */
const MAX_RESPONSE_BYTES = 32 * 1024;
const FETCH_TIMEOUT_MS = 8_000;

// VIES member-state codes. Note EL for Greece rather than the ISO GR, and XI
// for Northern Ireland — VIES uses its own list and a plain ISO-3166 check
// would reject two real codes and accept one that is not in it.
const VIES_STATES = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR",
  "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO",
  "SE", "SI", "SK", "XI",
]);

const VAT_BODY_RE = /^[A-Z\d+*.]{2,12}$/;
const LEI_RE = /^[A-Z\d]{18}\d{2}$/;

export type CompanySource = "vat" | "lei";

export interface CompanyId {
  source: CompanySource;
  /** Normalised: upper case, no separators. What gets stored and looked up. */
  id: string;
}

export type CompanyFailure = "invalid_id" | "unreachable" | "not_found";

export type CompanyLookup =
  | { ok: true; name: string | null; jurisdiction: string | null; active: boolean }
  | { ok: false; reason: CompanyFailure };

export interface LookupCompanyOptions {
  fetch?: typeof fetch;
}

/**
 * ISO 7064 MOD 97-10 over the whole 20 characters, letters as A=10…Z=35.
 *
 * Checked locally because it is free and because the alternative is worse: an
 * LEI with a transposed character comes back from the register as "no such
 * entity", which reads to the owner as the register being wrong rather than
 * their typing.
 */
function leiChecksumHolds(candidate: string): boolean {
  let remainder = 0;
  for (const char of candidate) {
    const value = parseInt(char, 36);
    if (Number.isNaN(value)) return false;
    // Fold digit by digit so this never touches a number bigger than an int.
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97;
  }
  return remainder === 1;
}

/**
 * Which register does this identifier belong to, if any?
 *
 * Returns null for anything unrecognised — including a well-formed identifier
 * from a register we cannot query for free. Guessing would produce a lookup URL
 * built from a string whose shape we never validated.
 */
export function classifyCompanyId(value: unknown): CompanyId | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\s.\-/]/gu, "").toUpperCase();
  if (!cleaned || cleaned.length > 32) return null;

  if (LEI_RE.test(cleaned) && leiChecksumHolds(cleaned)) {
    return { source: "lei", id: cleaned };
  }

  const country = cleaned.slice(0, 2);
  const body = cleaned.slice(2);
  if (VIES_STATES.has(country) && VAT_BODY_RE.test(body)) {
    return { source: "vat", id: `${country}${body}` };
  }

  return null;
}

async function readJson(res: Response): Promise<unknown> {
  const body = (await res.text()).slice(0, MAX_RESPONSE_BYTES);
  return JSON.parse(body) as unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Several member states validate a number without disclosing a name and send
  // back a row of dashes. That is "valid, no name", not a name of "---".
  if (!trimmed || /^-+$/u.test(trimmed)) return null;
  return trimmed;
}

/**
 * Ask the register. Never called on the request path — this is an explicit
 * owner action, and it may take as long as the register takes.
 *
 * `source` is passed rather than re-derived so the caller states which register
 * it believes it is asking, and a mismatch with the identifier's actual shape is
 * refused instead of being silently corrected into a request.
 */
export async function lookupCompany(
  id: string,
  source: CompanySource,
  options: LookupCompanyOptions = {}
): Promise<CompanyLookup> {
  const classified = classifyCompanyId(id);
  if (!classified || classified.source !== source) return { ok: false, reason: "invalid_id" };

  const fetchImpl = options.fetch ?? fetch;
  const url =
    source === "lei"
      ? `https://api.gleif.org/api/v1/lei-records/${classified.id}`
      : `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${classified.id.slice(0, 2)}/vat/${classified.id.slice(2)}`;

  let payload: unknown;
  try {
    const res = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    // A 404 from either register is a verdict about the identifier. Anything
    // else that is not ok is the register having a bad day, and saying "this
    // company does not exist" because a service was down would put a false
    // negative in front of the owner.
    if (res.status === 404) return { ok: false, reason: "not_found" };
    if (!res.ok) return { ok: false, reason: "unreachable" };
    payload = await readJson(res);
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  const body = record(payload);
  if (!body) return { ok: false, reason: "unreachable" };

  if (source === "vat") {
    if (body.isValid !== true) return { ok: false, reason: "not_found" };
    // `address` is deliberately not read. It is a postal address of a real
    // place, this record can be published on /verify, and nothing downstream
    // needs it — so it does not enter the process at all.
    return {
      ok: true,
      name: text(body.name),
      jurisdiction: classified.id.slice(0, 2),
      active: true,
    };
  }

  const attributes = record(record(body.data)?.attributes);
  const entity = record(attributes?.entity);
  if (!entity) return { ok: false, reason: "not_found" };

  // Two independent statuses, and both have to hold. `entity.status` is whether
  // the company is going; `registration.status` is whether its LEI is current.
  // A lapsed LEI on a live company is exactly the sort of thing a reader should
  // see, so it comes back as found-but-not-active rather than as an error.
  const active =
    entity.status === "ACTIVE" && record(attributes?.registration)?.status === "ISSUED";

  return {
    ok: true,
    name: text(record(entity.legalName)?.name),
    jurisdiction: text(entity.jurisdiction),
    active,
  };
}
