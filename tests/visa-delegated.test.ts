// Bet D slice 3 (plans/delegation-design.md §5, §13): the delegated visa, ver 3.
// `sub` stays the ROOT passport, so every passport-keyed check (kill, suspend,
// denylist, budget) applies to the whole tree; the worker's key goes in `act` and
// `cnf`, so only the worker can make a sender proof. No v1/v2 rule is loosened.
import { beforeEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { SignJWT, decodeJwt } from "jose";
import { bytesToBase64url } from "../lib/encoding";
import { jwkThumbprint } from "../lib/crypto/ed25519";
import { mintDelegatedVisa, mintVisa, verifyVisa, VISA_AUD, VISA_DELEGATED_VER, VISA_ISS } from "../lib/auth/visa";

const SECRET = "test-secret-test-secret-test-secret-32";
const keyId = (seed: number) => bytesToBase64url(ed25519.getPublicKey(new Uint8Array(32).fill(seed)));
const ROOT = keyId(7);
const WORKER = keyId(9);
const NOW = Math.floor(Date.now() / 1000);
const DC = [{ dlg: "jti-0000000000000001", cap: 50_000_000, iat: NOW - 10, exp: NOW + 3600 }];
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
const delegated = {
  ...base,
  actor: WORKER,
  delegationJti: "jti-0000000000000001",
  depth: 1,
  chainHash: "c".repeat(43),
  links: DC,
};

beforeEach(() => {
  process.env.VISA_SECRET = SECRET;
  delete process.env.VISA_SECRET_PREV;
  process.env.VISA_TTL_SECONDS = "300";
});

/** Sign arbitrary claims with the real secret: a forged-but-validly-signed visa. */
async function forge(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(VISA_ISS)
    .setAudience(VISA_AUD)
    .setSubject(ROOT)
    .setJti("visa-x")
    .setIssuedAt()
    .setExpirationTime("300s")
    .sign(new TextEncoder().encode(SECRET));
}
const body = { agid: "aid", uid: "uid", scope: [], bt: null, bc: null, st: 0, sc: 0 };
const act = { sub: WORKER, dlg: "jti-0000000000000001", dep: 1, ch: "c".repeat(43) };

describe("mintDelegatedVisa", () => {
  it("names the root passport as sub, the worker in act and cnf, the caps in dc", async () => {
    const { token } = await mintDelegatedVisa(delegated);
    const claims = await verifyVisa(token);
    expect(claims).toMatchObject({
      sub: ROOT,
      agid: "aid",
      ver: VISA_DELEGATED_VER,
      cnf: { jkt: jwkThumbprint(WORKER) },
      act: { sub: WORKER, dlg: "jti-0000000000000001", dep: 1, ch: "c".repeat(43) },
      dc: DC,
    });
  });

  it("never outlives the delegation it was minted under", async () => {
    const { token, expSeconds } = await mintDelegatedVisa({ ...delegated, links: [{ ...DC[0]!, exp: NOW + 60 }] });
    const exp = decodeJwt(token).exp!;
    expect(exp).toBeLessThanOrEqual(NOW + 61);
    expect(expSeconds).toBeLessThanOrEqual(61);
  });

  it("refuses to mint a malformed delegation rather than signing it", async () => {
    await expect(mintDelegatedVisa({ ...delegated, links: [] })).rejects.toThrow();
    await expect(mintDelegatedVisa({ ...delegated, actor: "nope" })).rejects.toThrow();
    await expect(mintDelegatedVisa({ ...delegated, delegationJti: "jti-other0000000000" })).rejects.toThrow();
  });
});

describe("verifyVisa: the v3 branch", () => {
  it("refuses a v3 whose cnf binds the ROOT key: only the worker may prove", async () => {
    expect(await verifyVisa(await forge({ ...body, ver: 3, cnf: { jkt: jwkThumbprint(ROOT) }, act, dc: DC }))).toBeNull();
  });
  it("refuses a v3 without act, or without dc", async () => {
    expect(await verifyVisa(await forge({ ...body, ver: 3, cnf: { jkt: jwkThumbprint(WORKER) }, dc: DC }))).toBeNull();
    expect(await verifyVisa(await forge({ ...body, ver: 3, cnf: { jkt: jwkThumbprint(WORKER) }, act }))).toBeNull();
  });
  it.each([
    ["a bad worker key", { act: { ...act, sub: "nope" } }],
    ["a depth that disagrees with dc", { act: { ...act, dep: 2 } }],
    ["a leaf that is not dc's last link", { act: { ...act, dlg: "jti-9999999999999999" } }],
    ["a non-integer cap", { dc: [{ ...DC[0]!, cap: 1.5 }] }],
  ])("refuses a v3 with %s", async (_l, over) => {
    expect(await verifyVisa(await forge({ ...body, ver: 3, cnf: { jkt: jwkThumbprint(WORKER) }, act, dc: DC, ...over }))).toBeNull();
  });
  it("loosens nothing for v2: a mismatched cnf is still refused, act or not", async () => {
    expect(await verifyVisa(await forge({ ...body, ver: 2, cnf: { jkt: jwkThumbprint(WORKER) } }))).toBeNull();
    expect(await verifyVisa(await forge({ ...body, ver: 2, cnf: { jkt: jwkThumbprint(WORKER) }, act, dc: DC }))).toBeNull();
  });
  it("refuses act or dc on a v1 or v2 visa, even with a correct cnf", async () => {
    expect(await verifyVisa(await forge({ ...body, ver: 2, cnf: { jkt: jwkThumbprint(ROOT) }, act }))).toBeNull();
    expect(await verifyVisa(await forge({ ...body, ver: 2, cnf: { jkt: jwkThumbprint(ROOT) }, dc: DC }))).toBeNull();
    expect(await verifyVisa(await forge({ ...body, ver: 1, act }))).toBeNull();
  });
  it("an ordinary visa still verifies, with no act", async () => {
    const claims = await verifyVisa((await mintVisa(base)).token);
    expect(claims?.ver).toBe(2);
    expect(claims?.act).toBeUndefined();
  });
});
