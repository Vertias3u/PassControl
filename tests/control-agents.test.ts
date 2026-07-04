import { describe, it, expect, vi, beforeEach } from "vitest";

// Auth + rate limit are exercised in control-handler/auth tests; here we mock them
// as a passing read key and focus on the route's TENANT ISOLATION: because the
// control plane uses the service-role client (bypasses RLS), every query MUST be
// scoped `.eq("user_id", <caller>)`. We record .eq() calls and assert it.
const authMock = vi.fn();
vi.mock("@/lib/control/auth", () => ({ authenticateApiKey: (...a: any[]) => authMock(...a) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));

let dataset: { data: unknown; error: unknown } = { data: [], error: null };
const eqCalls: [string, unknown][] = [];
const builder = () => {
  const b: any = {
    select: () => b,
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

import { GET as listAgents } from "@/app/api/control/v1/agents/route";
import { GET as getAgent } from "@/app/api/control/v1/agents/[id]/route";

const req = (url = "https://x/api/control/v1/agents") =>
  new Request(url, { headers: { authorization: "Bearer pc_" + "a".repeat(40) } });

beforeEach(() => {
  authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "read", keyId: "k1" });
  eqCalls.length = 0;
  dataset = { data: [], error: null };
});

describe("GET /agents — tenant isolation", () => {
  it("scopes the list to the caller's userId", async () => {
    dataset = { data: [{ id: "a1" }], error: null };
    const res = await listAgents(req());
    expect(res.status).toBe(200);
    expect(eqCalls).toContainEqual(["user_id", "u1"]); // the boundary
    expect((await res.json()).data).toEqual([{ id: "a1" }]);
  });

  it("applies an optional status filter on top of the userId scope", async () => {
    await listAgents(req("https://x/api/control/v1/agents?status=active"));
    expect(eqCalls).toContainEqual(["user_id", "u1"]);
    expect(eqCalls).toContainEqual(["status", "active"]);
  });
});

describe("GET /agents/{id}", () => {
  const UUID = "11111111-1111-1111-1111-111111111111";

  it("400 on a malformed id (no query issued)", async () => {
    const res = await getAgent(req(), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(res.status).toBe(400);
  });

  it("scopes by userId + id and 404s when absent", async () => {
    dataset = { data: null, error: null };
    const res = await getAgent(req(), { params: Promise.resolve({ id: UUID }) });
    expect(res.status).toBe(404);
    expect(eqCalls).toContainEqual(["user_id", "u1"]);
    expect(eqCalls).toContainEqual(["id", UUID]);
  });

  it("returns the agent when found", async () => {
    dataset = { data: { id: UUID, name: "x" }, error: null };
    const res = await getAgent(req(), { params: Promise.resolve({ id: UUID }) });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ id: UUID });
  });
});
