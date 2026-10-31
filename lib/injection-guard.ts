// The injection guard's findings for one request body (plans/injection-guard.md §2a, §5).
//
// Pure: the scan (cli/injection-scan.mjs) over the untrusted blocks
// (lib/injection-blocks.ts), and an HMAC per block that has a tell. What leaves here is
// what may be stored: where, from which kind of block, which families, how strong, and
// the HMAC. Never the text.
//
// The HMAC is keyed per tenant (the caller passes the key, as the secret guard's
// placeholder does), so the same page seen by two tenants gives two unrelated values:
// a bare hash would let one tenant learn what another has read. Within a tenant it is
// stable, which is what de-duplicates a block a coding agent re-sends on every call.
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";

import { INJECTION_DETECTOR, INJECTION_FAMILIES, scanText, type InjectionFamily, type InjectionSeverity } from "@/cli/injection-scan.mjs";
import type { InjectionReceiptClaim } from "./receipt";
import { untrustedBlocks } from "./injection-blocks";

export interface InjectionFinding {
  path: string;
  source: string;
  families: InjectionFamily[];
  severity: InjectionSeverity;
  /** HMAC-SHA256 of the block's text under the tenant's key, hex. */
  contentHmac: string;
  /** The tool that returned the block, where the surface knows it (the sidecar's hook). */
  toolName?: string | null;
}

/** The tenant's HMAC key: per tenant, and by the gateway's own secret, as the secret guard's is. */
export function injectionHmacKey(userId: string): string {
  return `injection-guard-v1:${userId}:${process.env.VISA_SECRET ?? ""}`;
}

/**
 * The stored value for a block the sidecar saw. The sidecar sends a SHA-256 of the block,
 * never the block, and cannot hold this key; so the HMAC is over that hash, under a
 * `sidecar:` label, and the hash itself is never stored.
 */
export function sidecarContentHmac(userId: string, blockSha256: string): string {
  return hex(hmac(sha256, new TextEncoder().encode(injectionHmacKey(userId)), new TextEncoder().encode(`sidecar:${blockSha256}`)));
}

const PATH_MAX = 512;
const SOURCE_SHAPE = /^[a-z_]{1,64}$/;

/** A JSON path built from a client's own keys, reduced to what the table accepts. */
function storablePath(path: string): string {
  return path.replace(/[^A-Za-z0-9_.[\]-]/g, "?").slice(0, PATH_MAX);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Every untrusted block in `body` that carries a tell, in body order. */
export function findInjectionTells(body: unknown, hmacKey: string): InjectionFinding[] {
  const key = new TextEncoder().encode(hmacKey);
  const findings: InjectionFinding[] = [];
  for (const block of untrustedBlocks(body)) {
    const hits = scanText(block.text);
    if (hits.length === 0) continue;
    findings.push({
      path: storablePath(block.path),
      source: SOURCE_SHAPE.test(block.source) ? block.source : "other",
      families: hits.map((h) => h.family),
      severity: hits.some((h) => h.severity === "high") ? "high" : "low",
      contentHmac: hex(hmac(sha256, key, new TextEncoder().encode(block.text))),
    });
  }
  return findings;
}

/**
 * The receipt's `inj` claim for this request's findings (lib/receipt.ts): every block
 * found, a re-sent one too, since the receipt describes this request, not what was new
 * to the table. Undefined when nothing was found. Kinds only.
 */
export function injectionReceiptClaim(findings: readonly InjectionFinding[] | null | undefined): InjectionReceiptClaim | undefined {
  if (!findings || findings.length === 0) return undefined;
  const found = new Set<string>(findings.flatMap((f) => f.families));
  return { d: INJECTION_DETECTOR, n: findings.length, f: INJECTION_FAMILIES.filter((f) => found.has(f)) };
}
