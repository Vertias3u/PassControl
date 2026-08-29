import { beforeEach, describe, expect, it, vi } from "vitest";

type ApiKeyRow = {
  id: string;
  user_id: string;
  key_hash: string;
  key_prefix: string;
  scope: "read" | "write";
  revoked_at: string | null;
  last_used_at?: string | null;
};

const { state, auditMock } = vi.hoisted(() => ({
  state: {
    rows: [] as ApiKeyRow[],
    filters: [] as Array<Array<[string, unknown]>>,
    revokeAfterAuthLookup: false,
    deleteAfterAuthLookup: false,
  },
  auditMock: vi.fn(),
}));

vi.mock("@/lib/ratelimit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));
vi.mock("@/lib/audit", () => ({ recordAdminAction: (...args: unknown[]) => auditMock(...args) }));
vi.mock("@/lib/observability", () => ({
  captureError: vi.fn(async () => {}),
  captureSecurityEvent: vi.fn(async () => {}),
}));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table !== "api_keys") throw new Error(`unexpected table: ${table}`);

      let mutation: Partial<ApiKeyRow> | null = null;
      const filters: Array<[string, unknown]> = [];
      const builder: any = {
        select: () => builder,
        update: (values: Partial<ApiKeyRow>) => {
          mutation = values;
          return builder;
        },
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        is: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        maybeSingle: async () => execute(),
        then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(execute()).then(resolve, reject),
      };

      function execute() {
        state.filters.push([...filters]);
        const matches = (row: ApiKeyRow) =>
          filters.every(([column, value]) => row[column as keyof ApiKeyRow] === value);
        const row = state.rows.find(matches) ?? null;
        const result = row ? { ...row } : null;
        if (row && !mutation && state.revokeAfterAuthLookup && filters.some(([column]) => column === "key_hash")) {
          row.revoked_at = "2026-08-28T12:00:00.000Z";
          state.revokeAfterAuthLookup = false;
        }
        if (row && !mutation && state.deleteAfterAuthLookup && filters.some(([column]) => column === "key_hash")) {
          state.rows.splice(state.rows.indexOf(row), 1);
          state.deleteAfterAuthLookup = false;
        }
        if (row && mutation) Object.assign(row, mutation);
        return { data: mutation && row ? { ...row } : result, error: null };
      }

      return builder;
    },
  }),
}));

import { hashApiKey } from "@/lib/apikeys";
import { POST } from "@/app/api/control/v1/keys/self/revoke/route";

const TOKEN = "pc_" + "a".repeat(40);
const KEY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_KEY_ID = "22222222-2222-4222-8222-222222222222";

function request(body?: unknown) {
  return new Request("https://x/api/control/v1/keys/self/revoke", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  state.filters.length = 0;
  state.revokeAfterAuthLookup = false;
  state.deleteAfterAuthLookup = false;
  state.rows = [
    {
      id: KEY_ID,
      user_id: "tenant-1",
      key_hash: await hashApiKey(TOKEN),
      key_prefix: "pc_aaaaaaaa",
      scope: "write",
      revoked_at: null,
    },
    {
      id: OTHER_KEY_ID,
      user_id: "tenant-2",
      key_hash: "other-hash",
      key_prefix: "pc_bbbbbbbb",
      scope: "write",
      revoked_at: null,
    },
  ];
});

describe("POST /api/control/v1/keys/self/revoke", () => {
  it("revokes only the key that authenticated, even when the body names another tenant's key", async () => {
    const response = await POST(request({ id: OTHER_KEY_ID }));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      prefix: "pc_aaaaaaaa",
      revoked_at: expect.any(String),
    });
    expect(state.rows[0]!.revoked_at).toEqual(expect.any(String));
    expect(state.rows[1]!.revoked_at).toBeNull();
    expect(state.filters).toContainEqual(
      expect.arrayContaining([
        ["user_id", "tenant-1"],
        ["id", KEY_ID],
        ["revoked_at", null],
      ])
    );
    expect(auditMock).toHaveBeenCalledWith({
      userId: "tenant-1",
      action: "apikey.revoke",
      targetType: "api_key",
      targetId: KEY_ID,
      metadata: { prefix: "pc_aaaaaaaa", via: "api" },
    });
  });

  it("returns already_revoked rather than silently succeeding a second time", async () => {
    // Simulate another request committing the revocation after this request's
    // authentication lookup but before its guarded update.
    state.revokeAfterAuthLookup = true;

    const response = await POST(request());

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("already_revoked");
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("rejects the same bearer on the request immediately after self-revocation", async () => {
    expect((await POST(request())).status).toBe(200);

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("invalid_api_key");
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it("returns not_found when the authenticated row disappears before the guarded update", async () => {
    state.deleteAfterAuthLookup = true;

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("not_found");
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("requires write scope and leaves the key active", async () => {
    state.rows[0]!.scope = "read";

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(state.rows[0]!.revoked_at).toBeNull();
    expect(auditMock).not.toHaveBeenCalled();
  });
});
