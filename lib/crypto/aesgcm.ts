// AES-256-GCM envelope for the provider-key cache (Tension 1).
//
// Provider keys are decrypted from Vault on a cache miss, then re-encrypted with
// a gateway key held ONLY in the Edge env (CACHE_ENC_KEY) before being written
// to Redis. Redis therefore never holds plaintext — a Redis-only compromise
// yields ciphertext + IV but no usable key. Uses Web Crypto (edge-available).
import { bytesToBase64url, base64urlToBytes, utf8ToBytes, bytesToUtf8 } from "../encoding";

const IV_BYTES = 12;

// Web Crypto wants a concrete ArrayBuffer-backed view; .slice() guarantees one
// (vs the generic Uint8Array<ArrayBufferLike> the encoders return).
function ab(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

let cachedKey: Promise<CryptoKey> | null = null;

function importKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const raw = process.env.CACHE_ENC_KEY;
  if (!raw) throw new Error("CACHE_ENC_KEY is not set");
  // CACHE_ENC_KEY is base64 (standard) of 32 random bytes.
  const keyBytes = base64urlToBytes(raw.replace(/\+/g, "-").replace(/\//g, "_"));
  if (keyBytes.length !== 32) throw new Error("CACHE_ENC_KEY must decode to 32 bytes");
  cachedKey = crypto.subtle.importKey("raw", ab(keyBytes), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return cachedKey;
}

/** Encrypt plaintext -> "base64url(iv).base64url(ciphertext+tag)". */
export async function seal(plaintext: string): Promise<string> {
  const key = await importKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(iv) }, key, ab(utf8ToBytes(plaintext)))
  );
  return `${bytesToBase64url(iv)}.${bytesToBase64url(ct)}`;
}

/** Decrypt a value produced by seal(). Returns null on any failure. */
export async function open(token: string): Promise<string | null> {
  try {
    const [ivPart, ctPart] = token.split(".");
    if (!ivPart || !ctPart) return null;
    const key = await importKey();
    const iv = base64urlToBytes(ivPart);
    const ct = base64urlToBytes(ctPart);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ab(iv) }, key, ab(ct));
    return bytesToUtf8(new Uint8Array(pt));
  } catch {
    return null;
  }
}
