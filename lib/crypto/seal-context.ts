// What a value sealed by lib/crypto/aesgcm.ts is FOR (cloud review 2026-11-03, A2).
// The context is GCM's additional authenticated data: a value opens only for the
// context it was sealed for. A module of its own, with no key and no crypto, so the
// many tests that stub seal/open still get the real contexts.

/**
 * Built only here, as a JSON array, so no two field lists can join into the same
 * string (`a:b`+`c` against `a`+`b:c`).
 */
export type SealContext = string & { readonly __sealContext: unique symbol };
const context = (...parts: (string | number | null)[]) => JSON.stringify(["passcontrol-seal", ...parts]) as SealContext;

export const sealContext = {
  /** A provider key in the proxy's cache: this agent, this provider, this credential (or none). */
  providerKey: (agentId: string, provider: string, credentialId: string | null) =>
    context("provider-key-cache", 1, agentId, provider, credentialId),
  /** A probed key awaiting import: this user, this handoff id. */
  keyImport: (userId: string, handoffId: string) => context("key-import", 1, userId, handoffId),
  /** A device login's control-key grant: this device code's hash. */
  deviceGrant: (deviceCodeHash: string) => context("device-grant", 1, deviceCodeHash),
};
