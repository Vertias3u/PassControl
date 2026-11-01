import { beforeEach, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

const m = vi.hoisted(() => ({
  db: null as unknown,
  suspend: vi.fn(),
  purge: vi.fn(),
  claimNonce: vi.fn(),
  touchLastSeen: vi.fn(),
  rateLimit: vi.fn(),
  readRecord: vi.fn(),
  recordFirst: vi.fn(),
  createLedger: vi.fn(),
}));
vi.mock("@vercel/functions", () => ({ waitUntil: () => undefined }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => m.db }));
vi.mock("@/lib/state/redis", () => ({ claimNonce: (...a: unknown[]) => m.claimNonce(...a), touchLastSeen: (...a: unknown[]) => m.touchLastSeen(...a), suspendAgent: (...a: unknown[]) => m.suspend(...a), purgeAgentCaches: (...a: unknown[]) => m.purge(...a) }));
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
import { DELEGATION_TYP } from "@/lib/delegation/chain";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const enc = (v: unknown) => b64(new TextEncoder().encode(JSON.stringify(v)));
const key = (seed: number) => {
  const priv = new Uint8Array(32).fill(seed);
  return { priv, id: b64(ed25519.getPublicKey(priv)) };
};
const root = key(1);
const worker = key(2);
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
function challenge(priv: Uint8Array, passportId: string, over: Record<string, unknown> = {}) {
  const payload = enc({ passport_id: passportId, ts: Date.now(), nonce: crypto.randomUUID(), ...over });
  return { payload, signature: b64(ed25519.sign(Buffer.from(payload, "base64url"), priv)) };
}
const post = (body: unknown) =>
  POST(new Request("https://gw.example/api/auth/delegated", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const AGENT = { id: "agent-1", user_id: "user-1", status: "active", allowed_scopes: [{ provider: "anthropic", models: ["claude-*"] }], budget_tokens: null, budget_cents: null, spent_tokens: 0, spent_microcents: 0, expires_at: null };

beforeEach(() => {
  for (const f of [m.claimNonce, m.touchLastSeen, m.rateLimit, m.readRecord, m.recordFirst, m.createLedger, m.suspend, m.purge]) f.mockReset();
  process.env.VISA_SECRET = "test-secret-test-secret-test-secret-32";
  process.env.VISA_TTL_SECONDS = "300";
  process.env.PASSCONTROL_ISSUER = AUD;

  m.claimNonce.mockResolvedValue(true);
  m.touchLastSeen.mockResolvedValue(undefined);
  m.rateLimit.mockResolvedValue({ success: true, remaining: 1 });
  m.readRecord.mockResolvedValue({ watermarkSeconds: null, revoked: [] });
  m.recordFirst.mockImplementation(async (_db: unknown, rows: { jti: string }[]) => rows.map((r) => r.jti));
  m.createLedger.mockResolvedValue(undefined);
});

import { revokeAgent } from "@/lib/fleet";
import { authenticateDirectAgentKey, generateDirectAgentKey } from "@/lib/auth/direct-key";

// One mutable agent row is shared by the real revoke mutation, direct-key
// verifier and delegation exchange. The fake applies the real query predicates.
function database() {
  const row: Record<string, unknown> = { ...AGENT, passport_pubkey: root.id, previous_passport_pubkey: null };
  const from = (table: string) => {
    const filters: [string, unknown][] = [];
    let update: Record<string, unknown> | undefined;
    const result = () => {
      if (table !== "agents") throw new Error(`Unexpected table ${table}`);
      if (!filters.every(([key, value]) => row[key] === value)) return { data: null, error: null };
      if (update) Object.assign(row, update);
      return { data: { ...row }, error: null };
    };
    const q = {
      select: () => q,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return q; },
      update: (value: Record<string, unknown>) => { update = value; return q; },
      maybeSingle: async () => result(),
    };
    return q;
  };
  // Deliberately return revoked rows too: the TS verifier must refuse even
  // if an older RPC returns one. This does not replace a live SQL RPC check.
  const rpc = vi.fn(async () => ({ data: [{ key_id: "key-1", agent_id: row.id, user_id: row.user_id, agent_status: row.status, allowed_scopes: row.allowed_scopes, budget_tokens: null, budget_cents: null }], error: null }));
  return { from, rpc };
}
it("refuses the agent's existing Direct Agent Key after revoke", async () => {
  const db = database();
  const key = generateDirectAgentKey();
  expect(await authenticateDirectAgentKey(db as never, key)).toMatchObject({ agentId: AGENT.id });
  expect(await revokeAgent(db as never, AGENT.user_id, AGENT.id)).toEqual({ ok: true, value: { id: AGENT.id } });
  expect(m.suspend).toHaveBeenCalledWith(AGENT.id);
  expect(m.purge).toHaveBeenCalledWith(AGENT.id, expect.any(Array));
  expect(await authenticateDirectAgentKey(db as never, key)).toBeNull();
});
it("refuses an existing signed delegation after revoking its root agent", async () => {
  const db = database();
  m.db = db;
  const chain = [link1()];
  expect((await post({ ...challenge(worker.priv, worker.id), chain })).status).toBe(200);
  expect((await revokeAgent(db as never, AGENT.user_id, AGENT.id)).ok).toBe(true);
  m.recordFirst.mockClear();
  const refused = await post({ ...challenge(worker.priv, worker.id), chain });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({ error: "agent_not_active" });
  expect(m.recordFirst).not.toHaveBeenCalled();
});
