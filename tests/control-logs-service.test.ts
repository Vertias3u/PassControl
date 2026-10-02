// GET /api/control/v1/logs and service calls (any-API, 0074).
//
// The endpoint's job is the complete record, so a GitHub call must say what it
// was (`call_kind`, `endpoint`) and be selectable on its own. And a public API
// must not become a 500 on a database that has not applied 0074 yet: the
// columns are asked for, and dropped only when the database says it has none.
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
vi.mock("@/lib/control/auth", () => ({ authenticateApiKey: (...a: unknown[]) => authMock(...a) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));

const selects: string[] = [];
let missing0074 = false;
let rows: Record<string, unknown>[] = [];

vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    from: () => {
      let columns = "";
      const b: Record<string, unknown> = {
        select: (cols: string) => {
          columns = cols;
          selects.push(cols);
          return b;
        },
        eq: () => b,
        order: () => b,
        or: () => b,
        limit: () => b,
        then: (resolve: (v: unknown) => void) =>
          resolve(
            missing0074 && /call_kind|endpoint/.test(columns)
              ? { data: null, error: { code: "42703", message: "column agent_logs.call_kind does not exist" } }
              : { data: rows, error: null }
          ),
      };
      return b;
    },
  }),
}));

import { GET } from "@/app/api/control/v1/logs/route";

const req = (query = "") =>
  new Request(`https://x/api/control/v1/logs${query}`, { headers: { authorization: "Bearer pc_" + "a".repeat(40) } });

const llm = { id: "a", provider: "anthropic", model: "claude-haiku-4-5", status: "ok", created_at: "2026-09-30T01:00:03Z" };
const probe = { id: "b", provider: "openai", model: "", status: "ok", created_at: "2026-09-30T01:00:02Z" };
const github = {
  id: "c",
  provider: "svc:github",
  model: null,
  status: "ok",
  call_kind: "service",
  endpoint: "GET /repos/acme/*/issues",
  created_at: "2026-09-30T01:00:01Z",
};

beforeEach(() => {
  authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "read", keyId: "k1" });
  selects.length = 0;
  missing0074 = false;
  rows = [llm, probe, github];
});

describe("GET /logs and service calls", () => {
  it("returns what a service call was: its kind and the rule that admitted it", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(selects[0]).toMatch(/\bcall_kind\b/);
    expect(selects[0]).toMatch(/\bendpoint\b/);
    const { data } = await res.json();
    expect(data.find((r: { id: string }) => r.id === "c")).toMatchObject({
      call_kind: "service",
      endpoint: "GET /repos/acme/*/issues",
    });
  });

  it("selects service calls alone with class=service", async () => {
    const { data } = await (await GET(req("?class=service"))).json();
    expect(data.map((r: { id: string }) => r.id)).toEqual(["c"]);
  });

  it("keeps a GitHub call out of class=inference: it ran no model", async () => {
    const { data } = await (await GET(req("?class=inference"))).json();
    expect(data.map((r: { id: string }) => r.id)).toEqual(["a"]);
  });

  it("still answers on a database without 0074, and still finds service calls by provider", async () => {
    missing0074 = true;
    rows = [llm, { ...github, call_kind: undefined, endpoint: undefined }];
    const res = await GET(req("?class=service"));
    expect(res.status).toBe(200);
    expect(selects).toHaveLength(2);
    expect(selects[1]).not.toMatch(/call_kind|endpoint/);
    const { data } = await res.json();
    expect(data.map((r: { id: string }) => r.id)).toEqual(["c"]);
  });

  it("asks once when the database has the columns", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(selects).toHaveLength(1);
  });
});
