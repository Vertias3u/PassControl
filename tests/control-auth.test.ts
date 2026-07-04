import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the service-role client; the lookup result is set per test.
let lookup: { data: unknown; error: unknown } = { data: null, error: null };
const db = {
  from: () => {
    const b: any = {
      select: () => b,
      eq: () => b,
      update: () => b,
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
