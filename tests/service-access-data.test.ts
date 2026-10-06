// The agent page's read of one agent's service access: its own query, so a
// database without 0074 costs this panel and not the page.
import { describe, expect, it } from "vitest";
import { readAgentServiceAccess } from "@/app/dashboard/agents/[id]/service-access-data";

function db(rules: { data: unknown; error: unknown }, tokens: { count: number | null; error: unknown }) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => rules,
        then: (resolve: (v: unknown) => void) => resolve(table === "provider_credentials" ? tokens : rules),
      };
      return chain;
    },
  } as never;
}

describe("readAgentServiceAccess", () => {
  it("reads valid rules, the stored cap, and whether a token exists", async () => {
    const read = await readAgentServiceAccess(
      db(
        {
          data: { service_rules: { github: { allow: [{ method: "GET", path: "/user" }], max_requests_per_hour: 9 } } },
          error: null,
        },
        { count: 1, error: null }
      ),
      "tenant",
      "agent",
      "github"
    );
    expect(read).toEqual({
      state: "ok",
      allow: [{ method: "GET", path: "/user", ask: false }],
      maxRequestsPerHour: 9,
      configured: true,
      tokenStored: true,
    });
  });

  it("reads no rules as no access, not as an error", async () => {
    const read = await readAgentServiceAccess(
      db({ data: { service_rules: null }, error: null }, { count: 0, error: null }),
      "tenant",
      "agent",
      "github"
    );
    expect(read).toMatchObject({ state: "ok", allow: [], configured: false, tokenStored: false });
  });

  it("says so when the stored rules are malformed (the gateway refuses every call)", async () => {
    const read = await readAgentServiceAccess(
      db({ data: { service_rules: { github: { allow: [{ method: "POST", path: "/x/**" }] } } }, error: null }, { count: 1, error: null }),
      "tenant",
      "agent",
      "github"
    );
    expect(read.state).toBe("malformed");
  });

  it("degrades to unavailable on a database without 0074, instead of throwing", async () => {
    const read = await readAgentServiceAccess(
      db({ data: null, error: { code: "42703" } }, { count: null, error: null }),
      "tenant",
      "agent",
      "github"
    );
    expect(read).toEqual({ state: "unavailable" });
  });
});
