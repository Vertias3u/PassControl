import { describe, it, expect, vi, beforeEach } from "vitest";

import { LOG_COLS, RECEIPT_COLS } from "@/lib/control/columns";

const authMock = vi.fn();
vi.mock("@/lib/control/auth", () => ({ authenticateApiKey: (...a: any[]) => authMock(...a) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));

let dataset: { data: unknown; error: unknown } = { data: null, error: null };
const eqCalls: [string, unknown][] = [];
const selectCalls: string[] = [];
const builder = () => {
  const b: any = {
    select: (cols: string) => {
      selectCalls.push(cols);
      return b;
    },
    eq: (col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return b;
    },
    order: () => b,
    limit: () => b,
    maybeSingle: async () => dataset,
    then: (res: any) => res(dataset),
  };
  return b;
};
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({ from: () => builder() }) }));

import { GET } from "@/app/api/control/v1/receipts/[id]/route";

const ID = "11111111-2222-4333-8444-555555555555";

const req = () =>
  new Request(`https://x/api/control/v1/receipts/${ID}`, {
    headers: { authorization: "Bearer pc_" + "a".repeat(40) },
  });

const call = (id = ID) => GET(req(), { params: Promise.resolve({ id }) });

beforeEach(() => {
  authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "read", keyId: "k1" });
  eqCalls.length = 0;
  selectCalls.length = 0;
  dataset = { data: null, error: null };
});

describe("fetching a signed receipt", () => {
  // The service-role client bypasses RLS, so this .eq() IS the tenant boundary.
  // Losing it would make every call in the database readable with any API key.
  it("is scoped to the calling tenant", async () => {
    dataset = { data: { id: ID, receipt: "a.b.c" }, error: null };
    await call();

    expect(eqCalls).toContainEqual(["user_id", "u1"]);
    expect(eqCalls).toContainEqual(["id", ID]);
  });

  it("returns the receipt for a call the caller owns", async () => {
    dataset = { data: { id: ID, status: "ok", receipt: "a.b.c" }, error: null };
    const res = await call();

    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ id: ID, receipt: "a.b.c" });
  });

  // A 403 would confirm the id exists and turn this into a cross-tenant
  // existence oracle. Another tenant's receipt must be indistinguishable from
  // one that was never written.
  it("answers 404, not 403, for an id belonging to another tenant", async () => {
    dataset = { data: null, error: null };
    const res = await call();

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("rejects a non-uuid id before touching the database", async () => {
    const res = await call("not-a-uuid");

    expect(res.status).toBe(400);
    expect(eqCalls).toHaveLength(0);
  });

  it("explains an absent receipt instead of returning a bare null", async () => {
    dataset = { data: { id: ID, status: "ok", receipt: null }, error: null };
    const res = await call();

    expect((await res.json()).data.reason).toBe("receipts_not_enabled");
  });

  it("reports a query failure as 500 rather than a missing receipt", async () => {
    dataset = { data: null, error: { message: "db down" } };
    const res = await call();

    expect(res.status).toBe(500);
  });
});

describe("the receipt stays off the list endpoint", () => {
  // A receipt is ~600-900 bytes of JWS. Folding it into LOG_COLS would add that
  // to every row of every page for the one caller in a hundred who wants a proof.
  it("LOG_COLS never selects the receipt column", () => {
    expect(LOG_COLS).not.toContain("receipt");
  });

  it("RECEIPT_COLS selects it, and the route uses RECEIPT_COLS", async () => {
    dataset = { data: { id: ID, receipt: "a.b.c" }, error: null };
    await call();

    expect(RECEIPT_COLS).toContain("receipt");
    expect(selectCalls).toContain(RECEIPT_COLS);
  });

  it("returns the stored authentication identity needed to audit a direct call", () => {
    for (const column of ["auth_method", "agent_access_key_id", "credential_use_id"]) {
      expect(RECEIPT_COLS).toContain(column);
    }
  });
});
