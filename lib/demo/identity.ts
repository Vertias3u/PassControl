import "server-only";

// Canonical app-side identity for the keyless demo. This module is guarded by
// `server-only` so importing it into a Client Component fails the Next.js build.
// These seeded values are PUBLIC and committed on purpose for the keyless demo.
// They must NEVER receive a real provider scope or be reused as a live control key.
export const SEEDED_DEMO_PASSPORT_ID =
  "kZCFp7d2x4VDruiulJ21gogYbczBDAGZa-OuwR3qgh8";
export const SEEDED_DEMO_PASSPORT_SECRET =
  "XqsVuXtmWiu6bKEmmqov2Q2TwkOVdzlZMWR-NWubSKo";
export const SEEDED_DEMO_CONTROL_KEY =
  "pc_demolocaltrydemolocaltrydemolocaltry0000";

export function demoPassportId(): string {
  return process.env.PASSCONTROL_DEMO_PASSPORT_ID?.trim() || SEEDED_DEMO_PASSPORT_ID;
}

export function demoPassportSecret(): string {
  return (
    process.env.PASSCONTROL_DEMO_PASSPORT_SECRET?.trim() ||
    SEEDED_DEMO_PASSPORT_SECRET
  );
}

export function demoControlKey(): string {
  return process.env.PASSCONTROL_DEMO_CONTROL_KEY?.trim() || SEEDED_DEMO_CONTROL_KEY;
}

/**
 * The committed demo values, which anyone can read in the public repo: the secret
 * guard (lib/secret-guard.ts) does not treat these as secrets. Deliberately the SEEDED
 * values and not the accessors: a rotated value set through the environment is a real
 * secret, and must be caught like one.
 */
export function publiclyCommittedDemoValues(): readonly string[] {
  return [SEEDED_DEMO_CONTROL_KEY, SEEDED_DEMO_PASSPORT_SECRET];
}
