// B3 identity review. Storage/network boundaries only; real visa, passport,
// Ed25519, nonce and gateway authentication. Harnesses follow B2, passport-rotation
// and client-events-route. Preconditions run OUTSIDE expected-failure bodies.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { SignJWT } from "jose";
import { base64urlToBytes, bytesToBase64url, utf8ToBytes } from "@/lib/encoding";

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[], nonce: new Map<string, number>(),
  set: vi.fn(), rpc: vi.fn(), upsert: vi.fn(), errors: [] as string[],
  evidence: [] as (() => void)[],
}));
vi.mock("server-only", () => ({}));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@upstash/redis", () => ({ Redis: { fromEnv: () => ({ set: (...a: unknown[]) => h.set(...a) }) } }));
vi.mock("@/lib/state/redis", async (original) => ({
  ...await original<typeof import("@/lib/state/redis")>(),
  touchLastSeen: async () => undefined, isSuspended: async () => false,
}));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: async () => ({ success: true }), rateLimitFailClosed: async () => ({ success: true }),
}));
vi.mock("@/lib/observability", () => ({
  captureError: async (e: Error) => { h.errors.push(e.message); },
  captureSecurityEvent: async () => undefined, logFailOpen: vi.fn(),
}));
vi.mock("@/lib/state/killswitch", async (original) => ({
  ...await original<typeof import("@/lib/state/killswitch")>(),
  readKillState: async () => ({ platformKill: false, userKill: false, denylist: [] }),
}));
vi.mock("@/lib/mission/store", async (original) => ({
  ...await original<typeof import("@/lib/mission/store")>(),
  readActiveMissionForAgent: async () => ({ kind: "none" }),
}));
vi.mock("@/lib/passport-source-observation", () => ({
  passportSourceFingerprint: async () => "local-fingerprint", observePassportSource: async () => null,
}));
vi.mock("@/lib/owner/current", () => ({ readCurrentOwner: async () => null }));
vi.mock("@/lib/state/policy", () => ({ readCurrentAgentPolicyAndShadow: async () => ({ policy: null, missionOnly: false }) }));
vi.mock("@/lib/state/holds", () => ({ createDelegationLedger: async () => undefined }));
vi.mock("@/lib/delegation/store", async (original) => ({
  ...await original<typeof import("@/lib/delegation/store")>(),
  readDelegationRecord: async () => ({ watermarkSeconds: null, revoked: [] }),
  recordFirstExchanges: async (_db: unknown, rows: { jti: string }[]) => rows.map(r => r.jti),
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({
  rpc: (...a: unknown[]) => h.rpc(...a),
  from: (table: string) => {
    const filters: [string, unknown][] = [];
    const q = {
      select: () => q, order: () => q, limit: () => q, is: () => q, gt: () => q,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return q; },
      in: async () => ({ data: [], error: null }),
      upsert: (...a: unknown[]) => h.upsert(...a),
      maybeSingle: async () => ({
        data: table === "agents" ? h.rows.find(r => filters.every(([c, v]) => r[c] === v)) ?? null : null,
        error: null,
      }),
    };
    return q;
  },
}) }));

import { mintDelegatedVisa, mintVisa, verifyVisa, visaIdentity } from "@/lib/auth/visa";
import { jwkThumbprint, passportIdToPublicKey, verifySignature } from "@/lib/crypto/ed25519";
import { POST as delegatedExchange } from "@/app/api/auth/delegated/route";
import { POST as agentToken } from "@/app/api/auth/agent-token/route";
import { AGENT_TOKEN_TYP, verifyCompactJws } from "@/lib/crypto/jws";
import { loadInstanceSigner } from "@/lib/crypto/instanceKey";
import { createDelegationLink } from "../cli/delegation.mjs";
import { POST as challenge } from "@/app/api/auth/challenge/route";
import { POST as clientEvents } from "@/app/api/v1/client-events/route";
import { authenticateApiKey } from "@/lib/control/auth";
import { directAgentKeyHash, generateDirectAgentKey } from "@/lib/auth/direct-key";
import { claimNonce } from "@/lib/state/redis";
import { validateAgentInput } from "@/lib/validate";

const SECRET = "b3-local-only-secret-" + "x".repeat(32);
const SEED = new Uint8Array(32).fill(13);
const PASSPORT = bytesToBase64url(ed25519.getPublicKey(SEED));
const AGENT = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const SCOPE = [{ provider: "openai", models: ["gpt-4o-mini"] }];
const base = { passportId: PASSPORT, agentId: AGENT, userId: TENANT, jti: "b3-visa", scope: SCOPE,
  budgetTokens: null, budgetCents: null, spentTokens: 0, spentMicrocents: 0 };
const row = (passport = PASSPORT) => ({ id: AGENT, user_id: TENANT, status: "active",
  passport_pubkey: passport, previous_passport_pubkey: null, expires_at: null,
  allowed_scopes: SCOPE, budget_tokens: null, budget_cents: null, spent_tokens: 0, spent_microcents: 0 });
const claims = () => ({ sub: PASSPORT, agid: AGENT, uid: TENANT, jti: "b3-forged", scope: SCOPE,
  bt: null, bc: null, st: 0, sc: 0, ver: 2, cnf: { jkt: jwkThumbprint(PASSPORT) },
  iss: visaIdentity().issuer, aud: visaIdentity().audience, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300 });
const forge = (over: Record<string, unknown> = {}, alg = "HS256") =>
  new SignJWT({ ...claims(), ...over }).setProtectedHeader({ alg }).sign(utf8ToBytes(SECRET));
function proof(over: Record<string, unknown> = {}) {
  const bytes = utf8ToBytes(JSON.stringify({ passport_id: PASSPORT, ts: Date.now(), nonce: crypto.randomUUID(), purpose: "challenge", ...over }));
  return { payload: bytesToBase64url(bytes), signature: bytesToBase64url(ed25519.sign(bytes, SEED)) };
}
function post(body: unknown, path = "/api/auth/challenge", headers: Record<string, string> = {}) {
  return new Request(`https://b3.test${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

beforeEach(async () => {
  vi.stubEnv("VISA_SECRET", SECRET); vi.stubEnv("VISA_SECRET_PREV", "");
  vi.stubEnv("VISA_TTL_SECONDS", "300"); vi.stubEnv("PASSCONTROL_ISSUER", "https://instance-a.test");
  h.rows = [row()]; h.nonce.clear(); h.errors = []; h.evidence = [];
  h.set.mockReset().mockImplementation(async (key: string, _value: unknown, opts: { nx?: boolean; ex?: number }) => {
    // Model only the Redis SET contract; the real claimNonce supplies NX + expiry.
    if (opts.nx && (h.nonce.get(key) ?? 0) > Date.now()) return null;
    h.nonce.set(key, Date.now() + (opts.ex ?? 1) * 1000); return "OK";
  });
  h.rpc.mockReset().mockResolvedValue({ data: null, error: null });
  h.upsert.mockReset().mockResolvedValue({ error: null });
  // A broken signer/verifier or route fixture must fail the hook, not satisfy it.fails.
  const token = (await mintVisa(base)).token;
  expect(await verifyVisa(token)).toMatchObject({ agid: AGENT, uid: TENANT, scope: SCOPE });
  const res = await challenge(post(proof()));
  expect(res.status).toBe(200);
  expect(await verifyVisa((await res.json()).visa)).toMatchObject({ sub: PASSPORT, agid: AGENT });
  expect(validateAgentInput({ name: "B3 fixture", passportPubkey: PASSPORT, scopes: SCOPE }).passportPubkey).toBe(PASSPORT);
  h.nonce.clear(); h.set.mockClear();
});
afterEach(() => {
  expect(h.errors).toEqual([]);
  for (const check of h.evidence) check();
  vi.unstubAllEnvs();
});

it("B3-01 a visa without exp must be refused", async () => {
  expect(await verifyVisa(await forge({ exp: undefined }))).toBeNull();
});

it("B3-02 every relied-on identity and scope claim must be well formed", async () => {
  const delegated = { ver: 3, act: { sub: PASSPORT, dlg: "d".repeat(16), dep: 1, ch: "!".repeat(43) },
    dc: [{ dlg: "d".repeat(16), cap: 1, iat: 0, exp: 1 }] };
  const invalid = [ { uid: [TENANT] }, { agid: { agent: AGENT } }, { jti: 7 },
    { scope: [null] }, { scope: [{ provider: "openai", models: "*" }] },
    { scope: [{ provider: 7, models: [false] }] }, { st: -1 }, { bc: -1 }, delegated ];
  const results = await Promise.all(invalid.map(async over => (await verifyVisa(await forge(over))) === null));
  expect(results).toEqual(invalid.map(() => true));
});

it("B3-03 a visa from another instance must be refused even with a shared signing secret", async () => {
  const token = (await mintVisa(base)).token;
  vi.stubEnv("PASSCONTROL_ISSUER", "https://instance-b.test");
  expect(await verifyVisa(token)).toBeNull();
});

// An identity point and R=identity, S=0 do not require ANY private key.
const IDENTITY = new Uint8Array(32); IDENTITY[0] = 1;
const WEAK_ID = bytesToBase64url(IDENTITY);
const UNIVERSAL_SIGNATURE = new Uint8Array(64); UNIVERSAL_SIGNATURE[0] = 1;
it("B3-04 a small-order passport must not mint a visa without a private key", async () => {
  let registrationAccepted = false;
  try { validateAgentInput({ name: "B3 weak key", passportPubkey: WEAK_ID, scopes: SCOPE }); registrationAccepted = true; } catch { /* correct refusal */ }
  h.rows = [row(WEAK_ID)];
  const payload = bytesToBase64url(utf8ToBytes(JSON.stringify({ passport_id: WEAK_ID, ts: Date.now(), nonce: crypto.randomUUID(), purpose: "challenge" })));
  const res = await challenge(post({ payload, signature: bytesToBase64url(UNIVERSAL_SIGNATURE) }));
  h.evidence.push(() => expect(res.status).not.toBeGreaterThanOrEqual(500));
  expect({ registrationAccepted, refused: [400, 401, 403].includes(res.status) }).toEqual({ registrationAccepted: false, refused: true });
});

it("B3-05 noncanonical signature encoding must be refused", async () => {
  const signed = proof(); signed.signature += "==";
  const res = await challenge(post(signed));
  h.evidence.push(() => expect(res.status).not.toBeGreaterThanOrEqual(500));
  expect([400, 401]).toContain(res.status);
});

it("B3-05b noncanonical passport key encoding must be refused", () => {
  expect(passportIdToPublicKey(PASSPORT + "=")).toBeNull();
});

it.fails("B3-06 a legacy proof without purpose must not mint a challenge visa", async () => {
  const res = await challenge(post(proof({ purpose: undefined })));
  h.evidence.push(() => expect(res.status).not.toBeGreaterThanOrEqual(500));
  expect([400, 401]).toContain(res.status);
});

it("B3 verified visa cryptographic and time refusals", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const over of [{ exp: now - 1 }, { exp: "later" }, { nbf: now + 1 }, { iss: "foreign" }, { aud: "foreign" }, { ver: 99 }]) {
    expect(await verifyVisa(await forge(over))).toBeNull();
  }
  expect(await verifyVisa(await forge({}, "HS384"))).toBeNull();
  vi.stubEnv("VISA_SECRET", "independent-instance-secret-" + "y".repeat(32));
  expect(await verifyVisa(await forge())).toBeNull();
});

it("B3 verified nonce NX expiry and challenge replay, skew and signed agent binding", async () => {
  expect(await claimNonce("isolated", 180)).toBe(true);
  expect(await claimNonce("isolated", 180)).toBe(false);
  expect(h.set).toHaveBeenCalledWith("nonce:isolated", 1, { nx: true, ex: 180 });
  const signed = proof();
  expect((await challenge(post(signed))).status).toBe(200);
  expect(await (await challenge(post(signed))).json()).toMatchObject({ error: "replay_detected" });
  expect(await (await challenge(post(proof({ ts: Date.now() - 90_001 })))).json()).toMatchObject({ error: "stale_timestamp" });
  expect(await (await challenge(post(proof({ ts: Date.now() + 91_000 })))).json()).toMatchObject({ error: "stale_timestamp" });
  const other = bytesToBase64url(ed25519.getPublicKey(new Uint8Array(32).fill(14)));
  h.rows.push({ ...row(other), id: "other-agent" });
  expect(await (await challenge(post(proof({ passport_id: other })))).json()).toMatchObject({ error: "bad_signature" });
  expect(passportIdToPublicKey(bytesToBase64url(new Uint8Array(31)))).toBeNull();
  expect(verifySignature(new Uint8Array(63), utf8ToBytes("test"), ed25519.getPublicKey(SEED))).toBe(false);
});

it("B3 verified control auth ignores direct keys in alternate carriers and refuses delegated visas", async () => {
  const key = generateDirectAgentKey();
  const now = Math.floor(Date.now() / 1000);
  const delegated = await forge({ ver: 3, act: { sub: PASSPORT, dlg: "d".repeat(16), dep: 1, ch: "c".repeat(43) },
    dc: [{ dlg: "d".repeat(16), cap: 1, iat: now, exp: now + 300 }] });
  expect(await verifyVisa(delegated)).toMatchObject({ ver: 3, act: { sub: PASSPORT } });
  const requests = [new Request("https://b3.test/api/control/v1/agents", { headers: { "x-api-key": key } }),
    new Request(`https://b3.test/api/control/v1/agents?api_key=${key}`),
    new Request("https://b3.test/api/control/v1/agents", { headers: { cookie: `api_key=${key}` } }),
    new Request("https://b3.test/api/control/v1/agents", { headers: { authorization: `Bearer ${delegated}` } })];
  for (const req of requests) expect(await authenticateApiKey(req)).toMatchObject({ ok: false, status: 401 });
  expect(h.rpc).not.toHaveBeenCalled();
});


it("B3 compatibility: CLI key generation registers, signs and mints through challenge", async () => {
  // Same real primitive as bin/passcontrol.mjs and cli/login.mjs.
  const seed = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(seed);
  const passport = bytesToBase64url(publicKey);
  expect(ed25519.Point.fromHex(publicKey).isSmallOrder()).toBe(false);
  expect(passportIdToPublicKey(passport)).toEqual(publicKey);
  expect(validateAgentInput({ name: "CLI passport", passportPubkey: passport, scopes: SCOPE }).passportPubkey).toBe(passport);
  h.rows = [row(passport)];
  const payload = utf8ToBytes(JSON.stringify({ passport_id: passport, ts: Date.now(), nonce: crypto.randomUUID(), purpose: "challenge" }));
  const signature = ed25519.sign(payload, seed);
  expect(verifySignature(signature, payload, publicKey)).toBe(true);
  const res = await challenge(post({ payload: bytesToBase64url(payload), signature: bytesToBase64url(signature) }));
  expect(res.status).toBe(200);
  expect(await verifyVisa((await res.json()).visa)).toMatchObject({ sub: passport });
});

it("B3 compatibility: normal and mission and delegated mint layouts verify", async () => {
  const now = Math.floor(Date.now() / 1000);
  for (const token of [
    (await mintVisa(base)).token,
    (await mintVisa({ ...base, mission: { id: AGENT, hash: "a".repeat(64) } })).token,
    (await mintDelegatedVisa({ ...base, actor: PASSPORT, delegationJti: "d".repeat(16), depth: 1,
      chainHash: bytesToBase64url(new Uint8Array(32)),
      links: [{ dlg: "d".repeat(16), cap: 100, iat: now, exp: now + 300 }] })).token,
  ]) expect(await verifyVisa(token)).toMatchObject({ agid: AGENT, uid: TENANT });
});

it("B3 canonical encodings round trip and aliases are refused", async () => {
  const { canonicalBase64urlToBytes } = await import("@/lib/encoding");
  for (const value of [new Uint8Array(), new Uint8Array([255]), new Uint8Array([255, 255]),
    ed25519.getPublicKey(SEED), ed25519.sign(utf8ToBytes("test"), SEED)]) {
    const encoded = bytesToBase64url(value);
    expect(canonicalBase64urlToBytes(encoded)).toEqual(value);
  }
  for (const alias of [PASSPORT + "=", " " + PASSPORT, PASSPORT + "\n", "/w", "_x"]) {
    expect(() => canonicalBase64urlToBytes(alias)).toThrow();
  }
  const signed = proof();
  for (const signature of [signed.signature + " ", signed.signature + "\n", signed.signature + "!"]) {
    expect([400, 401]).toContain((await challenge(post({ ...signed, signature }))).status);
  }
  expect(base64urlToBytes(PASSPORT)).toEqual(ed25519.getPublicKey(SEED));
});

it("B3 rejects small-order raw keys even if already stored", () => {
  for (const key of [IDENTITY, new Uint8Array(32)]) {
    expect(passportIdToPublicKey(bytesToBase64url(key))).toBeNull();
    expect(verifySignature(UNIVERSAL_SIGNATURE, utf8ToBytes("any"), key)).toBe(false);
  }
});

it("B3 malformed claims each refuse independently without throwing", async () => {
  const now = Math.floor(Date.now() / 1000);
  const act = { sub: PASSPORT, dlg: "d".repeat(16), dep: 1, ch: "c".repeat(43) };
  const dc = [{ dlg: act.dlg, cap: 1, iat: now, exp: now + 300 }];
  for (const over of [
    { uid: "" }, { uid: "white space" }, { agid: "" }, { jti: "" }, { jti: {} },
    { scope: [null] }, { scope: [{ provider: "openai", models: [false] }] },
    { st: -1 }, { sc: -1 }, { bt: -1 }, { bc: -1 }, { bt: "1" }, { st: null },
    { ver: 3, act: { ...act, ch: "!".repeat(43) }, dc },
    { ver: 3, act, dc: [{ ...dc[0], exp: now - 1 }] },
    { ver: 3, act, dc: [{ ...dc[0], iat: now + 301 }] },
  ]) expect(await verifyVisa(await forge(over))).toBeNull();
});


it("B3 compatibility: delegated route mints a verifiable visa from a real client chain", async () => {
  const worker = ed25519.utils.randomPrivateKey();
  const workerId = bytesToBase64url(ed25519.getPublicKey(worker));
  const chain = [createDelegationLink({ signerPrivateKey: bytesToBase64url(SEED),
    audience: "https://instance-a.test", workerPublicKey: workerId, scope: SCOPE,
    capMicrocents: 100, ttlSeconds: 600 })];
  const payload = utf8ToBytes(JSON.stringify({ passport_id: workerId, ts: Date.now(), nonce: crypto.randomUUID(), purpose: "delegated" }));
  const res = await delegatedExchange(post({ chain, payload: bytesToBase64url(payload), signature: bytesToBase64url(ed25519.sign(payload, worker)) }, "/api/auth/delegated"));
  expect(res.status).toBe(200);
  expect(await verifyVisa((await res.json()).visa)).toMatchObject({ sub: PASSPORT, ver: 3, act: { sub: workerId } });
});

it("B3 compatibility: agent-token route still signs a verifiable identity token", async () => {
  vi.stubEnv("INSTANCE_SIGNING_KEY", bytesToBase64url(new Uint8Array(32).fill(25)));
  const res = await agentToken(post(proof({ purpose: "agent-token", aud: "billing-service" }), "/api/auth/agent-token"));
  expect(res.status).toBe(200);
  const body = await res.json();
  // Agent tokens are EdDSA identity assertions, not work visas.
  expect(verifyCompactJws(body.token, loadInstanceSigner()!.publicKey, { typ: AGENT_TOKEN_TYP })?.claims)
    .toMatchObject({ sub: PASSPORT, iss: "https://instance-a.test", aud: "billing-service" });
});

it("B3 instance fallback is explicit and configured origins normalize identically", async () => {
  const same = (await mintVisa(base)).token;
  vi.stubEnv("PASSCONTROL_ISSUER", "https://instance-a.test/");
  expect(await verifyVisa(same)).not.toBeNull();
  vi.stubEnv("PASSCONTROL_ISSUER", "");
  expect(visaIdentity()).toEqual({ issuer: "passport.gateway", audience: "llm-proxy" });
  expect(await verifyVisa(same)).toBeNull();
  const fallback = (await mintVisa(base)).token;
  vi.stubEnv("PASSCONTROL_ISSUER", "invalid");
  expect(await verifyVisa(fallback)).not.toBeNull();
});


it("B3 non-small-order arbitrary 32-byte registration values are unaffected", () => {
  // This is deliberately an invalid RFC 8032 point encoding, as distinct from
  // a generated key. Existing attach callers accept opaque bytes at registration.
  const bytes = new Uint8Array(32).fill(255);
  expect(() => ed25519.Point.fromHex(bytes, false)).toThrow();
  expect(passportIdToPublicKey(bytesToBase64url(bytes))).toEqual(bytes);
  expect(verifySignature(UNIVERSAL_SIGNATURE, utf8ToBytes("test"), bytes)).toBe(false);
});
