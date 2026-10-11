// Bet D slice 3 (plans/delegation-design.md §13): a delegated visa is refused at every
// door that has not opted in. /api/v1/self would report the PARENT's budget as the
// worker's own, and service scopes are not part of a delegation; only the provider
// route opts in, once its caps and revocation read exist. And on a delegated visa the
// sender proof must be made by the WORKER's key, never the parent's.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

vi.mock("@vercel/functions", () => ({ waitUntil: () => undefined }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimitFailClosed: async () => ({ success: true }) }));
vi.mock("@/lib/observability", () => ({ captureError: async () => {}, captureSecurityEvent: async () => {} }));
vi.mock("@/lib/state/redis", () => ({
  claimNonce: async () => true,
  touchLastSeen: async () => {},
  flagPassportSecretExposed: async () => {},
}));

import { authenticateGatewayRequest, evaluateSenderProof, type PassportPrincipal } from "@/lib/gateway/authenticate";
import { mintDelegatedVisa, mintVisa, SENDER_PROOF_HEADER } from "@/lib/auth/visa";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const rootPriv = new Uint8Array(32).fill(7);
const workerPriv = new Uint8Array(32).fill(9);
const ROOT = b64(ed25519.getPublicKey(rootPriv));
const WORKER = b64(ed25519.getPublicKey(workerPriv));
const NOW = Math.floor(Date.now() / 1000);
const URL_ = "https://gw.example/api/v1/anthropic/v1/messages";
const base = {
  passportId: ROOT,
  agentId: "aid",
  userId: "uid",
  jti: "visa-1",
  scope: [{ provider: "anthropic", models: ["claude-haiku-4-5"] }],
  budgetTokens: null,
  budgetCents: null,
  spentTokens: 0,
  spentMicrocents: 0,
};
const LINKS = [{ dlg: "jti-0000000000000001", cap: 5_000_000, iat: NOW - 5, exp: NOW + 600 }];
const delegatedVisa = () =>
  mintDelegatedVisa({ ...base, actor: WORKER, delegationJti: LINKS[0]!.dlg, depth: 1, chainHash: "c".repeat(43), links: LINKS });

function proof(priv: Uint8Array, visa: string) {
  const payload = new TextEncoder().encode(
    JSON.stringify({ htm: "POST", htu: URL_, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID(), vh: b64(sha256(new TextEncoder().encode(visa))) })
  );
  return `${b64(payload)}.${b64(ed25519.sign(payload, priv))}`;
}
const request = (visa: string, extra: Record<string, string> = {}) =>
  new Request(URL_, { method: "POST", headers: { authorization: `Bearer ${visa}`, ...extra } });

beforeEach(() => {
  process.env.VISA_SECRET = "test-secret-test-secret-test-secret-32";
  process.env.VISA_TTL_SECONDS = "300";
});

describe("the delegated-visa door", () => {
  it("is shut by default: 403 delegated_visa_not_accepted", async () => {
    const { token } = await delegatedVisa();
    const r = await authenticateGatewayRequest(request(token), "self", "self");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(403);
      expect(await r.response.json()).toMatchObject({ error: "delegated_visa_not_accepted" });
    }
  });

  it("opens only for a route that opts in, and the principal names the worker", async () => {
    const { token } = await delegatedVisa();
    const r = await authenticateGatewayRequest(request(token), "anthropic", "api.proxy", { acceptDelegated: true });
    expect(r.ok).toBe(true);
    if (r.ok && r.principal.kind === "passport") {
      expect(r.principal.passportId).toBe(ROOT);
      expect(r.principal.agentId).toBe("aid");
      expect(r.principal.delegation).toEqual({
        actor: WORKER,
        jti: "jti-0000000000000001",
        depth: 1,
        chainHash: "c".repeat(43),
        links: LINKS,
      });
    }
  });

  it("an ordinary visa carries no delegation, on either kind of route", async () => {
    const { token } = await mintVisa(base);
    for (const options of [{}, { acceptDelegated: true }]) {
      const r = await authenticateGatewayRequest(request(token), "anthropic", "api.proxy", options);
      expect(r.ok && r.principal.kind === "passport" && r.principal.delegation).toBeFalsy();
      expect(r.ok).toBe(true);
    }
  });
});

describe("the sender proof on a delegated visa", () => {
  async function principalFor(token: string) {
    const r = await authenticateGatewayRequest(request(token), "anthropic", "api.proxy", { acceptDelegated: true });
    if (!r.ok || r.principal.kind !== "passport") throw new Error("not admitted");
    return r.principal as PassportPrincipal;
  }
  it("passes when the worker signs it", async () => {
    const { token } = await delegatedVisa();
    const p = await principalFor(token);
    expect(await evaluateSenderProof(request(token, { [SENDER_PROOF_HEADER]: proof(workerPriv, token) }), token, p)).toEqual({ verdict: "pass" });
  });
  it("is invalid when the PARENT signs it", async () => {
    const { token } = await delegatedVisa();
    const p = await principalFor(token);
    expect(await evaluateSenderProof(request(token, { [SENDER_PROOF_HEADER]: proof(rootPriv, token) }), token, p)).toEqual({ verdict: "invalid" });
  });
});
