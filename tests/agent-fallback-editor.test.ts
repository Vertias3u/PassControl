// The write path for provider failover. A fallback list decides which OTHER
// provider's key gets spent when the first one fails, so it is money-touching
// and these tests come before the code.
//
// Three failures they exist to catch, all of which are silent:
//
//  1. A list saved against someone else's agent, or written to a column the
//     `authenticated` role may not update.
//  2. A list the operator saves, the editor reads back, and the gateway honours
//     none of — because the page never loaded the column, or the cache still
//     holds the old value, or validate accepted what parseFallbacks refuses.
//  3. Copy that promises the wrong delay. Scope changes wait out a visa; a
//     fallback change waits out a 60-second cache. Reusing ScopeEditor's
//     paragraph would tell an operator "up to 15 minutes" during an incident.
import { describe, it, expect, vi } from "vitest";
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
import { outOfScope, toFallbackRows } from "@/lib/fallback-rows";

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

describe("fallback updates are tenant-scoped", () => {
  it("filters on the acting user, not just the agent id", async () => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null });
    const r = await updateAgent(db as any, "u1", "a1", {
      fallbacks: [{ provider: "groq", model: "llama-3.3-70b" }],
    });
    expect(r).toEqual({ ok: true, value: { id: "a1" } });
    expect(calls.eq).toContainEqual(["user_id", "u1"]);
    expect(calls.eq).toContainEqual(["id", "a1"]);
  });

  it("writes the fallbacks column and touches nothing else", async () => {
    // Migration 0018 grants UPDATE on exactly this one column. A patch that
    // carried a second key would be refused by Postgres for the whole
    // statement, so the operator would see the save fail with nothing useful.
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null });
    await updateAgent(db as any, "u1", "a1", {
      fallbacks: [{ provider: "groq", model: "llama-3.3-70b" }],
    });
    expect(Object.keys(calls.update)).toEqual(["fallbacks"]);
    expect(calls.update).toEqual({ fallbacks: [{ provider: "groq", model: "llama-3.3-70b" }] });
  });

  it("lets an operator clear the list — that is how failover is turned off", async () => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null });
    const r = await updateAgent(db as any, "u1", "a1", { fallbacks: [] });
    expect(r.ok).toBe(true);
    expect(calls.update).toEqual({ fallbacks: [] });
  });

  it("404s rather than silently succeeding on someone else's agent", async () => {
    const { db } = makeDb({ data: null, error: null });
    expect(
      await updateAgent(db as any, "u1", "not-mine", {
        fallbacks: [{ provider: "groq", model: "llama-3.3-70b" }],
      })
    ).toMatchObject({ ok: false, status: 404 });
  });

  it("422s on a list the gateway would refuse, rather than storing it", async () => {
    const { db, calls } = makeDb({ data: { id: "a1" }, error: null });
    const r = await updateAgent(db as any, "u1", "a1", {
      fallbacks: [{ provider: "not-a-provider", model: "x" }],
    });
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(calls.update).toBeNull();
  });
});

describe("the server action", () => {
  const actions = read("app/dashboard/actions.ts");
  const fn = actions.slice(actions.indexOf("export async function updateAgentFallbacks"));

  it("exists", () => {
    expect(actions).toMatch(/export async function updateAgentFallbacks/);
  });

  it("derives the acting user from the session, never from an argument", () => {
    const signature = fn.slice(0, fn.indexOf(")"));
    expect(signature).not.toMatch(/userId/);
    expect(fn).toMatch(/await requireUser\(\)/);
  });

  it("records what the list changed FROM, not just that it changed", () => {
    expect(fn).toMatch(/from:/);
    expect(fn).toMatch(/to:/);
  });

  // The one that matters most. The gateway caches this column for 60 seconds,
  // and the direction that hurts is REMOVAL: an operator taking a provider off
  // the list is usually doing it because calls must stop going there. Without a
  // purge they keep going for another minute.
  it("purges the gateway's cache so a removal takes effect now", () => {
    expect(fn).toMatch(/purgeAgentFallbacks\(/);
  });

  it("revalidates the agent's own page, not just the fleet root", () => {
    expect(fn).toMatch(/revalidatePath\(`\/dashboard\/agents\/\$\{agentId\}`\)/);
  });
});

describe("the editor UI", () => {
  const editor = read("components/FallbackEditor.tsx");

  it("warns that a fallback outside the agent's scope never fires", () => {
    // Every attempt is re-checked against the visa's scope, so a fallback the
    // agent may not call is configuration that silently does nothing. Warn,
    // do not block: adding the scope afterwards is a legitimate order of work.
    expect(editor).toMatch(/scope/i);
    expect(editor).toMatch(/data-state="out-of-scope"/);
  });

  it("does not reuse the visa-TTL delay copy", () => {
    // A fallback list is read live with a 60s cache, NOT carried in the visa.
    // ScopeEditor's paragraph would promise a delay an order of magnitude too
    // long on a deployment with VISA_TTL_SECONDS=900.
    expect(editor).not.toMatch(/ttlSeconds|next visa/);
  });

  it("says the list is tried in order", () => {
    expect(editor).toMatch(/in order|order shown|first to last/i);
  });

  it("is on the agent's passport page", () => {
    expect(read("components/AgentPassport.tsx")).toMatch(/<FallbackEditor/);
  });
});

describe("the page actually loads the column", () => {
  // Without this the editor initialises empty on every render: the operator
  // saves a list, reloads, sees nothing, and saves again over the top of it.
  const data = read("app/dashboard/agents/[id]/passport-data.ts");

  it("selects fallbacks", () => {
    expect(data.slice(0, data.indexOf("const PASSPORT_LOG_COLUMNS"))).toMatch(/fallbacks/);
  });

  it("carries them onto the view the page renders", () => {
    expect(data).toMatch(/fallbacks: toFallbackRows\(/);
  });
});

describe("toFallbackRows", () => {
  it("keeps well-formed entries and drops junk without throwing", () => {
    // jsonb: the column can hold whatever a hand edit or a direct PATCH left
    // there, and the editor must render rather than crash. Deliberately more
    // forgiving than parseFallbacks — this is for DISPLAY, and showing an
    // operator the malformed entry they need to fix beats showing them nothing.
    expect(toFallbackRows([{ provider: "groq", model: "llama-3.3-70b" }])).toEqual([
      { provider: "groq", model: "llama-3.3-70b" },
    ]);
    expect(toFallbackRows(null)).toEqual([]);
    expect(toFallbackRows("not-an-array")).toEqual([]);
    expect(toFallbackRows([null, 42, { model: "x" }, { provider: "" }])).toEqual([]);
    expect(toFallbackRows([{ provider: "groq", model: 7 }])).toEqual([]);
  });

  it("never renders more rows than the gateway would honour", () => {
    const tooMany = Array.from({ length: 9 }, () => ({ provider: "groq", model: "llama-3.3-70b" }));
    expect(toFallbackRows(tooMany).length).toBeLessThanOrEqual(3);
  });
});

describe("outOfScope", () => {
  const scopes = [
    { provider: "anthropic", models: ["claude-*"] },
    { provider: "groq", models: ["llama-3.3-70b"] },
  ];

  it("flags a provider the agent cannot reach at all", () => {
    expect(outOfScope([{ provider: "mistral", model: "mistral-large-latest" }], scopes)).toEqual([
      { provider: "mistral", model: "mistral-large-latest" },
    ]);
  });

  it("flags a model outside the provider's patterns", () => {
    expect(outOfScope([{ provider: "groq", model: "llama-3.1-8b" }], scopes)).toHaveLength(1);
  });

  it("clears an exact match and a prefix match", () => {
    expect(
      outOfScope(
        [
          { provider: "groq", model: "llama-3.3-70b" },
          { provider: "anthropic", model: "claude-opus-5" },
        ],
        scopes
      )
    ).toEqual([]);
  });

  it("flags everything when the agent has no scopes at all", () => {
    expect(outOfScope([{ provider: "groq", model: "llama-3.3-70b" }], [])).toHaveLength(1);
  });
});
