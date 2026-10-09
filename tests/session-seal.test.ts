// The issuer's half of session receipts (sprint Q7): build and sign the seal over
// one agent's receipts in one declared session.
//
// The test that matters is the round trip: whatever the gateway signs must pass
// BOTH verifiers (sdk/verify.ts and cli/verify.mjs), including against the user's
// journal. The totals are computed from the signed receipts themselves, which is
// exactly what a verifier recomputes, so the two cannot drift apart.
import { beforeEach, describe, expect, it } from "vitest";

import { bytesToBase64url } from "@/lib/encoding";
import { loadInstanceSigner, publicJwk } from "@/lib/crypto/instanceKey";
import { RECEIPT_TYP, signCompactJws, verifyCompactJws } from "@/lib/crypto/jws";
import { SESSION_TYP, buildSessionClaims, signSessionSeal } from "@/lib/session-seal";
import * as sdk from "@/sdk/verify";
// @ts-expect-error plain ESM CLI module
import * as cli from "../cli/verify.mjs";

const ISSUER = "https://gw.example.com";
const AGENT = "f9de697b-6b2f-4d29-9978-0ff9547f15f3";
const SES = "00000000-0000-4000-8000-000000000001";
const T0 = Date.UTC(2026, 9, 8, 3, 0, 0);
// Set before the fixtures below are signed at load; beforeEach restores it per test.
process.env.INSTANCE_SIGNING_KEY = bytesToBase64url(new Uint8Array(32).fill(4));
process.env.PASSCONTROL_ISSUER = ISSUER;

beforeEach(() => {
  process.env.INSTANCE_SIGNING_KEY = bytesToBase64url(new Uint8Array(32).fill(4));
  process.env.PASSCONTROL_ISSUER = ISSUER;
});

function receipt(o: { id: string; t0: number; cost: number; agt?: string; par?: string; mdl?: string; status?: string; unp?: boolean }) {
  const s = loadInstanceSigner()!;
  return signCompactJws({
    typ: RECEIPT_TYP,
    kid: s.kid,
    seed: s.seed,
    claims: {
      iss: ISSUER,
      sub: "passport",
      jti: o.id,
      iat: Math.floor(o.t0 / 1000),
      agid: AGENT,
      prov: "anthropic",
      mdl: o.mdl ?? "claude-haiku-4-5",
      mth: "POST",
      path: "v1/messages",
      use: { in: 1, out: 1 },
      cost: o.cost,
      ...(o.unp ? { unp: true } : {}),
      res: { status: o.status ?? "ok", http: 200 },
      t0: o.t0,
      lat: 1,
      ver: 1,
      ctx: { src: "declared", cli: "claude-code", ses: SES, ...(o.agt ? { agt: o.agt } : {}), ...(o.par ? { par: o.par } : {}) },
    },
  });
}

const ROWS = [
  { receipt: receipt({ id: "r1", t0: T0, cost: 3_000_000 }), cost_microcents: 3_000_000, unpriced: false },
  { receipt: receipt({ id: "r2", t0: T0 + 1500, cost: 1_000_000, agt: "a1" }), cost_microcents: 1_000_000, unpriced: false },
  { receipt: receipt({ id: "r3", t0: T0 + 2500, cost: 0, agt: "a2", par: "a1", status: "blocked_scope" }), cost_microcents: 0, unpriced: false },
  { receipt: receipt({ id: "r4", t0: T0 + 60_000, cost: 0, unp: true, mdl: "qwen" }), cost_microcents: 0, unpriced: true },
  // A row whose signing failed: logged, but carries no receipt, so the root cannot cover it.
  { receipt: null, cost_microcents: 500, unpriced: false },
  // A receipt whose row recorded no cost and no reason.
  { receipt: receipt({ id: "r6", t0: T0 + 61_000, cost: 0 }), cost_microcents: null, unpriced: false },
];

const input = (rows = ROWS) => ({
  issuer: ISSUER,
  sealId: "seal-1",
  agentId: AGENT,
  sessionId: SES,
  src: "claude-code",
  rows,
  generatedAt: T0 + 120_000,
});

const jwks = (() => {
  const fetchJwks = (async () => {
    const s = loadInstanceSigner()!;
    return { ok: true, json: async () => ({ keys: [publicJwk(s.publicKey)] }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return fetchJwks;
})();

describe("buildSessionClaims", () => {
  it("states what the seal covers, from the receipts themselves", () => {
    const { claims, bundle } = buildSessionClaims(input());
    expect(bundle).toHaveLength(5);
    expect(claims).toMatchObject({
      iss: ISSUER,
      sub: AGENT,
      jti: "seal-1",
      fmt: "passcontrol.session",
      v: 1,
      ses: { id: SES, src: "claude-code" },
      n: 5,
      nr: 6,
      cost: 4_000_000,
      unp: 1,
      unk: 1,
    });
    expect(claims.per).toEqual({ from: Math.floor(T0 / 1000), to: Math.floor((T0 + 61_000) / 1000) + 1 });
    expect(claims.tree).toEqual(
      expect.arrayContaining([
        { agt: null, par: null, n: 3, cost: 3_000_000, refused: 0 },
        { agt: "a1", par: null, n: 1, cost: 1_000_000, refused: 0 },
        { agt: "a2", par: "a1", n: 1, cost: 0, refused: 1 },
      ])
    );
    expect(claims.mdl).toEqual(
      expect.arrayContaining([
        { mdl: "claude-haiku-4-5", n: 4, cost: 4_000_000 },
        { mdl: "qwen", n: 1, cost: 0 },
      ])
    );
  });

  it("an empty session has no root and a zero-width window at the seal time", () => {
    const { claims, bundle } = buildSessionClaims(input([]));
    expect(bundle).toEqual([]);
    expect(claims.root).toBeNull();
    expect(claims.n).toBe(0);
  });
});

describe("the signed seal passes both verifiers", () => {
  it("as a seal, with its bundle, against a matching journal", async () => {
    const { claims, bundle } = buildSessionClaims(input());
    const seal = signSessionSeal(claims)!;
    expect(verifyCompactJws(seal, loadInstanceSigner()!.publicKey, { typ: SESSION_TYP })).not.toBeNull();
    const journal = ["r1", "r2", "r3", "r4", "r6"].map((id) => ({ id, t: 1, s: 200 }));
    const a = await sdk.verifySession({ seal, bundle, journal }, { trustedIssuers: [ISSUER], fetch: jwks });
    const b = await cli.verifySession({ seal, bundle, journal }, { issuer: ISSUER, fetch: jwks });
    expect(a).toMatchObject({ ok: true, checks: { signature: true, bundle: true, receipts: true, journal: true } });
    expect(b.ok).toBe(true);
  });

  it("and a call the seal left out is caught by the journal", async () => {
    const { claims, bundle } = buildSessionClaims(input(ROWS.slice(0, 2)));
    const seal = signSessionSeal(claims)!;
    const r = await sdk.verifySession({ seal, bundle, journal: ["r1", "r2", "r3"] }, { trustedIssuers: [ISSUER], fetch: jwks });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["r3"]);
  });

  it("returns null when the instance cannot sign", () => {
    delete process.env.INSTANCE_SIGNING_KEY;
    expect(signSessionSeal(buildSessionClaims(input()).claims)).toBeNull();
  });
});
