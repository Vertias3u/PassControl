// The two dashboard mutations any-API phase 1 adds: storing a service token and
// setting an agent's service rules. Both change what an agent can reach, so both
// sit behind MFA step-up like every credential mutation, and both are validated
// here with the SAME parser the gateway uses — the editor is not the boundary
// (the gateway re-validates on read), but it must never write what the gateway
// would refuse, or an operator's save silently denies the whole service.
import { beforeEach, describe, expect, it, vi } from "vitest";

const AGENT = "11111111-1111-4111-8111-111111111111";
const TENANT = "tenant-a";

const h = vi.hoisted(() => ({
  gate: vi.fn(),
  rpc: vi.fn(),
  audit: vi.fn(),
  current: { value: null as unknown },
  readError: { value: null as unknown },
  updates: [] as { values: Record<string, unknown>; filters: [string, unknown][] }[],
  updatedRows: { value: [{ id: "11111111-1111-4111-8111-111111111111" }] as unknown[] },
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => ({}) }));
vi.mock("@/lib/mfa", () => ({ mfaAuthorizedUser: (...a: unknown[]) => h.gate(...a) }));
vi.mock("@/lib/audit", () => ({ recordAdminAction: (...a: unknown[]) => h.audit(...a) }));
vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    rpc: (...a: unknown[]) => h.rpc(...a),
    from: () => {
      const filters: [string, unknown][] = [];
      let values: Record<string, unknown> | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        update: (v: Record<string, unknown>) => {
          values = v;
          return chain;
        },
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return chain;
        },
        maybeSingle: async () =>
          h.readError.value
            ? { data: null, error: h.readError.value }
            : { data: h.current.value === undefined ? null : { service_rules: h.current.value }, error: null },
        then: (resolve: (v: unknown) => void) => {
          if (values) h.updates.push({ values, filters: [...filters] });
          resolve({ data: h.updatedRows.value, error: null });
        },
      };
      return chain;
    },
  }),
}));

import { addServiceToken, setAgentServiceRules } from "@/app/dashboard/service-actions";

beforeEach(() => {
  vi.clearAllMocks();
  h.updates.length = 0;
  h.current.value = null;
  h.readError.value = null;
  h.updatedRows.value = [{ id: AGENT }];
  h.gate.mockResolvedValue({ ok: true, user: { id: TENANT } });
  h.rpc.mockResolvedValue({ data: "credential-id", error: null });
});

describe("addServiceToken", () => {
  it("stores the token under the namespaced provider through the Vault RPC", async () => {
    const result = await addServiceToken({ service: "github", label: "ci-bot", token: "  github_pat_example_0123456789  " });
    expect(result.error).toBeUndefined();
    expect(h.rpc).toHaveBeenCalledWith("store_provider_key_for_user", {
      p_user_id: TENANT,
      p_provider: "svc:github",
      p_label: "ci-bot",
      p_plaintext: "github_pat_example_0123456789",
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "provider_key.add", metadata: { provider: "svc:github", label: "ci-bot" } })
    );
    // The token never reaches the audit trail.
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain("github_pat_example");
  });

  it("requires MFA step-up, and stores nothing without it", async () => {
    h.gate.mockResolvedValue({ ok: false, reason: "step_up_required" });
    const result = await addServiceToken({ service: "github", label: "", token: "github_pat_x" });
    expect(result.error).toMatch(/two-factor/i);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown service", { service: "slack", label: "", token: "xoxb-1" }],
    ["an empty token", { service: "github", label: "", token: "   " }],
    ["an oversized token", { service: "github", label: "", token: "g".repeat(501) }],
    ["an oversized label", { service: "github", label: "l".repeat(81), token: "github_pat_x" }],
  ])("refuses %s before anything is stored", async (_label, input) => {
    const result = await addServiceToken(input);
    expect(result.error).toBeTruthy();
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("never echoes a database error, which could carry the submitted token", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "XX000", message: "bad: github_pat_secret_value" } });
    const result = await addServiceToken({ service: "github", label: "", token: "github_pat_secret_value" });
    expect(result.error).not.toContain("github_pat_secret_value");
  });
});

describe("setAgentServiceRules", () => {
  const rules = [
    { method: "GET", path: "/repos/acme/*/issues" },
    { method: "GET", path: "/user" },
  ];

  it("writes a valid rule set to this tenant's agent, by id AND owner", async () => {
    const result = await setAgentServiceRules(AGENT, "github", { allow: rules, maxRequestsPerHour: 100 });
    expect(result.error).toBeUndefined();
    const write = h.updates.at(-1)!;
    expect(write.values).toEqual({
      service_rules: { github: { allow: rules, max_requests_per_hour: 100 } },
    });
    expect(write.filters).toEqual(expect.arrayContaining([["id", AGENT], ["user_id", TENANT]]));
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent.service_rules",
        targetType: "agent",
        targetId: AGENT,
        metadata: { service: "github", rules: 2, max_requests_per_hour: 100 },
      })
    );
  });

  it("omits the cap when none is given, so the gateway's documented default applies", async () => {
    await setAgentServiceRules(AGENT, "github", { allow: rules, maxRequestsPerHour: null });
    expect(h.updates.at(-1)!.values).toEqual({ service_rules: { github: { allow: rules } } });
  });

  it("keeps the agent's rules for other services untouched", async () => {
    h.current.value = { slack: { allow: [] } };
    await setAgentServiceRules(AGENT, "github", { allow: rules, maxRequestsPerHour: null });
    expect(h.updates.at(-1)!.values).toEqual({
      service_rules: { slack: { allow: [] }, github: { allow: rules } },
    });
  });

  it("clears access with an empty rule list: deny, stated", async () => {
    await setAgentServiceRules(AGENT, "github", { allow: [], maxRequestsPerHour: null });
    expect(h.updates.at(-1)!.values).toEqual({ service_rules: { github: { allow: [] } } });
  });

  it("saves exact write rules (phase 2)", async () => {
    const writes = [
      { method: "POST", path: "/repos/acme/*/issues" },
      { method: "PATCH", path: "/repos/acme/web/issues/*" },
    ];
    const result = await setAgentServiceRules(AGENT, "github", { allow: writes, maxRequestsPerHour: null });
    expect(result.error).toBeUndefined();
    expect(h.updates.at(-1)!.values).toEqual({ service_rules: { github: { allow: writes } } });
  });

  it("says why a write with ** is refused, and writes nothing", async () => {
    const result = await setAgentServiceRules(AGENT, "github", {
      allow: [{ method: "POST", path: "/repos/acme/**" }],
      maxRequestsPerHour: null,
    });
    expect(result.error).toMatch(/\*\*.*read|exact/i);
    expect(h.updates).toHaveLength(0);
  });

  it("refuses a write rule that could only ever reach the never list, naming it", async () => {
    const result = await setAgentServiceRules(AGENT, "github", {
      allow: [{ method: "DELETE", path: "/repos/*/*" }],
      maxRequestsPerHour: null,
    });
    expect(result.error).toMatch(/DELETE \/repos\/\*\/\*/);
    expect(result.error).toMatch(/Deleting a repository/);
    expect(h.updates).toHaveLength(0);
  });

  it.each([
    ["a method the gateway does not know", [{ method: "OPTIONS", path: "/user" }], null],
    ["a path without a slash", [{ method: "GET", path: "user" }], null],
    ["a partial wildcard", [{ method: "GET", path: "/repos/acme-*/x" }], null],
    ["a zero cap", [{ method: "GET", path: "/user" }], 0],
  ])("refuses %s rather than writing what the gateway would deny", async (_label, allow, cap) => {
    const result = await setAgentServiceRules(AGENT, "github", { allow, maxRequestsPerHour: cap as number | null });
    expect(result.error).toBeTruthy();
    expect(h.updates).toHaveLength(0);
  });

  it("requires MFA step-up", async () => {
    h.gate.mockResolvedValue({ ok: false, reason: "step_up_required" });
    const result = await setAgentServiceRules(AGENT, "github", { allow: rules, maxRequestsPerHour: null });
    expect(result.error).toMatch(/two-factor/i);
    expect(h.updates).toHaveLength(0);
  });

  it("refuses a malformed agent id and an unknown service", async () => {
    expect((await setAgentServiceRules("nope", "github", { allow: rules, maxRequestsPerHour: null })).error).toBeTruthy();
    expect((await setAgentServiceRules(AGENT, "slack", { allow: rules, maxRequestsPerHour: null })).error).toBeTruthy();
    expect(h.updates).toHaveLength(0);
  });

  it("says so when the agent is not this tenant's", async () => {
    h.current.value = undefined; // no row for (id, owner)
    const result = await setAgentServiceRules(AGENT, "github", { allow: rules, maxRequestsPerHour: null });
    expect(result.error).toMatch(/could not be found/);
    expect(h.updates).toHaveLength(0);
  });

  it("refuses to save over rules it could not read", async () => {
    h.readError.value = { code: "57014" };
    const result = await setAgentServiceRules(AGENT, "github", { allow: rules, maxRequestsPerHour: null });
    expect(result.error).toBeTruthy();
    expect(h.updates).toHaveLength(0);
  });
});

describe("Telegram in the dashboard actions", () => {
  const TG = "123456789:AAH4dGVzdC10b2tlbi1mb3ItcGFzc2NvbnRyb2w";

  it("stores a bot token under svc:telegram", async () => {
    const result = await addServiceToken({ service: "telegram", label: "alerts bot", token: TG });
    expect(result.error).toBeUndefined();
    expect(h.rpc).toHaveBeenCalledWith("store_provider_key_for_user", expect.objectContaining({ p_provider: "svc:telegram", p_plaintext: TG }));
  });

  it("refuses a token that is not bot-token shaped, without echoing it", async () => {
    const bad = "123:abc/../../x";
    const result = await addServiceToken({ service: "telegram", label: "", token: bad });
    expect(result.error).toMatch(/Telegram bot token/);
    expect(result.error).not.toContain(bad);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("saves method-name rules in Telegram's shape", async () => {
    const result = await setAgentServiceRules(AGENT, "telegram", {
      allow: [{ method: "CALL", path: "sendMessage" }, { method: "CALL", path: "getMe" }],
      maxRequestsPerHour: 30,
    });
    expect(result.error).toBeUndefined();
    expect(h.updates.at(-1)!.values).toEqual({
      service_rules: { telegram: { allow: [{ call: "sendMessage" }, { call: "getMe" }], max_requests_per_hour: 30 } },
    });
  });

  it("refuses a rule for a method that is never allowed, naming why", async () => {
    const result = await setAgentServiceRules(AGENT, "telegram", {
      allow: [{ method: "CALL", path: "setWebhook" }],
      maxRequestsPerHour: null,
    });
    expect(result.error).toMatch(/setWebhook is never allowed/);
    expect(h.updates).toHaveLength(0);
  });

  it("refuses a method name that is not one", async () => {
    const result = await setAgentServiceRules(AGENT, "telegram", {
      allow: [{ method: "CALL", path: "send*" }],
      maxRequestsPerHour: null,
    });
    expect(result.error).toMatch(/method name/i);
    expect(h.updates).toHaveLength(0);
  });
});
