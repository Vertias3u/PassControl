// MFA recovery codes — one-time backup codes for the human dashboard login, used
// when the authenticator app is unavailable. Generated once and shown once; we
// persist only SHA-256 hashes (like API keys) and consume each at most once.
//
// Runtime-agnostic (Web Crypto). Codes use an unambiguous lowercase base32-ish
// charset (no 0/1/o/l/i) so they're easy to read and type back.
import type { SupabaseClient } from "@supabase/supabase-js";

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"; // 31 chars, no ambiguous glyphs
const GROUP = 5; // code = GROUP-GROUP (e.g. "a7k2m-pq9rs")
export const RECOVERY_CODE_COUNT = 10;

/** Normalize user input → the canonical hashed form (lowercase, strip non-charset). */
export function normalizeRecoveryCode(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** SHA-256 hex of a (normalized) recovery code. */
export async function hashRecoveryCode(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeRecoveryCode(raw)));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Bias-free random index into ALPHABET via rejection sampling. */
function randomChar(): string {
  const max = 256 - (256 % ALPHABET.length); // reject the non-uniform tail (>=248)
  const buf = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const b = buf[0]!;
    if (b < max) return ALPHABET[b % ALPHABET.length]!;
  }
}

function oneCode(): string {
  let s = "";
  for (let i = 0; i < GROUP * 2; i++) s += randomChar();
  return `${s.slice(0, GROUP)}-${s.slice(GROUP)}`;
}

export interface GeneratedRecoveryCode {
  /** Display code, shown to the user ONCE. */
  code: string;
  /** SHA-256 to persist. */
  hash: string;
}

/** Mint a fresh set of recovery codes (unique). Caller stores the hashes and
 *  shows the codes once. */
export async function generateRecoveryCodes(n = RECOVERY_CODE_COUNT): Promise<GeneratedRecoveryCode[]> {
  const out: GeneratedRecoveryCode[] = [];
  const seen = new Set<string>();
  while (out.length < n) {
    const code = oneCode();
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ code, hash: await hashRecoveryCode(code) });
  }
  return out;
}

/** Verify + consume a recovery code for a user. Single-use: the `used_at IS NULL`
 *  guard in the update means a code can be redeemed at most once. Tenant-scoped. */
export async function consumeRecoveryCode(
  db: SupabaseClient,
  userId: string,
  raw: string
): Promise<boolean> {
  const hash = await hashRecoveryCode(raw);
  const { data } = await db
    .from("mfa_recovery_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("code_hash", hash)
    .is("used_at", null)
    .select("id")
    .maybeSingle();
  return !!data;
}
