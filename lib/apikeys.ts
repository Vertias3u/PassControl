// Developer API keys for the public control-plane API (/api/control/v1).
//
// A key is a high-entropy random token shown to the developer exactly ONCE. We
// persist only its SHA-256 hash (one-way) plus a short non-secret display prefix.
// The token has ≥256 bits of entropy, so a fast hash is the right choice — this is
// not a low-entropy password, so bcrypt/salting would add nothing. Verification
// (Phase B) hashes the presented token and looks up the row by hash.
//
// Runtime-agnostic: uses the Web Crypto API (crypto.subtle / getRandomValues),
// available in the edge runtime, Node 20+, and the browser.

export const KEY_PREFIX = "pc_";
const RANDOM_BYTES = 32; // 256 bits
export const PREFIX_DISPLAY_LEN = KEY_PREFIX.length + 8; // 'pc_' + 8 chars, shown in the UI

function bytesToBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = typeof btoa !== "undefined" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 hex of a token. Deterministic; used at create + at verify time. */
export async function hashApiKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface GeneratedKey {
  /** The full secret token — returned to the developer ONCE, never persisted. */
  token: string;
  /** Non-secret display prefix stored for identification (e.g. `pc_a1b2c3d4`). */
  prefix: string;
  /** SHA-256 of the token — the only representation we persist. */
  hash: string;
}

/** Mint a new API key. The caller stores { prefix, hash } and shows `token` once. */
export async function generateApiKey(): Promise<GeneratedKey> {
  const rand = new Uint8Array(RANDOM_BYTES);
  crypto.getRandomValues(rand);
  const token = KEY_PREFIX + bytesToBase64url(rand);
  return { token, prefix: token.slice(0, PREFIX_DISPLAY_LEN), hash: await hashApiKey(token) };
}

/** Shape check for a presented token (cheap pre-filter before a hash lookup).
 *  Upper-bounded so an attacker can't feed a giant string into the hash. A real
 *  key is `pc_` + 43 base64url chars; 20–80 covers it with margin. */
export function isApiKeyFormat(token: string): boolean {
  return /^pc_[A-Za-z0-9_-]{20,80}$/.test(token);
}
