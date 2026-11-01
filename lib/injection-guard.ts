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
import { readUntrusted } from "./injection-blocks";

/**
 * Why tool output was not fully checked (1.7.1, external review P1). Such a finding has
 * severity `incomplete` and no families: it says nothing was found because not all of it
 * was read, which is not the same as clean. In hold mode it holds like a strong finding.
 *   too_large        past the sidecar's scan budget, or its hook body limit
 *   scan_failed      the scanner threw on it
 *   too_many_blocks  the gateway's block limit (lib/injection-blocks.ts)
 *   too_deep         text nested past the gateway's depth limit
 */
export const INJECTION_GAPS = ["too_large", "scan_failed", "too_many_blocks", "too_deep"] as const;
export type InjectionGap = (typeof INJECTION_GAPS)[number];

export interface InjectionFinding {
  path: string;
  source: string;
  families: InjectionFamily[];
  severity: InjectionSeverity | "incomplete";
  /** Set exactly when severity is `incomplete`. */
  gap?: InjectionGap;
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

/** The body as JSON, or a marker when it cannot be serialised (a cycle cannot arrive as JSON). */
/**
 * What identifies a body for a gap's HMAC: the request's own bytes when the caller has
 * them (the proxy does), else its JSON. A body too deep to serialise again has no stable
 * identity without its bytes, so it gets a new one each time: never a constant, which
 * would make every such body after the first a replay that Clear has already dismissed.
 */
function bodyIdentity(body: unknown, raw: string | undefined): string {
  if (typeof raw === "string") return `raw:${raw}`;
  try {
    return `json:${JSON.stringify(body) ?? ""}`;
  } catch {
    return `unserialisable:${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Every untrusted block in `body` that carries a tell, in body order, then what could not
 * be fully checked: a block the scanner failed on (`scan_failed`, at its first such block)
 * and a body read only in part (`too_many_blocks` / `too_deep`, at `body`). A gap's HMAC
 * is over the blocks that failed, or over the whole body: the same body re-sent is the
 * same finding and de-duplicates; one with a different unread part is new. `raw` is the
 * request's own text, which identifies a body better than re-serialising it.
 * `onUnknownTypes` hears the formats it has no rule for (telemetry only, never a finding).
 * `scan` is injectable for failure tests.
 */
export function findInjectionTells(
  body: unknown,
  hmacKey: string,
  { scan = scanText, raw, onUnknownTypes }: { scan?: typeof scanText; raw?: string; onUnknownTypes?: (types: string[]) => void } = {}
): InjectionFinding[] {
  const key = new TextEncoder().encode(hmacKey);
  const mac = (text: string) => hex(hmac(sha256, key, new TextEncoder().encode(text)));
  const { blocks, cut, unknownTypes } = readUntrusted(body);
  if (unknownTypes) {
    try {
      onUnknownTypes?.(unknownTypes);
    } catch {
      // Telemetry never changes what was found.
    }
  }
  const findings: InjectionFinding[] = [];
  const failed: typeof blocks = [];
  for (const block of blocks) {
    let hits;
    try {
      hits = scan(block.text);
    } catch {
      failed.push(block);
      continue;
    }
    if (hits.length === 0) continue;
    findings.push({
      path: storablePath(block.path),
      source: SOURCE_SHAPE.test(block.source) ? block.source : "other",
      families: hits.map((h) => h.family),
      severity: hits.some((h) => h.severity === "high") ? "high" : "low",
      contentHmac: mac(block.text),
    });
  }
  if (failed.length > 0) {
    findings.push({
      path: storablePath(failed[0]!.path),
      source: SOURCE_SHAPE.test(failed[0]!.source) ? failed[0]!.source : "other",
      families: [],
      severity: "incomplete",
      gap: "scan_failed",
      contentHmac: mac(`gap:scan_failed:${failed.map((b) => mac(b.text)).join(",")}`),
    });
  }
  if (cut) {
    findings.push({
      path: "body",
      source: "request",
      families: [],
      severity: "incomplete",
      gap: cut,
      // Over the whole body: the part not read is what differs, and must not de-duplicate.
      contentHmac: mac(`gap:${cut}:${bodyIdentity(body, raw)}`),
    });
  }
  return findings;
}

/** The one gap for a scan that failed outright, before any block was read. */
export function injectionScanFailed(body: unknown, hmacKey: string, raw?: string): InjectionFinding {
  const key = new TextEncoder().encode(hmacKey);
  return {
    path: "body",
    source: "request",
    families: [],
    severity: "incomplete",
    gap: "scan_failed",
    contentHmac: hex(hmac(sha256, key, new TextEncoder().encode(`gap:scan_failed:${bodyIdentity(body, raw)}`))),
  };
}

/**
 * The receipt's `inj` claim for this request's findings (lib/receipt.ts): every block
 * found, a re-sent one too, since the receipt describes this request, not what was new
 * to the table. Undefined when nothing was found. Kinds only.
 */
export function injectionReceiptClaim(findings: readonly InjectionFinding[] | null | undefined): InjectionReceiptClaim | undefined {
  // Tells only: the receipt's claim is unchanged by 1.7.1's gaps (external review).
  const tells = findings?.filter((f) => !f.gap) ?? [];
  if (tells.length === 0) return undefined;
  const found = new Set<string>(tells.flatMap((f) => f.families));
  return { d: INJECTION_DETECTOR, n: tells.length, f: INJECTION_FAMILIES.filter((f) => found.has(f)) };
}
