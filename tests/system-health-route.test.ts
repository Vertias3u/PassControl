import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.fn();
const operator = vi.fn();
const snapshot = vi.fn();
vi.mock("@/lib/control/auth", () => ({ authenticateApiKey: (...args: any[]) => auth(...args) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({ auth: { admin: {} } }) }));
vi.mock("@/lib/system-health/operator", () => ({ systemOperatorForControl: (...args: any[]) => operator(...args) }));
vi.mock("@/lib/system-health/cache", () => ({ getCachedSystemHealthSnapshot: (...args: any[]) => snapshot(...args) }));

import { GET } from "@/app/api/control/v1/system/route";

const request = () => new Request("https://test.invalid/api/control/v1/system", { headers: { authorization: "Bearer pc_" + "a".repeat(40) } });

beforeEach(() => {
  auth.mockReset(); operator.mockReset(); snapshot.mockReset();
  auth.mockResolvedValue({ ok: true, userId: "key-owner", scope: "read", keyId: "key-1" });
});

describe("GET /api/control/v1/system", () => {
  it("fails closed when the authoritative key-owner check refuses", async () => {
    operator.mockResolvedValue({ ok: false, reason: "forbidden" });
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("system_forbidden");
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("tells a refused key owner which condition it failed, without widening access", async () => {
    // One opaque 403 for every refusal made a misconfigured instance and an
    // unauthorized key look identical to the operator debugging them.
    for (const [reason, code] of [
      ["enrollment_required", "system_totp_required"],
      ["not_configured", "system_not_configured"],
      ["misconfigured", "system_allowlist_invalid"],
      ["forbidden", "system_forbidden"],
    ] as const) {
      operator.mockResolvedValue({ ok: false, reason });
      const response = await GET(request());
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe(code);
    }
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("requires read control auth before the Auth-admin operator check", async () => {
    operator.mockResolvedValue({ ok: true, user: { id: "key-owner" } });
    snapshot.mockResolvedValue({ format_version: 1 });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(operator).toHaveBeenCalledWith(expect.anything(), "key-owner");
    expect(await response.json()).toEqual({ format_version: 1 });
  });
});
