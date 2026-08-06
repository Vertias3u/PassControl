// Domain-control verification — proving an owner assertion for free.
//
// The owner publishes a token at
//   https://<domain>/.well-known/passcontrol-owner.txt
// and we fetch it. Control of a web server answering for that host is the
// claim, and it is the same model that made Let's Encrypt work.
//
// ── Why an HTTPS document and not a DNS TXT record ──────────────────────────
//
// Edge runtimes cannot resolve DNS, so a TXT check would have to go through a
// DNS-over-HTTPS resolver — meaning every self-hosted PassControl sends every
// verification query to Google or Cloudflare. That reintroduces exactly the
// shared third-party dependency the self-host story exists to avoid, and it
// buys nothing cryptographic: a DoH response's `AD` flag is the resolver's
// CLAIM of DNSSEC validation, not proof we can check ourselves.
//
// ── What this proves, and what it does not ──────────────────────────────────
//
// Proves: someone who can serve content for that hostname over HTTPS put our
// token there. Does NOT prove control of the DNS zone, and it is defeated by
// subdomain takeover. The tier is named `domain` rather than `verified` for
// that reason — it says what was checked, not that the owner is trustworthy.
//
// ── The two controls that matter ────────────────────────────────────────────
//
// Because DNS cannot be resolved here, a private-IP blocklist is impossible:
// we genuinely cannot tell whether acme.com points at 169.254.169.254. So the
// guards are (1) refuse to follow redirects, which is what stops a well-known
// document from redirecting us into a metadata service, and (2) NEVER return
// the fetched body to the caller, which stops a failed verification from
// becoming a read primitive against anything the gateway can reach.
import { bytesToBase64url } from "../encoding";

export const OWNER_WELL_KNOWN_PATH = "/.well-known/passcontrol-owner.txt";

/** Enough of the document to hold a token list; anything past this is ignored. */
const MAX_DOCUMENT_BYTES = 4 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_DOMAIN_LENGTH = 253;

// Hostname labels only: letters, digits, hyphens, dots. No scheme, no port, no
// userinfo, no path, no query. Requires at least one dot and a non-numeric TLD,
// which is also what rejects a bare IPv4 literal.
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export type DomainFailure = "invalid_domain" | "unreachable" | "not_published" | "token_mismatch";

export type DomainResult = { ok: true } | { ok: false; reason: DomainFailure };

export interface VerifyDomainOptions {
  fetch?: typeof fetch;
}

/**
 * Is this a hostname we are willing to make a request to at all?
 *
 * This is one of the two real controls (see the header), so it is deliberately
 * strict: a bare hostname or nothing. Anything carrying a scheme, port,
 * credentials, path or query is refused before a request is made.
 */
export function isVerifiableDomain(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const candidate = value.trim().toLowerCase();
  if (!candidate || candidate.length > MAX_DOMAIN_LENGTH) return false;
  if (candidate === "localhost") return false;
  return DOMAIN_RE.test(candidate);
}

/** A fresh token for an owner to publish. Namespaced so a site owner can tell what left it. */
export function newVerificationToken(): string {
  return `passcontrol-verify-${bytesToBase64url(crypto.getRandomValues(new Uint8Array(24)))}`;
}

export async function verifyDomainControl(
  domain: string,
  token: string,
  options: VerifyDomainOptions = {}
): Promise<DomainResult> {
  if (!isVerifiableDomain(domain)) return { ok: false, reason: "invalid_domain" };
  if (!token) return { ok: false, reason: "token_mismatch" };

  const fetchImpl = options.fetch ?? fetch;
  const url = `https://${domain.trim().toLowerCase()}${OWNER_WELL_KNOWN_PATH}`;

  let body: string;
  try {
    const res = await fetchImpl(url, {
      // Any redirect is a FAILURE, not a hop to follow. This is the guard that
      // stops the well-known document from steering us at a metadata service.
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "text/plain" },
    });
    if (!res.ok) return { ok: false, reason: "not_published" };
    // Bound what we read. An owner-controlled URL must not be able to make the
    // gateway buffer an unbounded response.
    body = (await res.text()).slice(0, MAX_DOCUMENT_BYTES);
  } catch {
    return { ok: false, reason: "unreachable" };
  }

  // Whole-line match. A substring check would accept `not-really-<token>-nope`,
  // which any site that echoes user input could be made to serve.
  const published = body.split(/\r?\n/).some((line) => line.trim() === token);

  // Note what is NOT returned on failure: nothing derived from `body`. See the
  // header — never echoing the document is the second of the two controls.
  return published ? { ok: true } : { ok: false, reason: "token_mismatch" };
}
