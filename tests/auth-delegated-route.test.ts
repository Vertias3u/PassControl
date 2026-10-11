// Bet D slice 6 (plans/delegation-design.md §5, §13): POST /api/auth/delegated, where a
// worker exchanges its chain plus a challenge signed by ITS OWN key for a visa. The
// token alone does nothing; the visa only ever narrows; revocation fails closed; and a
// link's spend ledger is created only by the exchange whose first-exchange row it made.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

const m = vi.hoisted(() => ({
  find: vi.fn(),
  claimNonce: vi.fn(),
  touchLastSeen: vi.fn(),
  rateLimit: vi.fn(),
  readRecord: vi.fn(),
  recordFirst: vi.fn(),
  createLedger: vi.fn(),
}));
vi.mock("@vercel/functions", () => ({ waitUntil: () => undefined }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/lib/auth/passport", () => ({ findAuthenticatablePassport: (...a: unknown[]) => m.find(...a) }));
vi.mock("@/lib/state/redis", () => ({ claimNonce: (...a: unknown[]) => m.claimNonce(...a), touchLastSeen: (...a: unknown[]) => m.touchLastSeen(...a) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...a: unknown[]) => m.rateLimit(...a) }));
vi.mock("@/lib/observability", () => ({ captureError: async () => {}, captureSecurityEvent: async () => {}, logFailOpen: () => {} }));
vi.mock("@/lib/passport-source-observation", () => ({ passportSourceFingerprint: async () => "fp" }));
vi.mock("@/lib/crypto/derived-auth-hmac", () => ({ AUTH_HMAC_LABELS: { challengeRateLimit: "x" }, authHmacKey: async () => ({}) }));
vi.mock("@/lib/state/holds", () => ({ createDelegationLedger: (...a: unknown[]) => m.createLedger(...a) }));
vi.mock("@/lib/delegation/store", async (orig) => ({
  ...(await orig<typeof import("@/lib/delegation/store")>()),
  readDelegationRecord: (...a: unknown[]) => m.readRecord(...a),
  recordFirstExchanges: (...a: unknown[]) => m.recordFirst(...a),
}));

import { POST } from "@/app/api/auth/delegated/route";
import { verifyVisa } from "@/lib/auth/visa";
import { DELEGATION_TYP } from "@/lib/delegation/chain";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const enc = (v: unknown) => b64(new TextEncoder().encode(JSON.stringify(v)));
const key = (seed: number) => {
  const priv = new Uint8Array(32).fill(seed);
  return { priv, id: b64(ed25519.getPublicKey(priv)) };
};
const root = key(1);
const worker = key(2);
const sub2 = key(3);
const AUD = "https://gw.example";
const now = () => Math.floor(Date.now() / 1000);
function sign(priv: Uint8Array, payload: Record<string, unknown>) {
  const input = `${enc({ alg: "EdDSA", typ: DELEGATION_TYP })}.${enc(payload)}`;
  return `${input}.${b64(ed25519.sign(new TextEncoder().encode(input), priv))}`;
}
const link1 = (over: Record<string, unknown> = {}) =>
  sign(root.priv, {
    iss: root.id, sub: worker.id, aud: AUD, jti: "jti-0000000000000001", iat: now() - 10, exp: now() + 3600,
    dep: 1, max: 2, scope: [{ provider: "anthropic", models: ["claude-haiku-4-5"] }], cap: 5_000_000, ...over,
  });
const link2 = (first: string) =>
  sign(worker.priv, {
    iss: worker.id, sub: sub2.id, aud: AUD, jti: "jti-0000000000000002", iat: now() - 5, exp: now() + 1800,
    dep: 2, max: 2, ph: b64(sha256(new TextEncoder().encode(first))), scope: [{ provider: "anthropic", models: ["claude-haiku-4-5"] }], cap: 1_000_000,
  });
function challenge(priv: Uint8Array, passportId: string, over: Record<string, unknown> = {}) {
  const payload = enc({ passport_id: passportId, ts: Date.now(), nonce: crypto.randomUUID(), ...over });
  return { payload, signature: b64(ed25519.sign(Buffer.from(payload, "base64url"), priv)) };
}
const post = (body: unknown) =>
  POST(new Request("https://gw.example/api/auth/delegated", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const AGENT = { id: "agent-1", user_id: "user-1", status: "active", allowed_scopes: [{ provider: "anthropic", models: ["claude-*"] }], budget_tokens: null, budget_cents: null, spent_tokens: 0, spent_microcents: 0, expires_at: null };

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  process.env.VISA_SECRET = "test-secret-test-secret-test-secret-32";
  process.env.VISA_TTL_SECONDS = "300";
  process.env.PASSCONTROL_ISSUER = AUD;
  m.find.mockResolvedValue({ ok: true, agent: AGENT });
  m.claimNonce.mockResolvedValue(true);
  m.touchLastSeen.mockResolvedValue(undefined);
  m.rateLimit.mockResolvedValue({ success: true, remaining: 1 });
  m.readRecord.mockResolvedValue({ watermarkSeconds: null, revoked: [] });
  m.recordFirst.mockImplementation(async (_db: unknown, rows: { jti: string }[]) => rows.map((r) => r.jti));
  m.createLedger.mockResolvedValue(undefined);
});

describe("POST /api/auth/delegated: the exchange", () => {
  it("mints a worker's visa: the root passport as sub, the worker in act, only the leaf's scope", async () => {
    const res = await post({ ...challenge(worker.priv, worker.id), chain: [link1()] });
    expect(res.status).toBe(200);
    const body = await res.json();
    const claims = await verifyVisa(body.visa);
    expect(claims).toMatchObject({ sub: root.id, agid: "agent-1", uid: "user-1", ver: 3, act: { sub: worker.id, dlg: "jti-0000000000000001", dep: 1 } });
    // Capability grants are never applied: the scope is the leaf's, nothing wider.
    expect(claims!.scope).toEqual([{ provider: "anthropic", models: ["claude-haiku-4-5"] }]);
    expect(body.delegation).toMatchObject({ jti: "jti-0000000000000001", cap_microcents: 5_000_000 });
    expect(m.find).toHaveBeenCalledWith(expect.anything(), root.id, expect.any(String));
  });

  it("records each link once and creates a ledger only for the rows it created", async () => {
    const l1 = link1();
    m.recordFirst.mockResolvedValueOnce(["jti-0000000000000002"]);
    const res = await post({ ...challenge(sub2.priv, sub2.id), chain: [l1, link2(l1)] });
    expect(res.status).toBe(200);
    const rows = m.recordFirst.mock.calls[0]![1];
    expect(rows.map((r: { jti: string; depth: number; parentJti: string | null }) => [r.jti, r.depth, r.parentJti])).toEqual([
      ["jti-0000000000000001", 1, null],
      ["jti-0000000000000002", 2, "jti-0000000000000001"],
    ]);
    expect(m.createLedger).toHaveBeenCalledTimes(1);
    expect(m.createLedger).toHaveBeenCalledWith("agent-1", "jti-0000000000000002", expect.any(Number));
  });

  it("the token alone does nothing: a challenge signed by any key but the leaf's is refused", async () => {
    // Signed by the ROOT, naming the worker.
    const forged = challenge(root.priv, worker.id);
    expect((await post({ ...forged, chain: [link1()] })).status).toBe(401);
    // Signed by a stranger, naming itself.
    const stranger = key(9);
    const res = await post({ ...challenge(stranger.priv, stranger.id), chain: [link1()] });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_delegation" });
    expect(m.recordFirst).not.toHaveBeenCalled();
  });

  it("burns the nonce and checks the clock, as the challenge does", async () => {
    m.claimNonce.mockResolvedValueOnce(false);
    expect(await (await post({ ...challenge(worker.priv, worker.id), chain: [link1()] })).json()).toEqual({ error: "replay_detected" });
    const stale = challenge(worker.priv, worker.id, { ts: Date.now() - 10 * 60_000 });
    expect((await post({ ...stale, chain: [link1()] })).status).toBe(401);
  });

  it("refuses a parent the passport lookup refuses (suspended, revoked, expired)", async () => {
    m.find.mockResolvedValue({ ok: false, status: 403, code: "agent_not_active", agentId: "agent-1" });
    const res = await post({ ...challenge(worker.priv, worker.id), chain: [link1()] });
    expect(res.status).toBe(403);
    expect(m.recordFirst).not.toHaveBeenCalled();
  });

  it("refuses a chain wider than the agent's CURRENT scope, with one code", async () => {
    m.find.mockResolvedValue({ ok: true, agent: { ...AGENT, allowed_scopes: [{ provider: "openai", models: ["gpt-*"] }] } });
    const res = await post({ ...challenge(worker.priv, worker.id), chain: [link1()] });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_delegation" });
  });

  it("refuses a revoked link, and fails CLOSED when the record cannot be read", async () => {
    m.readRecord.mockResolvedValueOnce({ watermarkSeconds: null, revoked: ["jti-0000000000000001"] });
    const revoked = await post({ ...challenge(worker.priv, worker.id), chain: [link1()] });
    expect(revoked.status).toBe(403);
    expect(await revoked.json()).toEqual({ error: "delegation_revoked" });
    m.readRecord.mockResolvedValueOnce({ watermarkSeconds: now(), revoked: [] });
    expect((await post({ ...challenge(worker.priv, worker.id), chain: [link1()] })).status).toBe(403);
    m.readRecord.mockRejectedValueOnce(new Error("db down"));
    const down = await post({ ...challenge(worker.priv, worker.id), chain: [link1()] });
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: "delegation_state_unavailable" });
    expect(m.recordFirst).not.toHaveBeenCalled();
  });

  it("mints nothing when the first-exchange record or the ledger cannot be written", async () => {
    m.recordFirst.mockRejectedValueOnce(new Error("x"));
    expect((await post({ ...challenge(worker.priv, worker.id), chain: [link1()] })).status).toBe(503);
    m.createLedger.mockRejectedValueOnce(new Error("x"));
    expect((await post({ ...challenge(worker.priv, worker.id), chain: [link1()] })).status).toBe(503);
  });

  it("is unavailable on an instance with no issuer: a chain's audience cannot be checked", async () => {
    delete process.env.PASSCONTROL_ISSUER;
    const res = await post({ ...challenge(worker.priv, worker.id), chain: [link1()] });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "delegation_unavailable" });
  });

  it("bounds input before any lookup", async () => {
    const big = await POST(new Request("https://gw.example/api/auth/delegated", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(40_000) }));
    expect(big.status).toBe(413);
    const three = await post({ ...challenge(worker.priv, worker.id), chain: ["a.b.c", "a.b.c", "a.b.c"] });
    expect(three.status).toBe(400);
    expect(m.find).not.toHaveBeenCalled();
  });
});
