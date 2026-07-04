// Constant-time string comparison for secrets (invite code, cron secret, etc.).
//
// node:crypto.timingSafeEqual is not reliably available across Edge runtimes, so
// we implement a length-independent XOR accumulator over the raw UTF-8 bytes.
// It always iterates the full length and folds the length difference into the
// accumulator, so an attacker cannot infer how many leading bytes are correct.
import { utf8ToBytes } from "../encoding";

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = utf8ToBytes(a);
  const bb = utf8ToBytes(b);
  const len = Math.max(ab.length, bb.length);
  // Seed with the length difference so unequal lengths can never compare equal.
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
