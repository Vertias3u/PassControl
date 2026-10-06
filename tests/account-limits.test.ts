// Turning 0076's refusal into a sentence, at every path that creates things.
// The database decides (tests/account-limits.db.test.ts); these pin that each
// caller says what happened instead of "Something went wrong" or a 500.
import { describe, expect, it, vi } from "vitest";

import { accountLimitFrom, accountLimitMessage } from "@/lib/account-limits";

const refusal = (message: string) => ({ code: "P0001", message });

describe("reading the database's refusal", () => {
  it("parses kind, window and limit", () => {
    expect(accountLimitFrom(refusal("account_limit_reached:agents:live:10"))).toEqual({
      kind: "agents",
      window: "live",
      limit: 10,
    });
    expect(accountLimitFrom(refusal("account_limit_reached:api_keys:daily:50"))).toEqual({
      kind: "api_keys",
      window: "daily",
      limit: 50,
    });
  });

  it("ignores every other error", () => {
    expect(accountLimitFrom(refusal("active_key_limit"))).toBeNull();
    expect(accountLimitFrom(refusal("account_limit_reached:robots:live:1"))).toBeNull();
    expect(accountLimitFrom(null)).toBeNull();
    expect(accountLimitFrom("account_limit_reached:agents:live:10")).toBeNull();
  });

  it("says one, not ones, at a limit of 1", () => {
    expect(accountLimitMessage({ kind: "credentials", window: "live", limit: 1 })).toMatch(/limit of 1 stored credential\./);
    expect(accountLimitMessage({ kind: "agents", window: "live", limit: 1 })).toMatch(/limit of 1 agent\./);
    expect(accountLimitMessage({ kind: "agent_keys", window: "live", limit: 1 })).toMatch(/1 active key,/);
    expect(accountLimitMessage({ kind: "api_keys", window: "live", limit: 1 })).toMatch(/1 active control-API key,/);
  });

  it("says what was hit and what to do, in plain words", () => {
    expect(accountLimitMessage({ kind: "agents", window: "live", limit: 10 })).toMatch(
      /limit of 10 agents.*revoke/i
    );
    expect(accountLimitMessage({ kind: "agent_keys", window: "live", limit: 3 })).toMatch(/3 active keys/i);
    expect(accountLimitMessage({ kind: "credentials", window: "live", limit: 10 })).toMatch(/10 stored/i);
    expect(accountLimitMessage({ kind: "api_keys", window: "live", limit: 10 })).toMatch(/passcontrol login/);
    expect(accountLimitMessage({ kind: "agents", window: "daily", limit: 50 })).toMatch(/last 24 hours/i);
  });
});

describe("lib/fleet create paths answer 409 with the sentence", () => {
  const limitError = refusal("account_limit_reached:agents:live:10");

  it("createAgent (passport agent insert)", async () => {
    const { createAgent } = await import("@/lib/fleet");
    const db = {
      from: () => ({
        insert: () => ({ select: () => ({ single: async () => ({ data: null, error: limitError }) }) }),
      }),
    };
    const result = await createAgent(db as never, "u1", {
      name: "scout",
      passportPubkey: "A".repeat(43),
      scopes: [{ provider: "openai", models: ["gpt-5-mini"] }],
    } as never);
    expect(result).toMatchObject({ ok: false, status: 409, code: "account_limit_reached" });
    expect((result as { message?: string }).message).toMatch(/limit of 10 agents/);
  });

  it("createDirectAgent and createAgentAccessKey (RPCs)", async () => {
    const { createDirectAgent, createAgentAccessKey } = await import("@/lib/fleet");
    const db = { rpc: vi.fn(async () => ({ data: null, error: refusal("account_limit_reached:agent_keys:live:3") })) };
    const direct = await createDirectAgent(db as never, "u1", {
      name: "scout",
      scopes: [{ provider: "openai", models: ["gpt-5-mini"] }],
      keyName: "k",
    } as never);
    expect(direct).toMatchObject({ ok: false, status: 409, code: "account_limit_reached" });

    const key = await createAgentAccessKey(db as never, "u1", "11111111-1111-4111-8111-111111111111", { name: "k" } as never);
    expect(key).toMatchObject({ ok: false, status: 409, code: "account_limit_reached" });
    expect((key as { message?: string }).message).toMatch(/3 active keys/);
  });
});

describe("the control API names the refusal", () => {
  it("has a message for account_limit_reached, not the generic one", async () => {
    const { errorResponse } = await import("@/lib/control/respond");
    const body = await errorResponse(409, "account_limit_reached", "req-1").json();
    expect(body.error.message).not.toBe("Request failed.");
    expect(body.error.message).toMatch(/limit/i);
  });
});
