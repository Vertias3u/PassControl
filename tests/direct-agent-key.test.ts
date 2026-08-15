import { describe, expect, it, vi } from "vitest";

import {
  DIRECT_AGENT_KEY_PREFIX,
  authenticateDirectAgentKey,
  classifyGatewayCredential,
  directAgentKeyHash,
  generateDirectAgentKey,
} from "@/lib/auth/direct-key";

describe("Direct Agent Key material", () => {
  it("generates a 256-bit, URL-safe credential in its own namespace", () => {
    const key = generateDirectAgentKey();
    expect(key).toMatch(/^pc_agent_[A-Za-z0-9_-]{43}$/);
    expect(key.startsWith(DIRECT_AGENT_KEY_PREFIX)).toBe(true);
  });

  it("hashes the complete credential deterministically without retaining it", () => {
    const key = `${DIRECT_AGENT_KEY_PREFIX}${"A".repeat(43)}`;
    expect(directAgentKeyHash(key)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(directAgentKeyHash(key)).toBe(directAgentKeyHash(key));
    expect(directAgentKeyHash(`${key.slice(0, -1)}B`)).not.toBe(directAgentKeyHash(key));
  });
});

describe("gateway credential classification", () => {
  it("recognises only exact-shape Direct Agent Keys", () => {
    expect(classifyGatewayCredential(`${DIRECT_AGENT_KEY_PREFIX}${"A".repeat(43)}`).kind).toBe(
      "direct_key"
    );
    expect(classifyGatewayCredential("pc_agent_short").kind).toBe("invalid");
    expect(classifyGatewayCredential(`pc_agent_${"A".repeat(42)}!`).kind).toBe("invalid");
  });

  it("continues to classify non-direct bearer material as a passport visa", () => {
    expect(classifyGatewayCredential("header.payload.signature")).toEqual({
      kind: "passport",
      token: "header.payload.signature",
    });
    expect(classifyGatewayCredential("")).toEqual({ kind: "missing" });
  });
});

describe("Direct Agent Key authentication", () => {
  it("uses one service-only RPC lookup and derives every tenant field from it", async () => {
    const rpc = vi.fn(async () => ({
      data: [
        {
          key_id: "key-1",
          agent_id: "agent-1",
          user_id: "user-1",
          allowed_scopes: [{ provider: "openai", models: ["gpt-*"] }],
          break_glass_scopes: [{ provider: "openai", models: ["gpt-5"] }],
          budget_tokens: 500,
          budget_cents: 200,
          spent_tokens: 20,
          spent_microcents: 30,
        },
      ],
      error: null,
    }));
    const key = `${DIRECT_AGENT_KEY_PREFIX}${"A".repeat(43)}`;

    const principal = await authenticateDirectAgentKey({ rpc } as never, key);

    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("authenticate_direct_agent_key", {
      p_key_hash: directAgentKeyHash(key),
    });
    expect(principal).toMatchObject({
      kind: "direct_key",
      keyId: "key-1",
      agentId: "agent-1",
      userId: "user-1",
      budgetTokens: 500,
      budgetCents: 200,
      spentTokens: 20,
      spentMicrocents: 30,
    });
    expect(principal?.scopes).toEqual([{ provider: "openai", models: ["gpt-*", "gpt-5"] }]);
  });

  it("fails closed on lookup errors and returns no principal for an unknown key", async () => {
    await expect(
      authenticateDirectAgentKey(
        { rpc: vi.fn(async () => ({ data: null, error: { message: "down" } })) } as never,
        `${DIRECT_AGENT_KEY_PREFIX}${"A".repeat(43)}`
      )
    ).rejects.toThrow("direct_key_lookup_failed");

    await expect(
      authenticateDirectAgentKey(
        { rpc: vi.fn(async () => ({ data: [], error: null })) } as never,
        `${DIRECT_AGENT_KEY_PREFIX}${"B".repeat(43)}`
      )
    ).resolves.toBeNull();
  });
});
