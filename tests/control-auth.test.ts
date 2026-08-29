import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the service-role client; the lookup result is set per test.
let lookup: { data: unknown; error: unknown } = { data: null, error: null };
/** Every `update({...})` payload, so the rolling-expiry write can be asserted on. */
let updates: Record<string, unknown>[] = [];
const db = {
  from: () => {
    const b: any = {
      select: () => b,
      eq: () => b,
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return b;
      },
      maybeSingle: async () => lookup,
      then: (res: any) => res({ data: null, error: null }), // for the fire-and-forget last-used update
    };
    return b;
  },
};
vi.mock("@/lib/supabase", () => ({ serviceClient: () => db }));

import { authenticateApiKey } from "@/lib/control/auth";

const VALID = "pc_" + "a".repeat(40);
const req = (auth?: string) =>
  new Request("https://x/api/control/v1/agents", auth ? { headers: { authorization: auth } } : undefined);

beforeEach(() => {
  lookup = { data: null, error: null };
  updates = [];
});

describe("authenticateApiKey", () => {
  it("401 missing_api_key when no Authorization header", async () => {
    expect(await authenticateApiKey(req())).toMatchObject({ ok: false, status: 401, code: "missing_api_key" });
  });

  it("401 invalid_api_key for a non-pc_ token (cheap shape filter, no DB hit)", async () => {
    expect(await authenticateApiKey(req("Bearer sk-not-ours-aaaaaaaaaaaaaaaaaaaa"))).toMatchObject({
      ok: false,
      code: "invalid_api_key",
    });
  });

  it("401 invalid_api_key when the key hash isn't found", async () => {
    lookup = { data: null, error: null };
    expect(await authenticateApiKey(req("Bearer " + VALID))).toMatchObject({ ok: false, code: "invalid_api_key" });
  });

  it("401 invalid_api_key when the key is revoked (indistinguishable from not-found)", async () => {
    lookup = { data: { id: "k1", user_id: "u1", scope: "read", revoked_at: "2026-01-01T00:00:00Z" }, error: null };
    expect(await authenticateApiKey(req("Bearer " + VALID))).toMatchObject({ ok: false, code: "invalid_api_key" });
  });

  it("resolves a valid key to its owner + scope + id", async () => {
    lookup = { data: { id: "k1", user_id: "u1", scope: "write", revoked_at: null }, error: null };
    expect(await authenticateApiKey(req("Bearer " + VALID))).toEqual({
      ok: true,
      userId: "u1",
      scope: "write",
      keyId: "k1",
    });
  });
});

// ── Idle expiry ─────────────────────────────────────────────────────────────
//
// `login` mints a write-scoped control key per machine, so keys now accumulate:
// a decommissioned or stolen laptop kept create/suspend/revoke authority over the
// fleet forever, because `api_keys` had no expiry column and nothing enforced one.
//
// The window is ROLLING, not absolute. A machine in daily use must never expire —
// an absolute cap would break working CI four times a year for no security gain,
// since a key in constant use is a key someone is watching. What it kills is the
// laptop in a drawer, which is the actual threat.
describe("authenticateApiKey — idle expiry", () => {
  const future = new Date(Date.now() + 60 * 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();

  it("refuses an expired key with the SAME answer as an unknown one", async () => {
    // Not a distinct code, deliberately. `expired_api_key` would confirm to an
    // unauthenticated caller that a guessed key had once existed, which is the
    // enumeration oracle the revoked branch above already refuses to be.
    lookup = { data: { id: "k1", user_id: "u1", scope: "write", revoked_at: null, expires_at: past }, error: null };
    expect(await authenticateApiKey(req("Bearer " + VALID))).toMatchObject({
      ok: false,
      status: 401,
      code: "invalid_api_key",
    });
  });

  it("leaves a key with no expiry alone — every existing key is one", async () => {
    // Migration 0041 backfills nothing: NULL means never expires. If this ever
    // goes red, the migration has silently expired every dashboard-created key
    // in production.
    lookup = { data: { id: "k1", user_id: "u1", scope: "read", revoked_at: null, expires_at: null }, error: null };
    expect(await authenticateApiKey(req("Bearer " + VALID))).toMatchObject({ ok: true, keyId: "k1" });
    const pushed = updates.filter((u) => "expires_at" in u);
    expect(pushed, "a key with no expiry must not be given one by using it").toEqual([]);
  });

  it("pushes the window forward each time an expiring key is used", async () => {
    lookup = { data: { id: "k1", user_id: "u1", scope: "write", revoked_at: null, expires_at: future }, error: null };
    expect(await authenticateApiKey(req("Bearer " + VALID))).toMatchObject({ ok: true });

    const pushed = updates.find((u) => "expires_at" in u);
    expect(pushed, "using the key must extend it, or the window is not rolling").toBeTruthy();
    const next = Date.parse(String(pushed!.expires_at));
    expect(next, "the new deadline must be further out than the old one").toBeGreaterThan(Date.parse(future));
  });

  it("does not resurrect an already-expired key by touching it", async () => {
    // The push happens only on the success path. A refused request that still
    // extended the deadline would make the expiry unreachable: every probe
    // against a dead key would keep it alive for another window.
    lookup = { data: { id: "k1", user_id: "u1", scope: "write", revoked_at: null, expires_at: past }, error: null };
    await authenticateApiKey(req("Bearer " + VALID));
    expect(updates.filter((u) => "expires_at" in u)).toEqual([]);
  });
});
