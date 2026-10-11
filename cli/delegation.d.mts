export const DELEGATION_TYP: "passcontrol-delegation+jws";
export const DELEGATION_MAX_DEPTH: number;
export const DELEGATION_MAX_LIFETIME_S: number;

export interface DelegationScopeEntry {
  provider: string;
  models: string[];
}

export interface CreateDelegationLinkOptions {
  /** The signer's private key: the agent's passport secret, or a worker's own key. */
  signerPrivateKey: string;
  /** Defaults to the signer's public key; must equal it unless `unchecked`. */
  signerKeyId?: string;
  /** The gateway's issuer origin, e.g. https://passcontrol.vertias.eu. */
  audience: string;
  workerPublicKey: string;
  scope: DelegationScopeEntry[];
  capMicrocents: number;
  ttlSeconds: number;
  /** false: the worker may not delegate on. Default true (depth 2 at most). */
  allowFurtherDelegation?: boolean;
  /** The signer's own chain, when a worker delegates on. */
  parentChain?: string[];
  jti?: string;
  nowMs?: number;
  /** Tests only: skip the local checks. The gateway still refuses. */
  unchecked?: boolean;
}

export interface DelegationLinkView {
  jti: string;
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  dep: number;
  max: number;
  cap: number;
  scope: DelegationScopeEntry[];
}

export type DelegationCheck =
  | { ok: true; leaf: DelegationLinkView; links: DelegationLinkView[]; chainHash: string }
  | { ok: false; reason: string };

export function delegationChainHash(chain: readonly string[]): string;
export function generateWorkerKey(): { publicKey: string; privateKey: string };
export function createDelegationLink(opts: CreateDelegationLinkOptions): string;
export function checkDelegationChain(input: {
  chain: unknown;
  rootPassportId: string;
  audience?: string;
  nowSeconds?: number;
}): DelegationCheck;
export function verifyReceiptDelegation(
  claims: { iss?: string; sub: string; auth?: unknown },
  chain: readonly string[],
  options?: { audience?: string; nowSeconds?: number }
): { ok: true; chain: DelegationCheck & { ok: true } } | { ok: false; reason: string };
