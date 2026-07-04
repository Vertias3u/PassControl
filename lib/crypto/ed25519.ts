// Ed25519 passport verification.
//
// We use @noble/curves/ed25519 (NOT Web Crypto, NOT bare @noble/ed25519 sync):
//   - Web Crypto Ed25519 is not reliably available across all Edge runtimes.
//   - @noble/ed25519 v2 sync verify throws unless etc.sha512Sync is wired.
// @noble/curves bundles SHA-512, so verify works synchronously with no globals.
import { ed25519 } from "@noble/curves/ed25519";
import { base64urlToBytes } from "../encoding";

/** Verify an Ed25519 signature over raw message bytes. Never throws. */
export function verifySignature(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/** Decode a base64url passport_id into its raw 32-byte public key. */
export function passportIdToPublicKey(passportId: string): Uint8Array | null {
  try {
    const key = base64urlToBytes(passportId);
    return key.length === 32 ? key : null;
  } catch {
    return null;
  }
}
