// PassControl SDK — single entry point.
//
// Two clients and a verifier, one import:
//   • PassControl  (data plane)    — hides visa minting; re-point your OpenAI/
//                                     Anthropic SDK at the gateway, don't rewrite.
//   • ControlClient (control plane) — typed wrapper over /api/control/v1 (pc_ key)
//                                     to manage the fleet.
//   • verifyReceipt (verification)  — check a signed call receipt against the
//                                     issuer's published JWKS. This one is for
//                                     people OUTSIDE your deployment: it needs
//                                     no key, no account, and no callback here.
//
// npm consumers load this entry point through the `passcontrol/sdk` export;
// the dashboard consumes the same source through its local path alias.
//
// Self-hosting and want a flat copy? This folder is self-contained — vendor the
// whole `sdk/` directory; it only needs @noble/curves + the platform fetch/crypto.

export { PassControl } from "./passcontrol.js";
export type { PassControlOptions, ProviderId } from "./passcontrol.js";

export { ControlClient, ControlApiError } from "./control.js";
export type { ControlClientOptions, WriteOpts } from "./control.js";

export {
  verifyReceipt,
  verifyAgentToken,
  matchesIssuer,
  RECEIPT_TYP,
  AGENT_TOKEN_TYP,
  SUPPORTED_VER,
} from "./verify.js";
export type {
  ReceiptClaims,
  AgentTokenClaims,
  VerifyOptions,
  VerifyAgentTokenOptions,
  VerifyResult,
  VerifyFailure,
  PublicJwk,
} from "./verify.js";
