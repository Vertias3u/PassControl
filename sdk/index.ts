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
//   import { PassControl, ControlClient } from "./sdk";        // relative
//   import { PassControl, ControlClient } from "@/sdk";        // path alias (in-app)
//
// Self-hosting and want a flat copy? This folder is self-contained — vendor the
// whole `sdk/` directory; it only needs @noble/curves + the platform fetch/crypto.

export { PassControl } from "./passcontrol";
export type { PassControlOptions, ProviderId } from "./passcontrol";

export { ControlClient, ControlApiError } from "./control";
export type { ControlClientOptions, WriteOpts } from "./control";

export {
  verifyReceipt,
  verifyAgentToken,
  matchesIssuer,
  RECEIPT_TYP,
  AGENT_TOKEN_TYP,
  SUPPORTED_VER,
} from "./verify";
export type {
  ReceiptClaims,
  AgentTokenClaims,
  VerifyOptions,
  VerifyAgentTokenOptions,
  VerifyResult,
  VerifyFailure,
  PublicJwk,
} from "./verify";
