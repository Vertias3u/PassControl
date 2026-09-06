// GitHub account verification — the second free proof of control.
//
// The owner creates a PUBLIC repository named `passcontrol-owner` under their
// account, containing one file `owner.txt` with the token we issued, and we
// fetch it at
//   https://raw.githubusercontent.com/<login>/passcontrol-owner/HEAD/owner.txt
//
// ── Why this proves something ───────────────────────────────────────────────
//
// Only the account `<login>` can create a repository at `<login>/…`. So a
// document served from that path is a document that account put there, and
// raw.githubusercontent.com answers 404 for the same repository id under any
// other login. Confirmed against the live host rather than assumed: a correct
// login returns 200, a wrong one returns 404, and a login differing only in
// case returns 200 — which is right, because GitHub logins are unique
// case-insensitively, so a case variant is the same account and not a bypass.
//
// ── Why a repository and not a gist ─────────────────────────────────────────
//
// A gist works and its raw host binds the login the same way, but its URL needs
// the gist id — a second input the owner has to copy across, and a second
// caller-supplied string interpolated into a URL we fetch. A fixed repository
// name makes the URL derivable from the login ALONE, exactly as the domain
// module derives its well-known URL from the hostname alone. One input, one
// shape to validate, and re-verification needs nothing the owner has to keep.
//
// ── Why not the GitHub API ──────────────────────────────────────────────────
//
// `api.github.com/gists/<id>` would give an authoritative `owner.login`, but
// unauthenticated it allows 60 requests per hour PER IP — and this runs on
// shared egress, so a busy hour would fail verifications for reasons that have
// nothing to do with the owner. raw.githubusercontent.com is a CDN with no such
// budget. It also means no credential of ours is needed to check a proof, which
// keeps this free for a self-hosted deployment too.
//
// ── What this proves, and what it does not ──────────────────────────────────
//
// Proves: whoever controls the GitHub account `<login>` published our token.
// Does NOT prove who that person is, or that the account is not itself
// compromised. The tier is named `github` for the same reason the other one is
// named `domain` — it says what was checked, not that the owner is trustworthy.
//
// The two controls from lib/owner/domain.ts apply here unchanged and for the
// same reasons: (1) redirects are a failure and are never followed, and (2) the
// fetched body is NEVER returned to the caller, so a failed verification cannot
// become a read primitive.
import { isVerifiableDomain } from "./domain";

/** The repository an owner creates to hold their proof. */
export const GITHUB_OWNER_REPO = "passcontrol-owner";
/** The file inside it. */
export const GITHUB_OWNER_FILE = "owner.txt";

const RAW_HOST = "https://raw.githubusercontent.com";
/** Enough for a token line and a comment; anything past this is ignored. */
const MAX_DOCUMENT_BYTES = 4 * 1024;
const FETCH_TIMEOUT_MS = 5_000;

// GitHub's own rule: 1–39 characters, alphanumerics and single hyphens, and it
// may neither begin nor end with a hyphen. Deliberately no dots, underscores,
// slashes or percent signs — this string becomes one path segment of a URL we
// fetch, so anything that could add a segment, escape the host or carry a query
// has to be impossible rather than merely unusual.
const LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export type GithubFailure = "invalid_login" | "unreachable" | "not_published" | "token_mismatch";

export type GithubResult = { ok: true } | { ok: false; reason: GithubFailure };

export interface VerifyGithubOptions {
  fetch?: typeof fetch;
}

/**
 * Is this a GitHub login we are willing to build a URL from at all?
 *
 * One of the two real controls, so it is strict by construction: the regex
 * admits exactly the shape GitHub issues and nothing else. See the header.
 */
export function isVerifiableGithubLogin(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (!candidate || candidate.length > 39) return false;
  return LOGIN_RE.test(candidate);
}

/**
 * Where the proof for this login is expected. Exported so the dashboard can
 * show the owner the exact URL we will read, rather than describing it — the
 * instruction and the check then cannot drift apart.
 */
export function githubProofUrl(login: string): string {
  return `${RAW_HOST}/${login.trim().toLowerCase()}/${GITHUB_OWNER_REPO}/HEAD/${GITHUB_OWNER_FILE}`;
}

export async function verifyGithubControl(
  login: string,
  token: string,
  options: VerifyGithubOptions = {}
): Promise<GithubResult> {
  if (!isVerifiableGithubLogin(login)) return { ok: false, reason: "invalid_login" };
  if (!token) return { ok: false, reason: "token_mismatch" };

  const fetchImpl = options.fetch ?? fetch;

  let body: string;
  try {
    const res = await fetchImpl(githubProofUrl(login), {
      // A renamed or deleted repository answers with a redirect on some GitHub
      // hosts. Following it would let the response come from a path that is no
      // longer bound to the claimed login — which is the entire proof.
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "text/plain" },
    });
    if (!res.ok) return { ok: false, reason: "not_published" };
    body = (await res.text()).slice(0, MAX_DOCUMENT_BYTES);
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  // Whole-line match, for the reason the domain module gives: a substring check
  // would accept `not-really-<token>-nope`, and a repository is a place other
  // people can open pull requests against.
  const published = body.split(/\r?\n/).some((line) => line.trim() === token);

  // Nothing derived from `body` appears in either branch. See the header.
  return published ? { ok: true } : { ok: false, reason: "token_mismatch" };
}

/**
 * A login is not a hostname, and a hostname is not a login.
 *
 * Kept here rather than at the call site because the mistake it prevents is a
 * quiet one: `acme.com` fails the login regex on its dots and would be reported
 * as a malformed login, when what the owner actually did was pick the wrong
 * kind. Recognising it lets the caller say so.
 */
export function looksLikeDomainNotLogin(value: unknown): boolean {
  return !isVerifiableGithubLogin(value) && isVerifiableDomain(value);
}
