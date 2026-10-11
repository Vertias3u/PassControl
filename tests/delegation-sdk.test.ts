// Bet D slice 7 (plans/delegation-design.md §8, §10): the SDK side. A parent signs a
// link for a worker's key (the parent never holds the worker's private key); a worker
// signs a link 2 under its own chain; a worker client exchanges at /api/auth/delegated;
// and anyone holding a worker's receipt plus the chain can check them offline. The
// offline checker is held to agree with the gateway's own rules on the same chains.
import { describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { createDelegationLink, checkDelegationChain, verifyReceiptDelegation, generateWorkerKey } from "@/cli/delegation.mjs";
import { verifyDelegationChain, delegationChainHash } from "@/lib/delegation/chain";
import { PassControl } from "@/sdk/passcontrol";
import * as sdk from "@/sdk/index";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const AUD = "https://gw.example";
const root = (() => {
  const priv = new Uint8Array(32).fill(4);
  return { priv: b64(priv), id: b64(ed25519.getPublicKey(priv)) };
})();
const SCOPE = [{ provider: "anthropic", models: ["claude-*"] }];
const NOW = Math.floor(Date.now() / 1000);
const gatewayCheck = (chain: string[]) =>
  verifyDelegationChain({ chain, root: { passportId: root.id, scope: SCOPE, expiresAtSeconds: null }, audience: AUD, nowSeconds: NOW });

describe("createDelegationLink", () => {
  it("signs a link 1 the gateway accepts", () => {
    const w = generateWorkerKey();
    const l1 = createDelegationLink({
      signerPrivateKey: root.priv,
      signerKeyId: root.id,
      audience: AUD,
      workerPublicKey: w.publicKey,
      scope: [{ provider: "anthropic", models: ["claude-haiku-4-5"] }],
      capMicrocents: 50_000_000,
      ttlSeconds: 3600,
    });
    expect(gatewayCheck([l1])).toMatchObject({ ok: true, leaf: { sub: w.publicKey, dep: 1, max: 2, cap: 50_000_000 } });
  });

  it("signs a link 2 under a worker's chain: ph set, expiry clamped to the parent's", () => {
    const w1 = generateWorkerKey();
    const w2 = generateWorkerKey();
    const l1 = createDelegationLink({ signerPrivateKey: root.priv, signerKeyId: root.id, audience: AUD, workerPublicKey: w1.publicKey, scope: SCOPE, capMicrocents: 1000, ttlSeconds: 600 });
    const l2 = createDelegationLink({ signerPrivateKey: w1.privateKey, signerKeyId: w1.publicKey, audience: AUD, workerPublicKey: w2.publicKey, scope: [{ provider: "anthropic", models: ["claude-haiku-4-5"] }], capMicrocents: 500, ttlSeconds: 86_400, parentChain: [l1] });
    const r = gatewayCheck([l1, l2]);
    expect(r).toMatchObject({ ok: true, leaf: { sub: w2.publicKey, dep: 2 } });
    if (r.ok) expect(r.leaf.exp).toBe(r.links[0]!.exp);
  });

  it("refuses up front what the gateway would refuse: a raised cap, depth 3, no further delegation", () => {
    const w1 = generateWorkerKey();
    const l1 = createDelegationLink({ signerPrivateKey: root.priv, signerKeyId: root.id, audience: AUD, workerPublicKey: w1.publicKey, scope: SCOPE, capMicrocents: 1000, ttlSeconds: 600 });
    const base = { signerPrivateKey: w1.privateKey, signerKeyId: w1.publicKey, audience: AUD, workerPublicKey: generateWorkerKey().publicKey, scope: SCOPE, ttlSeconds: 60 };
    expect(() => createDelegationLink({ ...base, capMicrocents: 1001, parentChain: [l1] })).toThrow(/cap/);
    const final = createDelegationLink({ signerPrivateKey: root.priv, signerKeyId: root.id, audience: AUD, workerPublicKey: w1.publicKey, scope: SCOPE, capMicrocents: 1000, ttlSeconds: 600, allowFurtherDelegation: false });
    expect(() => createDelegationLink({ ...base, capMicrocents: 1, parentChain: [final] })).toThrow(/further/);
    const l2 = createDelegationLink({ ...base, capMicrocents: 1, parentChain: [l1] });
    expect(() => createDelegationLink({ ...base, capMicrocents: 1, parentChain: [l1, l2] })).toThrow(/depth/);
  });
});

describe("checkDelegationChain agrees with the gateway", () => {
  const w1 = generateWorkerKey();
  const w2 = generateWorkerKey();
  const l1 = createDelegationLink({ signerPrivateKey: root.priv, signerKeyId: root.id, audience: AUD, workerPublicKey: w1.publicKey, scope: SCOPE, capMicrocents: 1000, ttlSeconds: 600 });
  const l2 = createDelegationLink({ signerPrivateKey: w1.privateKey, signerKeyId: w1.publicKey, audience: AUD, workerPublicKey: w2.publicKey, scope: SCOPE, capMicrocents: 500, ttlSeconds: 300, parentChain: [l1] });
  const byRoot = createDelegationLink({ signerPrivateKey: root.priv, signerKeyId: w1.publicKey, audience: AUD, workerPublicKey: w2.publicKey, scope: SCOPE, capMicrocents: 500, ttlSeconds: 300, parentChain: [l1], unchecked: true });
  const other = createDelegationLink({ signerPrivateKey: root.priv, signerKeyId: root.id, audience: AUD, workerPublicKey: w1.publicKey, scope: SCOPE, capMicrocents: 1000, ttlSeconds: 600 });
  const [h, p, s] = l1.split(".");
  const tampered = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), cap: 9999 })).toString("base64url")}.${s}`;
  it.each([
    ["one link", [l1], true],
    ["two links", [l1, l2], true],
    ["link 2 signed by the root key", [l1, byRoot], false],
    ["a spliced link 2", [other, l2], false],
    ["a tampered link 1", [tampered], false],
    ["three links", [l1, l2, l2], false],
  ])("%s", (_l, chain, ok) => {
    expect(gatewayCheck(chain as string[]).ok).toBe(ok);
    expect(checkDelegationChain({ chain, rootPassportId: root.id, audience: AUD, nowSeconds: NOW }).ok).toBe(ok);
  });
  it("computes the same chain hash the gateway signs into receipts", () => {
    const r = checkDelegationChain({ chain: [l1, l2], rootPassportId: root.id, audience: AUD, nowSeconds: NOW });
    expect(r).toMatchObject({ ok: true, chainHash: delegationChainHash([l1, l2]), leaf: { sub: w2.publicKey } });
  });
});

describe("verifyReceiptDelegation", () => {
  const w1 = generateWorkerKey();
  const l1 = createDelegationLink({ signerPrivateKey: root.priv, signerKeyId: root.id, audience: AUD, workerPublicKey: w1.publicKey, scope: SCOPE, capMicrocents: 1000, ttlSeconds: 600 });
  const leafJti = JSON.parse(Buffer.from(l1.split(".")[1]!, "base64url").toString()).jti;
  const claims = { iss: AUD, sub: root.id, ver: 3, auth: { kind: "delegated", act: w1.publicKey, dlg: leafJti, dep: 1, ch: delegationChainHash([l1]) } };
  it("ties a worker's receipt to the chain that authorised it", () => {
    expect(verifyReceiptDelegation(claims, [l1], { nowSeconds: NOW })).toMatchObject({ ok: true });
  });
  it.each([
    ["another chain hash", { auth: { ...claims.auth, ch: "x".repeat(43) } }],
    ["another worker", { auth: { ...claims.auth, act: generateWorkerKey().publicKey } }],
    ["another root passport", { sub: generateWorkerKey().publicKey }],
    ["a passport receipt", { auth: undefined }],
  ])("refuses %s", (_l, over) => {
    expect(verifyReceiptDelegation({ ...claims, ...over }, [l1], { nowSeconds: NOW }).ok).toBe(false);
  });
  it("checks signatures even after the delegation expired: a receipt outlives its link", () => {
    expect(verifyReceiptDelegation(claims, [l1], { nowSeconds: NOW + 10 * 86_400 })).toMatchObject({ ok: true });
  });
});

describe("PassControl.fromDelegation and delegate()", () => {
  it("a worker client exchanges at /api/auth/delegated, signing with the WORKER's key", async () => {
    const w1 = generateWorkerKey();
    const l1 = createDelegationLink({ signerPrivateKey: root.priv, signerKeyId: root.id, audience: AUD, workerPublicKey: w1.publicKey, scope: SCOPE, capMicrocents: 1000, ttlSeconds: 600 });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/auth/delegated")) {
        const body = JSON.parse(String(init!.body));
        expect(body.chain).toEqual([l1]);
        const payload = Buffer.from(body.payload, "base64url");
        expect(JSON.parse(payload.toString()).passport_id).toBe(w1.publicKey);
        expect(ed25519.verify(Buffer.from(body.signature, "base64url"), payload, Buffer.from(w1.publicKey, "base64url"))).toBe(true);
        return new Response(JSON.stringify({ visa: "worker-visa", expires_in: 300 }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    const client = PassControl.fromDelegation({ gateway: AUD, chain: [l1], workerPrivateKey: w1.privateKey, fetch: fetchMock as never });
    await client.fetch(`${AUD}/api/v1/anthropic/v1/messages`, { method: "POST", body: "{}" });
    const sent = fetchMock.mock.calls.find((c) => String(c[0]).includes("/api/v1/"))!;
    expect(new Headers(sent[1]!.headers).get("authorization")).toBe("Bearer worker-visa");
    expect(fetchMock.mock.calls.some((c) => String(c[0]).endsWith("/api/auth/challenge"))).toBe(false);
  });

  it("delegate() from the agent signs link 1; from a worker, link 2 under its chain", () => {
    const agent = new PassControl({ gateway: AUD, passportId: root.id, passportSecret: root.priv });
    const w1 = generateWorkerKey();
    const l1 = agent.delegate({ workerPublicKey: w1.publicKey, scope: SCOPE, capMicrocents: 1000, ttlSeconds: 600 });
    expect(l1.chain).toHaveLength(1);
    const worker = PassControl.fromDelegation({ gateway: AUD, chain: l1.chain, workerPrivateKey: w1.privateKey });
    const w2 = generateWorkerKey();
    const l2 = worker.delegate({ workerPublicKey: w2.publicKey, scope: [{ provider: "anthropic", models: ["claude-haiku-4-5"] }], capMicrocents: 100, ttlSeconds: 60 });
    expect(l2.chain).toHaveLength(2);
    expect(gatewayCheck(l2.chain)).toMatchObject({ ok: true, leaf: { sub: w2.publicKey } });
  });

  it("delegate() takes the issuer as audience when the gateway is reached at another address", () => {
    const agent = new PassControl({ gateway: "http://localhost:3001", passportId: root.id, passportSecret: root.priv });
    const { chain } = agent.delegate({ workerPublicKey: generateWorkerKey().publicKey, scope: SCOPE, capMicrocents: 1, ttlSeconds: 60, audience: AUD });
    expect(gatewayCheck(chain)).toMatchObject({ ok: true });
    const defaulted = agent.delegate({ workerPublicKey: generateWorkerKey().publicKey, scope: SCOPE, capMicrocents: 1, ttlSeconds: 60 });
    expect(gatewayCheck(defaulted.chain)).toMatchObject({ ok: false, reason: "audience" });
  });

  it("is exported from the SDK entry point", () => {
    expect(typeof sdk.createDelegationLink).toBe("function");
    expect(typeof sdk.verifyReceiptDelegation).toBe("function");
    expect(typeof sdk.generateWorkerKey).toBe("function");
  });
});
