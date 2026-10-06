// "Connect an agent" can grant service access at creation (owner's call,
// 2026-10-05: a new user who stored a Telegram token did not know an agent
// needs rules too). The choices are visible and pre-ticked in the wizard, not
// a silent default: an agent created without them still has no access.
//
// Two halves: the pure translation of the wizard's ticks into a stored rule
// document (validated by the gateway's own parser), and the action, which
// refuses bad choices BEFORE creating anything, and never loses the
// reveal-once key over a failed rules write.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { WIZARD_SERVICE_DEFAULTS, wizardServiceRules } from "@/lib/services/presets";
import { parseServiceRules } from "@/lib/services/rules";

describe("the wizard's service choices, as stored rules", () => {
  it("defaults Telegram to read and send, asking before each send", () => {
    expect(WIZARD_SERVICE_DEFAULTS.telegram).toEqual({ checked: ["read", "send"], askWrites: true });
    const result = wizardServiceRules([{ service: "telegram", checked: ["read", "send"], askWrites: true }]);
    expect(result).toEqual({
      ok: true,
      granted: ["telegram"],
      document: {
        telegram: { allow: [{ call: "getMe" }, { call: "getUpdates" }, { call: "sendMessage", ask: true }] },
      },
    });
    const parsed = parseServiceRules(result.ok ? result.document : null, "telegram");
    expect(parsed.kind).toBe("rules");
  });

  it("stores nothing for a service with nothing ticked, or no choices at all", () => {
    expect(wizardServiceRules([{ service: "telegram", checked: [], askWrites: true }])).toEqual({
      ok: true,
      granted: [],
      document: null,
    });
    expect(wizardServiceRules(undefined)).toEqual({ ok: true, granted: [], document: null });
  });

  it.each([
    ["an unknown service", [{ service: "slack", checked: ["send"], askWrites: false }]],
    ["a service the wizard does not offer (needs a repository)", [{ service: "github", checked: ["read"], askWrites: false }]],
    ["an unknown choice", [{ service: "telegram", checked: ["delete-everything"], askWrites: false }]],
    ["a malformed list", "telegram"],
  ])("refuses %s", (_name, choices) => {
    expect(wizardServiceRules(choices).ok).toBe(false);
  });
});

const m = vi.hoisted(() => {
  const updates: { values: Record<string, unknown>; filters: [string, unknown][] }[] = [];
  const state = { updateError: null as null | { code: string } };
  const credentialQuery = {
    select: () => credentialQuery,
    eq: () => credentialQuery,
    limit: async () => ({ data: [{ provider: "openai" }], error: null }),
  };
  const serviceFrom = (table: string) => {
    const filters: [string, unknown][] = [];
    let values: Record<string, unknown> = {};
    const chain = {
      update: (v: Record<string, unknown>) => {
        values = v;
        return chain;
      },
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return chain;
      },
      select: async () => {
        updates.push({ values, filters: [...filters] });
        return state.updateError ? { data: null, error: state.updateError } : { data: [{ id: "agent-1" }], error: null };
      },
    };
    if (table !== "agents") throw new Error(`unexpected table ${table}`);
    return chain;
  };
  return {
    updates,
    state,
    db: {
      auth: { getUser: vi.fn(async () => ({ data: { user: { id: "tenant-a", email: "a@example.test" } } })) },
      from: vi.fn(() => credentialQuery),
    },
    serviceDb: { rpc: vi.fn(async () => ({ error: null })), from: vi.fn(serviceFrom) },
    createDirectAgent: vi.fn(async (_db: unknown, _userId: string, input: { name: string; keyName: string }) => ({
      ok: true as const,
      value: { agentId: "agent-1", keyId: "key-1", key: `pc_agent_${"K".repeat(43)}`, name: input.name, keyName: input.keyName, expiresAt: null },
    })),
    recordAdminAction: vi.fn(async () => undefined),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => m.db }));
vi.mock("@/lib/supabase", () => ({ serviceClient: vi.fn(() => m.serviceDb) }));
vi.mock("@/lib/mfa", () => ({ mfaAuthorizedUser: vi.fn(async () => ({ ok: true, user: { id: "tenant-a" } })) }));
vi.mock("@/lib/profile/manage", () => ({ ensureProfileRow: vi.fn(async () => undefined) }));
vi.mock("@/lib/fleet", () => ({ createDirectAgent: m.createDirectAgent, createAgent: vi.fn(), setTenantKill: vi.fn(), setAgentSuspended: vi.fn() }));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: vi.fn(async () => ({ success: true, remaining: 4 })),
  rateLimitFailClosed: vi.fn(async () => ({ success: true, remaining: 4 })),
}));
vi.mock("@/lib/state/redis", () => ({
  stashKeyImport: vi.fn(),
  takeKeyImport: vi.fn(),
  purgeProviderKeysCache: vi.fn(async () => {}),
  purgeAgentCaches: vi.fn(async () => {}),
  purgeAgentFallbacks: vi.fn(async () => {}),
}));
vi.mock("@/lib/audit", () => ({ recordAdminAction: m.recordAdminAction }));
vi.mock("@/lib/seclog", () => ({ logSecurityEvent: vi.fn() }));
vi.mock("@/lib/alert", () => ({ dispatchSecurityAlert: vi.fn() }));
vi.mock("@/lib/apikeys", () => ({ generateApiKey: vi.fn() }));

import { issueDirectAgent } from "@/app/dashboard/actions-client";

const servicesWorker = {
  name: "messenger",
  keyName: "My installation",
  scopes: [],
  services: [{ service: "telegram", checked: ["read", "send"], askWrites: true }],
};

beforeEach(() => {
  vi.clearAllMocks();
  m.updates.length = 0;
  m.state.updateError = null;
});

describe("creating an agent with service access", () => {
  it("writes the rules to the new agent, by id AND owner, and records it", async () => {
    const issued = await issueDirectAgent(servicesWorker);
    expect(issued).toMatchObject({ agentId: "agent-1", servicesGranted: ["telegram"], servicesSaved: true });
    expect(m.updates).toHaveLength(1);
    expect(m.updates[0]!.values).toEqual({
      service_rules: {
        telegram: { allow: [{ call: "getMe" }, { call: "getUpdates" }, { call: "sendMessage", ask: true }] },
      },
    });
    expect(m.updates[0]!.filters).toEqual(expect.arrayContaining([["id", "agent-1"], ["user_id", "tenant-a"]]));
    expect(m.recordAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.service_rules", targetId: "agent-1", metadata: expect.objectContaining({ service: "telegram", ask: 1 }) })
    );
  });

  it("refuses bad choices before creating anything", async () => {
    await expect(
      issueDirectAgent({ ...servicesWorker, services: [{ service: "telegram", checked: ["nope"], askWrites: false }] })
    ).rejects.toThrow(/service access/i);
    expect(m.createDirectAgent).not.toHaveBeenCalled();
  });

  it("still returns the reveal-once key when the rules could not be saved, and says so", async () => {
    m.state.updateError = { code: "XX000" };
    const issued = await issueDirectAgent(servicesWorker);
    expect(issued.key).toMatch(/^pc_agent_/);
    expect(issued).toMatchObject({ servicesGranted: [], servicesSaved: false });
  });

  it("writes nothing when no service is ticked", async () => {
    const issued = await issueDirectAgent({ ...servicesWorker, services: [] });
    expect(m.updates).toHaveLength(0);
    expect(issued).toMatchObject({ servicesGranted: [], servicesSaved: true });
  });
});
