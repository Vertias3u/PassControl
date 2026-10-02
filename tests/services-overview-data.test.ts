// The Services page's read (any-API phase 2, slice D): per service, the token,
// the stop switch, which agents can reach it, and the last hour's calls.
//
// Every part is read on its own and degrades on its own: a failed read says
// "could not read", never "none" — "no agents have access" and "we could not
// tell which agents have access" send an operator in opposite directions.
import { describe, expect, it, vi } from "vitest";
import { readServicesOverview } from "@/app/dashboard/services/services-data";

type Answer = { data?: unknown; error?: unknown; count?: number | null };

function db(answers: Record<string, Answer | ((filters: [string, string, unknown][]) => Answer)>) {
  const filtersSeen: Record<string, [string, string, unknown][][]> = {};
  return {
    filtersSeen,
    client: {
      from(table: string) {
        const filters: [string, string, unknown][] = [];
        (filtersSeen[table] ??= []).push(filters);
        const chain: Record<string, unknown> = {
          select: () => chain,
          order: () => chain,
          limit: () => chain,
          eq: (c: string, v: unknown) => (filters.push(["eq", c, v]), chain),
          gte: (c: string, v: unknown) => (filters.push(["gte", c, v]), chain),
          like: (c: string, v: unknown) => (filters.push(["like", c, v]), chain),
          then: (resolve: (v: unknown) => void) => {
            const key = filters.some(([op]) => op === "like") ? `${table}:refused` : table;
            const a = answers[key] ?? answers[table];
            resolve(typeof a === "function" ? a(filters) : a ?? { data: [], error: null, count: 0 });
          },
        };
        return chain;
      },
    } as never,
  };
}

const NOW = new Date("2026-10-02T12:00:00Z");
const RULES = { github: { allow: [{ method: "GET", path: "/user" }, { method: "POST", path: "/repos/a/b/issues" }], max_requests_per_hour: 50 } };

describe("readServicesOverview", () => {
  it("reports the token in use, the stop switch, agents with access and the last hour", async () => {
    const { client, filtersSeen } = db({
      provider_credentials: { data: [{ id: "c1", label: "ci bot", is_active: true, created_at: "2026-09-30T00:00:00Z" }], error: null },
      agents: {
        data: [
          { id: "a1", name: "triage", status: "active", service_rules: RULES },
          { id: "a2", name: "writer", status: "active", service_rules: { github: { allow: [{ method: "POST", path: "/x/**" }] } } },
          { id: "a3", name: "chat-only", status: "active", service_rules: null },
        ],
        error: null,
      },
      agent_logs: { data: null, error: null, count: 12 },
      "agent_logs:refused": { data: null, error: null, count: 3 },
    });
    const [github] = await readServicesOverview(client, "tenant-a", { observeKill: async () => true, now: NOW });
    expect(github).toMatchObject({
      id: "github",
      label: "GitHub",
      stopped: true,
      token: { state: "stored", label: "ci bot" },
      agents: {
        state: "ok",
        total: 3,
        withAccess: [
          { id: "a1", name: "triage", state: "rules", rules: 2, writes: 1, cap: 50 },
          { id: "a2", name: "writer", state: "malformed" },
        ],
      },
      lastHour: { state: "ok", calls: 12, refused: 3 },
    });
    // Every read is scoped to this tenant in code, whichever client is passed.
    for (const table of ["provider_credentials", "agents", "agent_logs"]) {
      for (const filters of filtersSeen[table]!) expect(filters).toContainEqual(["eq", "user_id", "tenant-a"]);
    }
    // The hour is the last hour, for this service's calls only.
    expect(filtersSeen.agent_logs![0]).toContainEqual(["eq", "provider", "svc:github"]);
    expect(filtersSeen.agent_logs![0]).toContainEqual(["gte", "created_at", "2026-10-02T11:00:00.000Z"]);
  });

  it("says no token, rather than unreadable, when none is stored", async () => {
    const { client } = db({ provider_credentials: { data: [], error: null } });
    const [github] = await readServicesOverview(client, "t", { observeKill: async () => false, now: NOW });
    expect(github!.token).toEqual({ state: "none" });
    expect(github!.stopped).toBe(false);
  });

  it("never turns a failed read into none or zero", async () => {
    const { client } = db({
      provider_credentials: { data: null, error: { code: "x" } },
      agents: { data: null, error: { code: "x" } },
      agent_logs: { data: null, error: { code: "x" }, count: null },
    });
    const [github] = await readServicesOverview(client, "t", { observeKill: async () => null, now: NOW });
    expect(github).toMatchObject({
      stopped: null,
      token: { state: "unavailable" },
      agents: { state: "unavailable" },
      lastHour: { state: "unavailable" },
    });
  });
});
