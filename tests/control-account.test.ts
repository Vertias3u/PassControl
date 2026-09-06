import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const getUserById = vi.fn();

vi.mock("@/lib/control/auth", () => ({ authenticateApiKey: (...args: any[]) => auth(...args) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({ auth: { admin: { getUserById } } }),
}));

import { GET } from "@/app/api/control/v1/account/route";

const request = (suffix = "") =>
  new Request(`https://test.invalid/api/control/v1/account${suffix}`, {
    headers: { authorization: `Bearer pc_${"a".repeat(40)}` },
  });

beforeEach(() => {
  auth.mockReset();
  getUserById.mockReset();
  auth.mockResolvedValue({ ok: true, userId: "key-owner", scope: "read", keyId: "key-1" });
});

describe("GET /api/control/v1/account", () => {
  it("returns only the authenticated key owner's email and key scope", async () => {
    getUserById.mockResolvedValue({
      data: {
        user: {
          id: "key-owner",
          email: "owner@example.test",
          factors: [{ factor_type: "totp", status: "verified" }],
          user_metadata: { secret: "not-an-api-field" },
        },
      },
      error: null,
    });

    const response = await GET(request("?user_id=someone-else"));
    expect(response.status).toBe(200);
    expect(getUserById).toHaveBeenCalledWith("key-owner");
    expect(await response.json()).toEqual({
      data: { email: "owner@example.test", control_key_scope: "read" },
    });
  });

  it("reports a missing email as null rather than inventing an identity", async () => {
    auth.mockResolvedValue({ ok: true, userId: "key-owner", scope: "write", keyId: "key-1" });
    getUserById.mockResolvedValue({ data: { user: { id: "key-owner" } }, error: null });
    const response = await GET(request());
    expect(await response.json()).toEqual({ data: { email: null, control_key_scope: "write" } });
  });

  it("fails closed when Auth Admin cannot prove the account", async () => {
    getUserById.mockResolvedValue({ data: null, error: new Error("down") });
    const unavailable = await GET(request());
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.code).toBe("account_unavailable");

    getUserById.mockResolvedValue({ data: { user: { id: "different-user", email: "x@y.test" } }, error: null });
    const mismatch = await GET(request());
    expect(mismatch.status).toBe(503);
  });
});
