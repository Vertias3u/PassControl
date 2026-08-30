// Operator handles — the string a stranger types as /@handle.
//
// The shape is declared in two places and they must agree: here, and the
// `users_username_shape` CHECK in 0033. Postgres owns the last word (a handle
// that reaches the write is refused by the constraint), but a constraint
// violation surfaces as an unmapped 23514 and reads as "something went wrong",
// so the useful check is this one. tests/profile-handle.test.ts extracts the
// constraint out of the migration and asserts the two patterns are identical
// character for character, because a plan file drifted from the migration once
// already.
//
// Deliberately NOT here: any lookup against public.retired_usernames. 0033's
// header argues that a retired handle and a taken handle must be
// indistinguishable to the caller — the trigger raises `unique_violation` for
// exactly that reason, so there is no oracle for which handles were once used.
// A pre-check here that reported "that one was retired" would hand back the
// oracle the migration was written to remove. setHandle() catches 23505 and
// says "taken" for both causes.

/**
 * 3–30 characters, lowercase, starting and ending alphanumeric, underscores in
 * between. Mirrors 0033:89 exactly.
 *
 * No hyphen: it is reserved as a future namespace separator, and it is visually
 * confusable with an underscore in several of the faces this renders in — which
 * on an identity product is an impersonation aid.
 *
 * Uppercase is unstorable rather than folded, which is what makes the plain
 * unique index in 0033 behave as case-insensitive uniqueness with no citext
 * extension.
 */
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_]{1,28}[a-z0-9]$/;

export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 30;

/**
 * Handles nobody may claim. There is NO database constraint behind this list —
 * it is enforced only in TypeScript, which is why the check lives inside
 * setHandle() in manage.ts rather than only in the server action, on the same
 * reasoning that puts the limiter inside lookupPublicPassport().
 *
 * Two groups:
 *
 *   Routes. /@handle is rewritten to /u/<handle> in middleware, so a handle
 *   that collides with a real top-level route is a page one keystroke away
 *   from a page it is not. The test sweeps app/ and fails when a new route
 *   directory is not reserved here.
 *
 *   Product and authority words. `passcontrol`, `security`, `support` and
 *   friends read as coming from us. The whole point of the page is that a
 *   stranger believes what it says about who someone is.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  // Top-level routes, present and reasonably foreseeable.
  "actions",
  "api",
  "auth",
  "avatar",
  "avatars",
  "beta",
  "dashboard",
  "legal",
  "learn",
  "notices",
  "login",
  "logout",
  "signin",
  "signout",
  "signup",
  "updates",
  "settings",
  "account",
  "billing",
  "verify",
  "receipt",
  "receipts",
  "user",
  "users",
  "static",
  "assets",
  "public",
  "well_known",
  "robots",
  "sitemap",
  "favicon",
  // The product, the company, and the words that borrow their authority.
  "passcontrol",
  "passport",
  "passports",
  "vertias",
  "admin",
  "administrator",
  "root",
  "system",
  "official",
  "staff",
  "team",
  "support",
  "security",
  "abuse",
  "help",
  "status",
  "info",
  "contact",
  "mail",
  "postmaster",
  "webmaster",
  "www",
  "docs",
  "blog",
  "about",
  "pricing",
  "terms",
  "privacy",
  "null",
  "undefined",
  // High-risk external identities. These are exact reservations, not a claim
  // that PassControl owns the names: an official account may be assigned one
  // manually through 0040's server-only registry. The default is simply that a
  // stranger cannot take a household or AI-provider identity first.
  "anthropic",
  "claude",
  "openai",
  "chatgpt",
  "google",
  "gemini",
  "microsoft",
  "copilot",
  "github",
  "gitlab",
  "apple",
  "meta",
  "facebook",
  "instagram",
  "whatsapp",
  "twitter",
  "xai",
  "grok",
  "amazon",
  "aws",
  "azure",
  "nvidia",
  "huggingface",
  "perplexity",
  "mistral",
  "deepseek",
  "groq",
  "together",
  "walmart",
  "tesla",
  "spacex",
  "paypal",
  "stripe",
  "visa",
  "mastercard",
  "coinbase",
  "binance",
  "revolut",
  "government",
  "police",
  "interpol",
  "verified",
  "moderator",
  "moderation",
]);

export type HandleRejection = "invalid_handle" | "reserved_handle";

export type HandleResult =
  | { ok: true; handle: string }
  | { ok: false; reason: HandleRejection };

/**
 * Trim, drop one leading `@`, lowercase. Exactly one `@` is stripped on
 * purpose: `@@admin` must stay invalid rather than normalise its way into the
 * reserved word `admin`.
 *
 * Returns "" for anything that is not a string, so callers never have to
 * type-check before validating.
 */
export function normalizeHandle(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return withoutAt.trim().toLowerCase();
}

/** Normalise, then check shape and the reserved list. Shape first: a reserved
 *  word is a narrower complaint and only makes sense about a well-formed handle. */
export function validateHandle(value: unknown): HandleResult {
  const handle = normalizeHandle(value);
  if (!HANDLE_PATTERN.test(handle)) return { ok: false, reason: "invalid_handle" };
  if (RESERVED_HANDLES.has(handle)) return { ok: false, reason: "reserved_handle" };
  return { ok: true, handle };
}
