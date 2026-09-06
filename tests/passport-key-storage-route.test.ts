// Where the declared key-storage tier is allowed to be written.
//
// The declaration rides INSIDE the signed challenge payload, so it is
// attributable to whoever holds the passport key. That property is worth
// exactly as much as the point in the route where it is trusted: passport ids
// are public (`/verify/[passportId]`, the published fleet listing), so a write
// that happens before the signature is verified would let any stranger who
// knows an agent's passport id set what its operator's dashboard reports about
// key custody. The route already draws this line for `expires_at`, which
// `securityFail` withholds until the presented signature checks out.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";

import { bytesToBase64url, utf8ToBytes } from "@/lib/encoding";

const h = vi.hoisted(() => ({
  recordMock: vi.fn(),
  claimNonceMock: vi.fn(),
  rows: [] as Record<string, unknown>[],
}));

vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: async () => ({ success: true, remaining: 10 }) }));
vi.mock("@/lib/state/redis", () => ({
  claimNonce: (...a: unknown[]) => h.claimNonceMock(...a),
  redis: () => ({ fake: true }),
  touchLastSeen: vi.fn(),
}));
vi.mock("@/lib/passport-source-observation", () => ({
  observePassportSource: async () => null,
  passportSourceFingerprint: async (_scope: string, ip: string) => `hashed-${ip.length}`,
}));
vi.mock("@/lib/passport-key-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/passport-key-storage")>()),
  recordDeclaredKeyStorage: (...a: unknown[]) => h.recordMock(...a),
}));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      const applied: [string, unknown][] = [];
      const b = {
        select: () => b,
        eq: (column: string, value: unknown) => {
          applied.push([column, value]);
          return b;
        },
        maybeSingle: async () => ({
          data: h.rows.find((row) => applied.every(([c, v]) => row[c] === v)) ?? null,
          error: null,
        }),
      };
      return b;
    },
  }),
}));

import { POST as challenge } from "@/app/api/auth/challenge/route";

const SEED = ed25519.utils.randomPrivateKey();
const PASSPORT_ID = bytesToBase64url(ed25519.getPublicKey(SEED));
const OTHER_SEED = ed25519.utils.randomPrivateKey();
const AGENT_ID = "33333333-3333-3333-3333-333333333333";
const USER_ID = "44444444-4444-4444-4444-444444444444";

function agentRow(over: Record<string, unknown> = {}) {
  return {
    id: AGENT_ID,
    user_id: USER_ID,
    status: "active",
    allowed_scopes: [{ provider: "openai", models: ["*"] }],
    budget_tokens: null,
    budget_cents: null,
    spent_tokens: 0,
    spent_microcents: 0,
    passport_pubkey: PASSPORT_ID,
    previous_passport_pubkey: null,
    previous_valid_until: null,
    expires_at: null,
    ...over,
  };
}

function post(extra: Record<string, unknown>, seed: Uint8Array = SEED) {
  const bytes = utf8ToBytes(
    JSON.stringify({ passport_id: PASSPORT_ID, ts: Date.now(), nonce: crypto.randomUUID(), ...extra })
  );
  return challenge(
    new Request("https://gw.example.com/api/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payload: bytesToBase64url(bytes),
        signature: bytesToBase64url(ed25519.sign(bytes, seed)),
      }),
    })
  );
}

beforeEach(() => {
  process.env.VISA_SECRET = "x".repeat(48);
  h.recordMock.mockReset().mockResolvedValue(undefined);
  h.claimNonceMock.mockReset().mockResolvedValue(true);
  h.rows = [agentRow()];
});

describe("recording what a passport declares about its own key storage", () => {
  it("records the declaration on a verified mint", async () => {
    const res = await post({ key_storage: { store: "os" } });
    expect(res.status).toBe(200);
    expect(h.recordMock).toHaveBeenCalledTimes(1);
    expect(h.recordMock.mock.calls[0]?.[1]).toBe(AGENT_ID);
    expect(h.recordMock.mock.calls[0]?.[2]).toEqual({ store: "os", fallback: false });
  });

  it("records nothing when the payload declares nothing", async () => {
    expect((await post({})).status).toBe(200);
    expect(h.recordMock).not.toHaveBeenCalled();
  });

  // The whole point of putting it in the signed bytes. A passport id is public.
  it("records nothing when the signature does not verify", async () => {
    const res = await post({ key_storage: { store: "os" } }, OTHER_SEED);
    expect(res.status).toBe(401);
    expect(h.recordMock).not.toHaveBeenCalled();
  });

  it("records nothing when the passport cannot authenticate at all", async () => {
    h.rows = [agentRow({ status: "revoked" })];
    const res = await post({ key_storage: { store: "os" } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(h.recordMock).not.toHaveBeenCalled();
  });

  it("records nothing for a declaration it refuses to parse", async () => {
    expect((await post({ key_storage: { store: "os keychain" } })).status).toBe(200);
    expect((await post({ key_storage: "os" })).status).toBe(200);
    expect(h.recordMock).not.toHaveBeenCalled();
  });

  // Evidence, never authentication. Losing a dashboard signal must not cost an
  // agent its visa — the same fail-open posture as source observation.
  it("still mints when recording throws", async () => {
    h.recordMock.mockRejectedValue(new Error("redis down"));
    const res = await post({ key_storage: { store: "os" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("visa");
  });
});
