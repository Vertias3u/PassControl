// "Ask me first": what exactly the owner said yes to.
//
// An approval admits one request, and "the same request" has to mean the same
// bytes the gateway will send: the method, the upstream path, the query it
// forwards, every header it forwards and the body. Anything left out could be
// changed on the retry. Approving `send "hello"` must not admit `send
// "@everyone ..."`, and approving a call with one `Notion-Version` must not
// admit it under another, so all of it goes in.
//
// The query is the FORWARDED one (forwardableUpstreamSearch), not req.url's:
// Next appends its own route params to req.url (the `nxtP` trap in
// CLAUDE.md), and those differ from what reaches the service.
//
// Scoped to the workspace and the agent: the same request from another agent
// is another question.

export interface FingerprintInput {
  userId: string;
  agentId: string;
  service: string;
  method: string;
  upstreamPath: string;
  /** As forwarded: "" or "?a=1&b=2". */
  search: string;
  /** Exactly the headers the gateway forwards (filterRequestHeaders). */
  headers: Headers;
  /** The body as forwarded; null for a read. */
  body: string | null;
}

export async function approvalFingerprint(input: FingerprintInput): Promise<string> {
  const headers = [...input.headers.entries()]
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = JSON.stringify([
    "pc-approval-v1",
    input.userId,
    input.agentId,
    input.service,
    input.method.toUpperCase(),
    input.upstreamPath,
    input.search,
    headers,
    input.body,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * What the owner reads before deciding: the forwarded query and the whole body,
 * unaltered. Not shortened here: the store keeps all of it (up to
 * APPROVAL_PREVIEW_MAX, and the gateway refuses a larger request), and each
 * prompt says when it shows less than all of it.
 */
export function approvalPreview(body: string | null, search: string): string {
  return [search, body ?? ""].filter((part) => part !== "").join("\n");
}
