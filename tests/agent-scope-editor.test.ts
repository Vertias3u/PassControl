// The scope editor changes what an agent is permitted to call, so it is
// security-touching: these tests come first. They cover the three things that
// would be expensive to get wrong — whose agent gets edited, what the audit row
// can answer afterwards, and whether the UI tells the truth about when the
// change takes effect.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { suspendAgent, unsuspendAgent, purgeAgentCaches, armTenantKill } = vi.hoisted(() => ({
  suspendAgent: vi.fn(async () => {}),
  unsuspendAgent: vi.fn(async () => {}),
  purgeAgentCaches: vi.fn(async () => {}),
  armTenantKill: vi.fn(async () => {}),
}));
vi.mock("@/lib/state/redis", () => ({ suspendAgent, unsuspendAgent, purgeAgentCaches }));
vi.mock("@/lib/state/killswitch", () => ({ armTenantKill }));

import { updateAgent } from "@/lib/fleet";
import { validateAgentUpdate } from "@/lib/validate";
import { visaTtlSeconds } from "@/lib/auth/visa";
import { toScopeRows, describeDelay, parseModels } from "@/lib/scope-rows";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

function makeDb(result: { data: unknown; error: unknown }) {
  const calls = { update: null as any, eq: [] as [string, unknown][] };
  const chain: any = {
    from: () => chain,
    update: (payload: unknown) => {
      calls.update = payload;
      return chain;
    },
    eq: (col: string, val: unknown) => {
      calls.eq.push([col, val]);
      return chain;
    },
    select: () => chain,
    maybeSingle: async () => result,
  };
  return { db: chain, calls };
}

describe("scope updates are tenant-scoped", () => {
  it("filters on the acting user, not just the agent id", async () => {
    // The failure this pins: an edit that filtered on `id` alone would let a
    // crafted call repoint a scope widening at another tenant's agent.
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null });
    const r = await updateAgent(db as any, "u1", "a1", {
      scopes: [{ provider: "anthropic", models: ["claude-*"] }],
    });
    expect(r).toEqual({ ok: true, value: { id: "a1" } });
    expect(calls.eq).toContainEqual(["user_id", "u1"]);
    expect(calls.eq).toContainEqual(["id", "a1"]);
  });

  it("writes allowed_scopes and touches nothing else", async () => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null });
    await updateAgent(db as any, "u1", "a1", {
      scopes: [{ provider: "anthropic", models: ["claude-opus-5"] }],
    });
    expect(calls.update).toEqual({
      allowed_scopes: [{ provider: "anthropic", models: ["claude-opus-5"] }],
    });
    expect(Object.keys(calls.update)).toEqual(["allowed_scopes"]);
  });

  it("404s rather than silently succeeding on someone else's agent", async () => {
    const { db } = makeDb({ data: null, error: null });
    expect(
      await updateAgent(db as any, "u1", "not-mine", {
        scopes: [{ provider: "anthropic", models: ["*"] }],
      })
    ).toMatchObject({ ok: false, status: 404 });
  });
});

describe("scope validation the editor must not be able to bypass", () => {
  it("rejects an unknown provider", () => {
    expect(() => validateAgentUpdate({ scopes: [{ provider: "not-a-provider", models: ["*"] }] })).toThrow(
      /Unknown provider/
    );
  });

  it("accepts an empty scope list — an agent that can reach nothing is a real state", () => {
    // Deliberate: removing every scope is a legitimate way to park an agent.
    // The editor must therefore WARN rather than rely on validation to stop it.
    expect(validateAgentUpdate({ scopes: [] })).toEqual({ allowed_scopes: [] });
  });

  it("preserves multiple provider entries", () => {
    // The issuance modal only ever writes one entry; an editor built on that
    // assumption would drop the second on save.
    const patch = validateAgentUpdate({
      scopes: [
        { provider: "anthropic", models: ["claude-*"] },
        { provider: "openai", models: ["gpt-4o"] },
      ],
    });
    expect(patch.allowed_scopes).toHaveLength(2);
    expect(patch.allowed_scopes?.[1]).toEqual({ provider: "openai", models: ["gpt-4o"] });
  });
});

describe("visaTtlSeconds is the source of truth for the delay copy", () => {
  const original = process.env.VISA_TTL_SECONDS;
  beforeEach(() => {
    delete process.env.VISA_TTL_SECONDS;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.VISA_TTL_SECONDS;
    else process.env.VISA_TTL_SECONDS = original;
  });

  it("defaults to 300 and clamps to [300, 900]", () => {
    expect(visaTtlSeconds()).toBe(300);
    process.env.VISA_TTL_SECONDS = "900";
    expect(visaTtlSeconds()).toBe(900);
    process.env.VISA_TTL_SECONDS = "60";
    expect(visaTtlSeconds()).toBe(300);
    process.env.VISA_TTL_SECONDS = "99999";
    expect(visaTtlSeconds()).toBe(900);
    process.env.VISA_TTL_SECONDS = "nonsense";
    expect(visaTtlSeconds()).toBe(300);
  });
});

describe("the editor UI", () => {
  const editor = read("components/ScopeEditor.tsx");
  const actions = read("app/dashboard/actions.ts");

  it("derives the acting user from the session, never from an argument", () => {
    // The whole tenant boundary rests on this. An action taking a userId
    // parameter would let the caller choose whose agent to edit.
    const fn = actions.slice(actions.indexOf("export async function updateAgentScopes"));
    const signature = fn.slice(0, fn.indexOf(")"));
    expect(signature).not.toMatch(/userId/);
    expect(fn).toMatch(/await requireUser\(\)/);
  });

  it("records what the scope changed FROM, not just that it changed", () => {
    // `fields: "allowed_scopes"` cannot answer "did someone widen this agent to
    // `*`" six weeks later. This is also the metadata capability-change history
    // needs.
    const fn = actions.slice(actions.indexOf("export async function updateAgentScopes"));
    expect(fn).toMatch(/from:/);
    expect(fn).toMatch(/to:/);
  });

  it("revalidates the agent's own page, not just the fleet root", () => {
    // The editor lives on /dashboard/agents/[id]; revalidating "/" alone would
    // leave the scope the operator just changed still on screen.
    const fn = actions.slice(actions.indexOf("export async function updateAgentScopes"));
    expect(fn).toMatch(/revalidatePath\(`\/dashboard\/agents\/\$\{agentId\}`\)/);
  });

  it("never hardcodes how long the change takes to bite", () => {
    // VISA_TTL_SECONDS is env-tunable to 900. "within 5 minutes" is simply
    // false on such a deployment, and this is the one screen where an operator
    // is relying on that number during an incident.
    expect(editor).not.toMatch(/5 minutes|five minutes|300 seconds/i);
    expect(editor).toMatch(/ttlSeconds/);
  });

  it("warns before saving a scope list that leaves the agent unable to call anything", () => {
    expect(editor).toMatch(/reach nothing/i);
  });

  it("is reachable from the fleet table, not only the passport page", () => {
    // Scope sits beside budgets and suspend as a thing you change about an
    // agent; requiring a page hop to reach it is why it went unnoticed as
    // uneditable for so long.
    const fleet = read("components/AgentFleetTable.tsx");
    expect(fleet).toMatch(/<ScopeEditor/);
    // The editor must be fed the stored scopes of the agent it names. The row
    // being edited is looked up BY ID, never by position: an index into a list
    // this component sorts and filters would open the same off-by-one that once
    // showed a forged receipt's verdict against the row above it. Assert the
    // lookup, not the variable name — renaming the variable must not be able to
    // turn this back into an index.
    expect(fleet).toMatch(/agents\.find\(\(agent\) => agent\.id === editing\.id\)/);
    expect(fleet).toMatch(/scopes=\{toScopeRows\(editedAgent\.allowed_scopes\)\}/);
    expect(fleet).toMatch(/agentId=\{editedAgent\.id\}/);
  });

  it("passes the real TTL from the server at both call sites", () => {
    // A client component cannot read process.env, so a forgotten prop here
    // would render the delay as undefined rather than fail loudly.
    expect(read("app/dashboard/page.tsx")).toMatch(/visaTtlSeconds=\{visaTtlSeconds\(\)\}/);
    expect(read("app/dashboard/agents/[id]/page.tsx")).toMatch(/visaTtlSeconds=\{visaTtlSeconds\(\)\}/);
  });
});

describe("toScopeRows", () => {
  it("keeps well-formed entries and drops junk without throwing", () => {
    // The column is jsonb: it can hold anything a past migration or a hand
    // edit left there, and the editor must not crash on it.
    expect(toScopeRows([{ provider: "anthropic", models: ["claude-*"] }])).toEqual([
      { provider: "anthropic", models: ["claude-*"] },
    ]);
    expect(toScopeRows(null)).toEqual([]);
    expect(toScopeRows("not-an-array")).toEqual([]);
    expect(toScopeRows([null, 42, { models: ["x"] }, { provider: "" }])).toEqual([]);
    expect(toScopeRows([{ provider: "openai", models: [1, "gpt-4o", null] }])).toEqual([
      { provider: "openai", models: ["gpt-4o"] },
    ]);
  });
});
