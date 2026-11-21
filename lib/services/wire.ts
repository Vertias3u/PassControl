// What crosses the service boundary besides the body: headers in both
// directions, and the two headers that carry URLs back to the agent.
//
// Allowlists, not denylists. An agent's own credential (its visa or Direct Agent
// Key) arrives in `authorization` / `x-api-key` and must never reach a third
// party, and a service's response can carry things an agent has no business
// reading — `x-oauth-scopes` names everything the TENANT's token can do, which
// is exactly the ceiling the per-agent rules exist to hide.
import { redactSecretsInText } from "@/lib/providers/secret-redaction";
import type { ServiceCatalogEntry } from "@/lib/services/catalog";

// The same bound the LLM route puts on `accept`, and a hard stop on control
// characters: a header an agent sends travels next to the tenant's token.
const MAX_FORWARDED_HEADER_LENGTH = 1024;

export function filterRequestHeaders(entry: ServiceCatalogEntry, incoming: Headers): Headers {
  const out = new Headers();
  for (const name of entry.requestHeaders) {
    const value = incoming.get(name);
    if (value === null || value.length > MAX_FORWARDED_HEADER_LENGTH) continue;
    if (/[\u0000-\u001f\u007f]/u.test(value)) continue;
    out.set(name, value);
  }
  return out;
}

export function filterResponseHeaders(
  entry: ServiceCatalogEntry,
  upstream: Headers,
  secrets: readonly string[] = [],
  onRedact?: () => void
): Headers {
  const out = new Headers();
  for (const name of entry.responseHeaders) {
    const value = upstream.get(name);
    if (value !== null) {
      const safe = redactSecretsInText(value, secrets);
      if (safe.redacted) onRedact?.();
      out.set(name, safe.text);
    }
  }
  return out;
}

const PAGINATION_RELS = new Set(["next", "prev", "first", "last"]);
// GitHub's shape exactly: `<absolute-url>; rel="name"`, comma-separated.
const LINK_ITEM = /\s*<([^>]*)>\s*;\s*rel="([^"]+)"\s*(?:,|$)/uy;

/**
 * A pagination `link` header, rewritten so every page stays governed (T7).
 *
 * GitHub names a repository by its NUMERIC id in pagination links
 * (`/repositories/1300192/issues?page=2`), so pointing the link at the gateway
 * as-is would send page 2 to a path the agent's `/repos/acme/*` rule does not
 * match. A pagination link is, by definition, the same collection with a
 * different query, so the rewrite keeps the path the agent asked for — which
 * its rules already admitted — and takes only GitHub's query string. The agent
 * can page through what it was allowed to read, and nothing else.
 *
 * Only exact-origin, https, pagination-rel items survive. Anything unparseable
 * drops the whole header rather than passing an unexamined URL through. Returns
 * null when nothing survives.
 */
export function rewriteLinkHeader(
  value: string,
  gatewayBase: string,
  requestPath: string,
  serviceOrigin: string
): string | null {
  if (!value) return null;
  const kept: string[] = [];
  LINK_ITEM.lastIndex = 0;
  while (LINK_ITEM.lastIndex < value.length) {
    const start = LINK_ITEM.lastIndex;
    const match = LINK_ITEM.exec(value);
    if (!match || match.index !== start) return null;
    const [, target, rel] = match;
    let url: URL;
    try {
      url = new URL(target!);
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || url.origin !== serviceOrigin) continue;
    if (!PAGINATION_RELS.has(rel!)) continue;
    kept.push(`<${gatewayBase}${requestPath}${url.search}>; rel="${rel}"`);
  }
  return kept.length ? kept.join(", ") : null;
}

/**
 * A redirect's `location`, as the agent should see it (T6).
 *
 * The gateway never follows a redirect (`redirect: "manual"`), so the service
 * credential never travels to where it points. Another https host — GitHub
 * sends archive downloads to codeload — passes through untouched, and the agent
 * follows it without a key. A redirect on the service's own origin (a renamed
 * repository's 301 to `/repositories/<id>/…`) is pointed back at the gateway, so
 * following it is governed like any other call. That rewritten path is then
 * matched against the rules like any other, and a `/repos/…` rule does not
 * match `/repositories/…`: the follow-up is refused, which is the correct
 * direction to fail. Relative, non-https or unparseable values are dropped.
 */
export function rewriteLocationHeader(
  value: string,
  gatewayBase: string,
  serviceOrigin: string
): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.origin === serviceOrigin) return `${gatewayBase}${url.pathname}${url.search}`;
  return value;
}

// How much of a service's JSON/text answer the route reads whole, so the redactor can
// see through `\uXXXX` escapes. The same bound the stream redactor puts on one line.
export const SERVICE_INSPECT_MAX_BYTES = 1024 * 1024;

export type BoundedRead =
  | { complete: true; bytes: Uint8Array<ArrayBuffer> }
  | { complete: false; stream: ReadableStream<Uint8Array> };

// Read a body up to `max` bytes. If it ends within the bound, return all of it. If not,
// return a stream that replays what was read and then the rest, unread, so the caller
// falls back to streaming and never holds more than `max` (plus one chunk) in memory.
export async function readBounded(body: ReadableStream<Uint8Array>, max: number): Promise<BoundedRead> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total > max) {
      return {
        complete: false,
        stream: new ReadableStream<Uint8Array>({
          start(controller) { for (const c of chunks) controller.enqueue(c); },
          async pull(controller) {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
          cancel(reason) { return reader.cancel(reason); },
        }),
      };
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
  return { complete: true, bytes };
}
