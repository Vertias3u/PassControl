// F1 (plans/tonight-2026-10-09.md): a new agent made from the dashboard carries
// a hard spending limit unless its owner explicitly removes it.
//
// What is pinned here, and why each piece matters:
//
// - The default is $20 a day (owner, 2026-10-10), applied as the K1 periodic
//   limit the gate already enforces. No new accounting.
// - It applies to the dashboard's two forms and the key-import on-ramp (both
//   passport and Direct Agent Key). The control API, the CLI and workspace
//   import are UNCHANGED: a script that creates agents today must get exactly
//   what it got yesterday. So the default lives in the dashboard actions, and
//   lib/fleet stays a pass-through that never invents a limit.
// - Removing it is an explicit `removeSpendingLimit: true`, never the absence of
//   a field: an old bundle or a hand-built action call that sends nothing gets
//   the limit. The removal is audited in its own row, in the owner's words.
// - An agent scoped only to providers that cannot be priced (local, azure) or to
//   no model at all is exempt: under any dollar limit the gateway refuses those
//   calls as unpriced, so a blanket default would break every Ollama agent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PASSPORT_ID = randomBytes(32).toString("base64url");

const m = vi.hoisted(() => {
  let sealed = "";
  const stash = new Map<string, string>();
  const credentialQuery = {
    select: () => credentialQuery,
    eq: () => credentialQuery,
    limit: async () => ({ data: [{ provider: "anthropic" }, { provider: "local" }, { provider: "azure" }], error: null }),
  };
  return {
    stash,
    db: {
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "tenant-a", email: "a@example.test" } } })) },
      from: vi.fn(() => credentialQuery),
    },
    serviceDb: {
      rpc: vi.fn(async () => ({ data: null, error: null })),
      from: vi.fn(() => ({ upsert: () => ({ select: async () => ({ data: [{ id: "tenant-a" }], error: null }) }) })),
    },
    createAgent: vi.fn(async (_db: unknown, _userId: string, input: { name: string }, _options?: unknown) => ({
      ok: true as const,
      value: { id: "agent-1", name: input.name, createdAt: "2026-10-10T00:00:00Z", expiresAt: null },
    })),
    createDirectAgent: vi.fn(async (_db: unknown, _userId: string, input: { name: string; keyName: string }, _options?: unknown) => ({
      ok: true as const,
      value: { agentId: "agent-2", keyId: "key-1", key: `pc_agent_${"K".repeat(43)}`, name: input.name, keyName: input.keyName, expiresAt: null },
    })),
    recordAdminAction: vi.fn(async (_row: { action: string; metadata?: Record<string, unknown> }) => undefined),
    seal: vi.fn(async (plaintext: string) => {
      sealed = plaintext;
      return "opaque";
    }),
    open: vi.fn(async () => sealed),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => m.db }));
vi.mock("@/lib/supabase", () => ({ serviceClient: vi.fn(() => m.serviceDb) }));
vi.mock("@/lib/mfa", () => ({ mfaAuthorizedUser: vi.fn(async () => ({ ok: true, user: { id: "tenant-a" } })) }));
vi.mock("@/lib/profile/manage", () => ({ ensureProfileRow: vi.fn(async () => undefined) }));
vi.mock("@/lib/fleet", () => ({
  createAgent: m.createAgent,
  createDirectAgent: m.createDirectAgent,
  setTenantKill: vi.fn(),
  setAgentSuspended: vi.fn(),
  updateAgent: vi.fn(),
}));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: vi.fn(async () => ({ success: true, remaining: 4 })),
  rateLimitFailClosed: vi.fn(async () => ({ success: true, remaining: 4 })),
}));
vi.mock("@/lib/crypto/aesgcm", () => ({ seal: m.seal, open: m.open }));
vi.mock("@/lib/state/redis", () => ({
  stashKeyImport: vi.fn(async (userId: string, id: string, value: string) => {
    m.stash.set(`${userId}:${id}`, value);
  }),
  takeKeyImport: vi.fn(async (userId: string, id: string) => {
    const value = m.stash.get(`${userId}:${id}`) ?? null;
    m.stash.delete(`${userId}:${id}`);
    return value;
  }),
  purgeProviderKeysCache: vi.fn(async () => {}),
  purgeAgentCaches: vi.fn(async () => {}),
  purgeAgentFallbacks: vi.fn(async () => {}),
}));
vi.mock("@/lib/audit", () => ({ recordAdminAction: m.recordAdminAction }));
vi.mock("@/lib/seclog", () => ({ logSecurityEvent: vi.fn() }));
vi.mock("@/lib/alert", () => ({ dispatchSecurityAlert: vi.fn() }));
vi.mock("@/lib/apikeys", () => ({ generateApiKey: vi.fn() }));
vi.mock("@/lib/agent-capacity", () => ({ agentCreationRefusal: vi.fn(async () => null) }));

import {
  DEFAULT_DAILY_LIMIT_CENTS,
  REMOVE_SPENDING_LIMIT_STATEMENT,
  isDefaultDailyLimit,
  resolveDefaultDailyLimitCents,
  resolveNewAgentSpendLimit,
  scopesNeedDollarLimit,
  spendLimitChoiceFromForm,
} from "@/lib/new-agent-spend-limit";
import {
  completeKeyImport,
  completeKeyImportDirect,
  createAgent,
  issueDirectAgent,
  probeProviderKey,
} from "@/app/dashboard/actions-client";

const ANTHROPIC = [{ provider: "anthropic", models: ["claude-*"] }];
const DAY_20 = { budget_period: "day", budget_period_cents: 2000 };
const NO_PERIOD = { budget_period: null, budget_period_cents: null };

beforeEach(() => {
  vi.clearAllMocks();
  m.stash.clear();
  delete process.env.DEFAULT_AGENT_DAILY_LIMIT_USD;
});

describe("the default, as a value", () => {
  it("is $20 a day", () => {
    expect(DEFAULT_DAILY_LIMIT_CENTS).toBe(2000);
    expect(resolveDefaultDailyLimitCents(undefined)).toBe(2000);
    expect(resolveDefaultDailyLimitCents("")).toBe(2000);
  });

  it("can be set in dollars, or turned off, by the deployment", () => {
    expect(resolveDefaultDailyLimitCents("20")).toBe(2000);
    expect(resolveDefaultDailyLimitCents(" 12.50 ")).toBe(1250);
    expect(resolveDefaultDailyLimitCents("off")).toBeNull();
    expect(resolveDefaultDailyLimitCents("OFF")).toBeNull();
    expect(resolveDefaultDailyLimitCents("0")).toBeNull();
  });

  it("keeps the safe default when the setting is unreadable", () => {
    for (const raw of ["banana", "-3", "1e9", "20.555", "$20"]) {
      expect(resolveDefaultDailyLimitCents(raw)).toBe(2000);
    }
  });

  it("names a limit as the default only when it is the default amount, per day", () => {
    expect(isDefaultDailyLimit("day", 2000, 2000)).toBe(true);
    expect(isDefaultDailyLimit("day", 1999, 2000)).toBe(false);
    expect(isDefaultDailyLimit("month", 2000, 2000)).toBe(false);
    expect(isDefaultDailyLimit("day", 2000, null)).toBe(false);
    expect(isDefaultDailyLimit(null, null, 2000)).toBe(false);
  });
});

describe("which new agents need a dollar limit", () => {
  it.each([
    ["no model at all (services only)", [], false],
    ["only a local model server", [{ provider: "local", models: ["*"] }], false],
    ["only Azure (a deployment name is never priced)", [{ provider: "azure", models: ["*"] }], false],
    ["only local and Azure", [{ provider: "local", models: ["*"] }, { provider: "azure", models: ["*"] }], false],
    ["a priced provider", ANTHROPIC, true],
    ["a priced provider beside a local one", [{ provider: "local", models: ["*"] }, ...ANTHROPIC], true],
    ["the keyless demo provider, which is priced", [{ provider: "demo", models: ["*"] }], true],
  ])("%s → %s", (_label, scopes, expected) => {
    expect(scopesNeedDollarLimit(scopes)).toBe(expected);
  });
});

describe("resolveNewAgentSpendLimit", () => {
  it("applies the default when the form sends nothing", () => {
    expect(resolveNewAgentSpendLimit(ANTHROPIC, {}, 2000)).toEqual({ source: "default", ...DAY_20 });
    expect(resolveNewAgentSpendLimit(ANTHROPIC, { dailyLimitCents: null }, 2000)).toEqual({ source: "default", ...DAY_20 });
  });

  it("records the prefilled amount, left as it was, as the default", () => {
    expect(resolveNewAgentSpendLimit(ANTHROPIC, { dailyLimitCents: 2000 }, 2000)).toEqual({ source: "default", ...DAY_20 });
  });

  it("takes an owner's own daily amount", () => {
    expect(resolveNewAgentSpendLimit(ANTHROPIC, { dailyLimitCents: 500 }, 2000)).toEqual({
      source: "custom",
      budget_period: "day",
      budget_period_cents: 500,
    });
  });

  it("removes the limit only on an explicit true", () => {
    expect(resolveNewAgentSpendLimit(ANTHROPIC, { removeSpendingLimit: true }, 2000)).toEqual({ source: "removed", ...NO_PERIOD });
    for (const notTrue of ["true", 1, "yes", {}, null, false]) {
      expect(resolveNewAgentSpendLimit(ANTHROPIC, { removeSpendingLimit: notTrue }, 2000).source).toBe("default");
    }
  });

  it.each([0, -1, 1.5, "500", Number.NaN, 2_147_483_648])("refuses a daily amount of %s", (cents) => {
    expect(() => resolveNewAgentSpendLimit(ANTHROPIC, { dailyLimitCents: cents }, 2000)).toThrow(/daily/i);
  });

  it("exempts an agent that cannot be priced, whatever the form sent", () => {
    const local = [{ provider: "local", models: ["*"] }];
    expect(resolveNewAgentSpendLimit(local, {}, 2000)).toEqual({ source: "exempt", ...NO_PERIOD });
    expect(resolveNewAgentSpendLimit(local, { dailyLimitCents: 500 }, 2000)).toEqual({ source: "exempt", ...NO_PERIOD });
    expect(resolveNewAgentSpendLimit(local, { removeSpendingLimit: true }, 2000)).toEqual({ source: "exempt", ...NO_PERIOD });
    expect(resolveNewAgentSpendLimit([], {}, 2000)).toEqual({ source: "exempt", ...NO_PERIOD });
  });

  it("creates no limit when the deployment turned the default off, unless the owner set one", () => {
    expect(resolveNewAgentSpendLimit(ANTHROPIC, {}, null)).toEqual({ source: "off", ...NO_PERIOD });
    expect(resolveNewAgentSpendLimit(ANTHROPIC, { dailyLimitCents: 500 }, null)).toMatchObject({ source: "custom", budget_period_cents: 500 });
  });
});

describe("what a form sends", () => {
  it("sends the amount it shows, in cents", () => {
    expect(spendLimitChoiceFromForm({ usd: "20", removed: false }, 2000)).toEqual({ dailyLimitCents: 2000 });
    expect(spendLimitChoiceFromForm({ usd: " 7.5 ", removed: false }, 2000)).toEqual({ dailyLimitCents: 750 });
  });

  it("sends the removal only when the box is ticked, whatever the field says", () => {
    expect(spendLimitChoiceFromForm({ usd: "20", removed: true }, 2000)).toEqual({ removeSpendingLimit: true });
    expect(spendLimitChoiceFromForm({ usd: "", removed: true }, 2000)).toEqual({ removeSpendingLimit: true });
  });

  it("does not read a cleared field as a removal", () => {
    expect(() => spendLimitChoiceFromForm({ usd: "", removed: false }, 2000)).toThrow(/Remove the spending limit/);
    expect(() => spendLimitChoiceFromForm({ usd: "0", removed: false }, 2000)).toThrow(/daily/i);
    expect(() => spendLimitChoiceFromForm({ usd: "abc", removed: false }, 2000)).toThrow();
  });

  it("sends nothing for a blank field where the deployment has no default", () => {
    expect(spendLimitChoiceFromForm({ usd: "", removed: false }, null)).toEqual({});
    expect(spendLimitChoiceFromForm({ usd: "5", removed: false }, null)).toEqual({ dailyLimitCents: 500 });
  });
});

function periodPassedTo(mock: { mock: { calls: unknown[][] } }) {
  return (mock.mock.calls[0]?.[3] as { period?: unknown } | undefined)?.period;
}
function auditActions() {
  return m.recordAdminAction.mock.calls.map((call) => call[0]);
}

describe("the dashboard's passport form", () => {
  const form = { name: "bot", passportPubkey: PASSPORT_ID, scopes: ANTHROPIC };

  it("creates the agent with $20 a day when nothing is said", async () => {
    await createAgent(form);
    expect(periodPassedTo(m.createAgent)).toEqual(DAY_20);
    const create = auditActions().find((row) => row.action === "agent.create");
    expect(create?.metadata).toMatchObject({ spending_limit: "default", daily_limit_cents: 2000 });
  });

  it("removes it only when the box is ticked, and audits that as a choice", async () => {
    await createAgent({ ...form, removeSpendingLimit: true });
    expect(periodPassedTo(m.createAgent)).toEqual(NO_PERIOD);
    const removed = auditActions().find((row) => row.action === "agent.spending_limit_removed");
    expect(removed).toMatchObject({
      targetType: "agent",
      targetId: "agent-1",
      metadata: { statement: REMOVE_SPENDING_LIMIT_STATEMENT, via: "dashboard" },
    });
    expect(REMOVE_SPENDING_LIMIT_STATEMENT).toBe(
      "Remove the spending limit. Calls will not be refused past it, and I am responsible for the charges."
    );
  });

  it("refuses a bad amount before anything is created", async () => {
    await expect(createAgent({ ...form, dailyLimitCents: 0 })).rejects.toThrow(/daily/i);
    expect(m.createAgent).not.toHaveBeenCalled();
  });

  it("follows the deployment's setting", async () => {
    process.env.DEFAULT_AGENT_DAILY_LIMIT_USD = "off";
    await createAgent(form);
    expect(periodPassedTo(m.createAgent)).toEqual(NO_PERIOD);
    expect(auditActions().some((row) => row.action === "agent.spending_limit_removed")).toBe(false);
  });
});

describe("the dashboard's Direct Agent Key form", () => {
  const form = { name: "worker", keyName: "laptop", scopes: ANTHROPIC };

  it("creates the agent with $20 a day when nothing is said", async () => {
    await issueDirectAgent(form);
    expect(periodPassedTo(m.createDirectAgent)).toEqual(DAY_20);
  });

  it("takes the owner's own amount", async () => {
    await issueDirectAgent({ ...form, dailyLimitCents: 750 });
    expect(periodPassedTo(m.createDirectAgent)).toEqual({ budget_period: "day", budget_period_cents: 750 });
  });

  it("leaves a local-model worker without a dollar limit, which would refuse its every call", async () => {
    await issueDirectAgent({ ...form, scopes: [{ provider: "local", models: ["*"] }] });
    expect(periodPassedTo(m.createDirectAgent)).toEqual(NO_PERIOD);
    const create = auditActions().find((row) => row.action === "agent.create");
    expect(create?.metadata).toMatchObject({ spending_limit: "exempt" });
  });

  it("removes it only when the box is ticked, and audits that", async () => {
    await issueDirectAgent({ ...form, removeSpendingLimit: true });
    expect(periodPassedTo(m.createDirectAgent)).toEqual(NO_PERIOD);
    expect(auditActions().find((row) => row.action === "agent.spending_limit_removed")).toMatchObject({
      targetId: "agent-2",
      metadata: { statement: REMOVE_SPENDING_LIMIT_STATEMENT },
    });
  });
});

describe("the key-import on-ramp", () => {
  async function handoff() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "claude-a" }] }), { status: 200 }))
    );
    const probed = await probeProviderKey({ provider: "anthropic", key: "sk-ant-api03-secret" });
    if (!probed.ok) throw new Error("expected a probe handoff");
    return probed.handoff;
  }

  it("gives an imported passport agent $20 a day", async () => {
    await completeKeyImport({
      handoff: await handoff(),
      provider: "anthropic",
      label: "imported",
      name: "Imported agent",
      passportPubkey: PASSPORT_ID,
      models: ["claude-a"],
    });
    expect(periodPassedTo(m.createAgent)).toEqual(DAY_20);
  });

  it("gives an imported Direct Agent Key worker $20 a day (the default on-ramp)", async () => {
    await completeKeyImportDirect({
      handoff: await handoff(),
      provider: "anthropic",
      label: "imported",
      name: "Imported worker",
      keyName: "laptop",
      models: ["claude-a"],
    });
    expect(periodPassedTo(m.createDirectAgent)).toEqual(DAY_20);
  });

  it("lets the on-ramp remove it with the same explicit choice", async () => {
    await completeKeyImportDirect({
      handoff: await handoff(),
      provider: "anthropic",
      label: "imported",
      name: "Imported worker",
      keyName: "laptop",
      models: ["claude-a"],
      removeSpendingLimit: true,
    });
    expect(periodPassedTo(m.createDirectAgent)).toEqual(NO_PERIOD);
    expect(auditActions().some((row) => row.action === "agent.spending_limit_removed")).toBe(true);
  });

  it("refuses a bad amount before the handoff is spent or a key stored", async () => {
    const id = await handoff();
    await expect(
      completeKeyImportDirect({
        handoff: id,
        provider: "anthropic",
        label: "imported",
        name: "Imported worker",
        keyName: "laptop",
        models: ["claude-a"],
        dailyLimitCents: -5,
      })
    ).rejects.toThrow(/daily/i);
    expect(m.serviceDb.rpc).not.toHaveBeenCalledWith("store_provider_key_for_user", expect.anything());
    expect(m.stash.size).toBe(1);
  });
});

describe("paths that stay exactly as they were", () => {
  const root = resolve(__dirname, "..");

  it("the control API (and so the CLI) creates through fleet with no limit of its own", () => {
    const route = readFileSync(resolve(root, "app/api/control/v1/agents/route.ts"), "utf8");
    expect(route).toContain("createAgent(db, userId, parsed.body)");
    expect(route).not.toMatch(/new-agent-spend-limit|DEFAULT_DAILY_LIMIT/);
  });

  it("workspace import restores budgets as exported, without the default", () => {
    const route = readFileSync(resolve(root, "app/api/control/v1/workspace/import/route.ts"), "utf8");
    expect(route).not.toMatch(/new-agent-spend-limit|DEFAULT_DAILY_LIMIT/);
  });
});
