// C1 detection: was a Passport PRIVATE key just presented as a bearer token?
//
// PASSPORT_SECRET is base64url of a raw 32-byte Ed25519 seed — exactly 43
// base64url characters. So is PASSPORT_ID (the public key), so length cannot
// tell them apart; deriving can. The public key derived from the presented
// token is what an agent row would hold IF the token is that agent's secret.
// Pasting the public id derives a key that matches nothing.
//
// Pure and bounded: only a token of exactly the seed's shape costs one scalar
// multiplication. The caller decides whether it may spend the database lookup.
import { ed25519 } from "@noble/curves/ed25519";
import { base64urlToBytes, bytesToBase64url } from "@/lib/encoding";

const SEED_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function passportIdIfSecret(token: string): string | null {
  if (!SEED_SHAPE.test(token)) return null;
  try {
    const seed = base64urlToBytes(token);
    if (seed.length !== 32) return null;
    return bytesToBase64url(ed25519.getPublicKey(seed));
  } catch {
    return null;
  }
}
