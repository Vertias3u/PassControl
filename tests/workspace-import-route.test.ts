import { describe, it, expect, vi, beforeEach } from "vitest";

// Auth and rate limiting are mocked; the Supabase client is a hand-rolled fake
// that RECORDS every insert, because the property under test is what the route
// writes — and a dry run's whole promise is that the answer is "nothing".
const {
  authMock,
  auditMock,
  inserts,
  heldPubkeys,
  ownerRow,
  insertError,
  insertErrors,
  ownedAfterConflict,
  rereadError,
  availability,
  availabilityError,
  unavailableOwnershipRows,
  unavailableOwnershipError,
  rpcCalls,
  conflictFilters,
  unavailableOwnershipFilters,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  auditMock: vi.fn(),
  inserts: [] as { table: string; row: Record<string, unknown> }[],
  heldPubkeys: { value: [] as string[] },
  ownerRow: { value: null as unknown },
  insertError: { value: null as unknown },
  insertErrors: { value: [] as unknown[] },
  // What the post-conflict re-read finds: whether THIS tenant turns out to hold
  // the colliding passport after all.
  ownedAfterConflict: { value: null as unknown },
  rereadError: { value: null as unknown },
  // The global registry RPC reports only whether a key is available — never
  // the tenant or agent holding it.
  availability: { value: new Map<string, boolean>() },
  availabilityError: { value: null as unknown },
  unavailableOwnershipRows: { value: [] as { passport_pubkey: string }[] },
  unavailableOwnershipError: { value: null as unknown },
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  conflictFilters: [] as [string, unknown][][],
  unavailableOwnershipFilters: [] as [string, unknown][][],
}));

vi.mock("@/lib/control/auth", () => ({ authenticateApiKey: (...a: any[]) => authMock(...a) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));
vi.mock("@/lib/audit", () => ({ recordAdminAction: (...a: any[]) => auditMock(...a) }));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    from(table: string) {
      return {
        select() {
          const filters: [string, unknown][] = [];
          const query: {
            eq: (column: string, value: unknown) => typeof query;
            in: (column: string, values: unknown[]) => typeof query;
            maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
            then: (resolve: (value: { data: unknown; error: unknown }) => unknown) => Promise<unknown>;
          } = {
            eq(column, value) {
              filters.push([column, value]);
              return query;
            },
            in(column, values) {
              filters.push([column, values]);
              return query;
            },
            async maybeSingle() {
              if (table === "agent_owners") return { data: ownerRow.value, error: null };
              if (table === "agents" && filters.some(([column]) => column === "passport_pubkey")) {
                conflictFilters.push([...filters]);
                return { data: ownedAfterConflict.value, error: rereadError.value };
              }
              return { data: null, error: null };
            },
            then(resolve) {
              if (table === "agents" && filters.some(([column]) => column === "passport_pubkey" && Array.isArray(filters.find(([name]) => name === column)?.[1]))) {
                unavailableOwnershipFilters.push([...filters]);
                return Promise.resolve({ data: unavailableOwnershipRows.value, error: unavailableOwnershipError.value }).then(resolve);
              }
              const data = table === "agents" ? heldPubkeys.value.map((k) => ({ passport_pubkey: k })) : [];
              return Promise.resolve({ data, error: null }).then(resolve);
            },
          };
          return query;
        },
        async insert(row: Record<string, unknown>) {
          inserts.push({ table, row });
          return { error: insertErrors.value.length > 0 ? insertErrors.value.shift() : insertError.value };
        },
      };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      const keys = Array.isArray(args.p_passport_pubkeys) ? args.p_passport_pubkeys : [];
      return {
        data: keys.map((passport_pubkey) => ({
          passport_pubkey,
          available: availability.value.get(String(passport_pubkey)) ?? true,
        })),
        error: availabilityError.value,
      };
    },
  }),
}));

import { POST } from "@/app/api/control/v1/workspace/import/route";

const PUBKEY_A = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const PUBKEY_B = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk";

const agent = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: "billing-bot",
  passport_pubkey: PUBKEY_A,
  allowed_scopes: [{ provider: "anthropic", models: ["claude-*"] }],
  budget_tokens: 1000,
  budget_cents: null,
  policy: null,
  policy_shadow: null,
  fallbacks: [],
  status: "active",
  expires_at: null,
  ...over,
});

const post = (body: unknown, query = "") =>
  POST(
    new Request(`https://x/api/control/v1/workspace/import${query}`, {
      method: "POST",
      headers: { authorization: "Bearer pc_" + "a".repeat(40), "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  vi.clearAllMocks();
  inserts.length = 0;
  heldPubkeys.value = [];
  ownerRow.value = null;
  insertError.value = null;
  insertErrors.value = [];
  ownedAfterConflict.value = null;
  rereadError.value = null;
  availability.value = new Map();
  availabilityError.value = null;
  unavailableOwnershipRows.value = [];
  unavailableOwnershipError.value = null;
  rpcCalls.length = 0;
  conflictFilters.length = 0;
  unavailableOwnershipFilters.length = 0;
  authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "write", keyId: "k1" });
});

describe("POST /workspace/import", () => {
  it("requires write scope — a read key writes nothing", async () => {
    authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "read", keyId: "k1" });
    const res = await post({ agents: [agent()] });
    expect(res.status).toBe(403);
    expect(inserts).toHaveLength(0);
  });

  // The promise the confirmation prompt rests on.
  it("a dry run inserts nothing and records nothing", async () => {
    const res = await post({ agents: [agent(), agent({ passport_pubkey: PUBKEY_B })] }, "?dry_run=true");
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.dry_run).toBe(true);
    expect(body.data.agents.create).toBe(2);
    expect(inserts).toHaveLength(0);
    // No audit row either: nothing happened, so the trail must not say it did.
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("applies, stamps the caller's tenant on every row, and audits once", async () => {
    const res = await post({ agents: [agent(), agent({ passport_pubkey: PUBKEY_B, name: "ci-runner" })] });
    const body = await res.json();
    expect(body.data.agents.created).toEqual(["billing-bot", "ci-runner"]);
    expect(inserts).toHaveLength(2);
    for (const { row } of inserts) expect(row.user_id).toBe("u1");
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "workspace.import", userId: "u1" })
    );
  });

  it("writes a restrictive policy and a suspended status in the one agent insert", async () => {
    const policy = { max_requests_per_hour: 3, deny: [{ provider: "anthropic", models: ["claude-secret-*"] }] };
    const res = await post({ agents: [agent({ policy, status: "suspended" })] });
    expect(res.status).toBe(200);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.row).toMatchObject({ policy, status: "suspended" });
  });

  // Skip-and-report: an agent the tenant already holds is not touched at all.
  it("issues no write for a passport that already exists", async () => {
    heldPubkeys.value = [PUBKEY_A];
    const body = await (await post({ agents: [agent()] })).json();
    expect(body.data.agents.skipped).toEqual(["billing-bot"]);
    expect(inserts).toHaveLength(0);
  });

  it("is additive on a re-run: the same file twice creates nothing the second time", async () => {
    await post({ agents: [agent()] });
    expect(inserts).toHaveLength(1);
    heldPubkeys.value = [PUBKEY_A]; // what the first run left behind
    inserts.length = 0;
    const body = await (await post({ agents: [agent()] })).json();
    expect(inserts).toHaveLength(0);
    expect(body.data.agents.create).toBe(0);
  });

  // agents.passport_pubkey is UNIQUE GLOBALLY, not per tenant, so a unique
  // violation has two meanings and the report must not conflate them.
  it("reports a raced create by the same tenant as skipped", async () => {
    insertError.value = { code: "23505" };
    ownedAfterConflict.value = { id: "a1" }; // the caller does hold it now
    const res = await post({ agents: [agent()] });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.agents.skipped).toEqual(["billing-bot"]);
    expect(body.data.agents.create).toBe(0);
    // This is not a source-text check: the fake only reports ownership after
    // both filters arrive, so a missing tenant filter cannot make this pass.
    expect(conflictFilters).toEqual([[ ["user_id", "u1"], ["passport_pubkey", PUBKEY_A] ]]);
  });

  it("fails closed when the tenant-scoped conflict re-read fails", async () => {
    insertError.value = { code: "23505" };
    rereadError.value = { code: "XX000" };
    const res = await post({ agents: [agent()] });
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("query_failed");
    expect(conflictFilters).toEqual([[ ["user_id", "u1"], ["passport_pubkey", PUBKEY_A] ]]);
  });

  // The bug this replaced: reporting "skipped (already exists)" for a workspace
  // that holds nothing would tell an operator their fleet was restored while it
  // is in fact empty.
  it("does not call a passport held by another workspace 'already exists'", async () => {
    insertError.value = { code: "23505" };
    ownedAfterConflict.value = null; // nothing of the caller's collided
    const body = await (await post({ agents: [agent()] })).json();
    expect(body.data.agents.skipped).toEqual([]);
    expect(body.data.agents.rejected).toEqual([
      { name: "billing-bot", reason: "passport_registered_elsewhere" },
    ]);
    expect(body.data.agents.create).toBe(0);
    expect(body.data.agents.reject).toBe(1);
  });

  it("handles a 0035 namespace-race conflict with the same tenant-scoped re-read", async () => {
    insertError.value = { code: "P0001", message: "passport_key_in_use" };
    ownedAfterConflict.value = null;
    const body = await (await post({ agents: [agent()] })).json();
    expect(body.data.agents.rejected).toEqual([
      { name: "billing-bot", reason: "passport_registered_elsewhere" },
    ]);
    expect(conflictFilters).toEqual([[ ["user_id", "u1"], ["passport_pubkey", PUBKEY_A] ]]);
  });

  // Counts come from what happened, not from what was planned.
  it("recounts the report from the writes, not from the plan", async () => {
    const body = await (await post({ agents: [agent(), agent({ passport_pubkey: PUBKEY_B, name: "ci" })] })).json();
    expect(body.data.agents.create).toBe(2);
    expect(body.data.agents.created).toHaveLength(2);
  });

  it("refuses a malformed policy without creating the agent unrestricted", async () => {
    const body = await (await post({ agents: [agent({ policy: { nope: 1 } })] })).json();
    expect(inserts).toHaveLength(0);
    expect(body.data.agents.rejected).toEqual([{ name: "billing-bot", reason: "policy_malformed" }]);
  });

  it.each(["policy", "status", "budget_tokens", "budget_cents", "expires_at", "fallbacks", "policy_shadow"])(
    "refuses a missing %s before any insert",
    async (field) => {
      const truncated = agent();
      delete truncated[field];
      const body = await (await post({ agents: [truncated] })).json();
      expect(inserts).toHaveLength(0);
      expect(body.data.agents.rejected).toEqual([{ name: "billing-bot", reason: `${field}_missing` }]);
    }
  );

  it("refuses a duplicate in one file rather than presenting it as tenant-owned", async () => {
    const body = await (await post({ agents: [agent(), agent({ name: "second-copy" })] })).json();
    expect(inserts).toHaveLength(1);
    expect(body.data.agents.skipped).toEqual([]);
    expect(body.data.agents.rejected).toEqual([{ name: "second-copy", reason: "duplicate_passport_in_file" }]);
  });

  it("uses the private availability RPC so dry-run reports a global collision honestly", async () => {
    availability.value.set(PUBKEY_A, false);
    const body = await (await post({ agents: [agent()] }, "?dry_run=true")).json();
    expect(inserts).toHaveLength(0);
    expect(body.data.agents).toMatchObject({ create: 0, reject: 1 });
    expect(body.data.agents.rejected).toEqual([{ name: "billing-bot", reason: "passport_registered_elsewhere" }]);
    expect(rpcCalls).toEqual([{
      name: "passport_key_availability",
      args: { p_passport_pubkeys: [PUBKEY_A] },
    }]);
  });

  it("reclassifies an unavailable preview key as this tenant's raced create", async () => {
    // The initial held-key read happened before availability. Another request
    // from this tenant can create the same agent in that gap, so `false` is
    // not evidence that another tenant owns it.
    availability.value.set(PUBKEY_A, false);
    unavailableOwnershipRows.value = [{ passport_pubkey: PUBKEY_A }];
    const body = await (await post({ agents: [agent()] })).json();
    expect(body.data.agents.skipped).toEqual(["billing-bot"]);
    expect(body.data.agents.rejected).toEqual([]);
    expect(inserts).toHaveLength(0);
    expect(unavailableOwnershipFilters).toEqual([[ ["user_id", "u1"], ["passport_pubkey", [PUBKEY_A]] ]]);
  });

  it("keeps an unavailable preview key refused when the fresh tenant read finds no owner", async () => {
    availability.value.set(PUBKEY_A, false);
    const body = await (await post({ agents: [agent()] }, "?dry_run=true")).json();
    expect(body.data.agents.skipped).toEqual([]);
    expect(body.data.agents.rejected).toEqual([
      { name: "billing-bot", reason: "passport_registered_elsewhere" },
    ]);
    expect(unavailableOwnershipFilters).toEqual([[ ["user_id", "u1"], ["passport_pubkey", [PUBKEY_A]] ]]);
  });

  it("fails closed when the unavailable-preview ownership re-read fails", async () => {
    availability.value.set(PUBKEY_A, false);
    unavailableOwnershipError.value = { code: "XX000" };
    const res = await post({ agents: [agent()] }, "?dry_run=true");
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("query_failed");
    expect(unavailableOwnershipFilters).toEqual([[ ["user_id", "u1"], ["passport_pubkey", [PUBKEY_A]] ]]);
  });

  it("records and reports successful earlier rows when a later write fails", async () => {
    insertErrors.value = [null, { code: "XX000" }];
    const res = await post({ agents: [agent(), agent({ passport_pubkey: PUBKEY_B, name: "later" })] });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.complete).toBe(false);
    expect(body.data.agents.created).toEqual(["billing-bot"]);
    expect(body.data.agents.rejected).toEqual([{ name: "later", reason: "write_failed" }]);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ created: 1, complete: false }),
    }));
  });

  it("accepts a full export file's workspace block unchanged", async () => {
    const body = await (
      await post({ workspace: { agents: [agent()], providerMappings: [{ id: "x" }] } }, "?dry_run=true")
    ).json();
    expect(body.data.agents.create).toBe(1);
  });

  // Reading a credential list is not importing it, but the row must never be
  // written — this asserts the absence at runtime, not by grepping the source.
  it("writes no provider credential even when the file carries them", async () => {
    await post({ workspace: { agents: [], providerMappings: [{ id: "x", provider: "anthropic" }] } });
    expect(inserts.some((i) => i.table === "provider_credentials")).toBe(false);
  });

  it("restores an ownership claim unverified, and skips one that exists", async () => {
    await post({ agents: [], ownership: { kind: "domain", subject: "example.com", tier: "domain" } });
    const row = inserts.find((i) => i.table === "agent_owners")?.row ?? {};
    expect(row).toMatchObject({ kind: "domain", subject: "example.com", user_id: "u1" });
    expect(row).not.toHaveProperty("tier");

    inserts.length = 0;
    ownerRow.value = { user_id: "u1" };
    const body = await (await post({ agents: [], ownership: { kind: "domain", subject: "other.com" } })).json();
    expect(body.data.ownership).toBe("skip");
    expect(inserts).toHaveLength(0);
  });
});
