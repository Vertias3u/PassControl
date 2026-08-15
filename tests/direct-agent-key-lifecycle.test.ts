import { describe, expect, it, vi } from "vitest";

import {
  attachAgentPassport,
  createAgentAccessKey,
  createDirectAgent,
  revokeAgentAccessKey,
} from "@/lib/fleet";
import { randomBytes } from "node:crypto";
import {
  DIRECT_AGENT_KEY_PREFIX,
  isDirectAgentKey,
} from "@/lib/auth/direct-key";

const directInput = {
  name: "build-bot",
  scopes: [{ provider: "openai", models: ["gpt-5*"] }],
  budget_tokens: 50_000,
  budget_cents: 1_000,
  keyName: "local workstation",
  expiresAt: null,
};

describe("Direct Agent Key lifecycle", () => {
  it("creates a direct-first agent atomically and reveals the raw key only in memory", async () => {
    const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({
      data: [{ agent_id: "agent-1", key_id: "key-1" }],
      error: null,
    }));

    const result = await createDirectAgent({ rpc } as never, "user-1", directInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.key).toMatch(/^pc_agent_[A-Za-z0-9_-]{43}$/);
    expect(result.value.key.startsWith(DIRECT_AGENT_KEY_PREFIX)).toBe(true);
    expect(result.value).toMatchObject({
      agentId: "agent-1",
      keyId: "key-1",
      name: "build-bot",
      keyName: "local workstation",
      expiresAt: null,
    });

    const args = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0]?.[0]).toBe("create_direct_agent");
    expect(args.p_key_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(args.p_key_suffix).toBe(result.value.key.slice(-8));
    expect(JSON.stringify(args)).not.toContain(result.value.key);
  });

  it("adds another installation key without imposing a per-agent key cap", async () => {
    const rpc = vi.fn(async () => ({ data: [{ key_id: "key-2" }], error: null }));

    const result = await createAgentAccessKey({ rpc } as never, "user-1", "agent-1", {
      name: "CI runner",
      expiresAt: "2027-01-01T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isDirectAgentKey(result.value.key)).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      "create_agent_access_key",
      expect.objectContaining({
        p_user_id: "user-1",
        p_agent_id: "agent-1",
        p_name: "CI runner",
        p_expires_at: "2027-01-01T00:00:00.000Z",
      })
    );
  });

  it("rejects invalid metadata before generating or persisting a credential", async () => {
    const rpc = vi.fn();
    await expect(
      createAgentAccessKey({ rpc } as never, "user-1", "agent-1", {
        name: " ",
        expiresAt: null,
      })
    ).resolves.toMatchObject({ ok: false, status: 422, code: "invalid_request" });
    expect(rpc).not.toHaveBeenCalled();

    await expect(
      createDirectAgent({ rpc } as never, "user-1", {
        ...directInput,
        expiresAt: "2020-01-01T00:00:00.000Z",
      })
    ).resolves.toMatchObject({ ok: false, status: 422, code: "invalid_request" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("maps the workspace cap and unknown-agent results without leaking database details", async () => {
    const capped = {
      rpc: vi.fn(async () => ({ data: null, error: { code: "P0001", message: "active_key_limit" } })),
    };
    await expect(
      createAgentAccessKey(capped as never, "user-1", "agent-1", {
        name: "runner",
        expiresAt: null,
      })
    ).resolves.toMatchObject({ ok: false, status: 409, code: "active_key_limit" });

    const missing = { rpc: vi.fn(async () => ({ data: [], error: null })) };
    await expect(
      createAgentAccessKey(missing as never, "user-1", "agent-1", {
        name: "runner",
        expiresAt: null,
      })
    ).resolves.toMatchObject({ ok: false, status: 404, code: "not_found" });
  });

  it("revokes by tenant, agent, and key id through one atomic RPC", async () => {
    const rpc = vi.fn(async () => ({
      data: [{ key_id: "key-1", key_suffix: "AbCd1234", key_name: "CI" }],
      error: null,
    }));

    const result = await revokeAgentAccessKey(
      { rpc } as never,
      "user-1",
      "agent-1",
      "key-1"
    );

    expect(result).toEqual({
      ok: true,
      value: { keyId: "key-1", suffix: "AbCd1234", name: "CI" },
    });
    expect(rpc).toHaveBeenCalledWith("revoke_agent_access_key", {
      p_user_id: "user-1",
      p_agent_id: "agent-1",
      p_key_id: "key-1",
    });
  });

  it("attaches a signing passport in place without replacing the agent", async () => {
    const rpc = vi.fn(async () => ({ data: [{ agent_id: "agent-1" }], error: null }));
    const passportPubkey = randomBytes(32).toString("base64url");

    const result = await attachAgentPassport(
      { rpc } as never,
      "user-1",
      "agent-1",
      passportPubkey
    );

    expect(result).toEqual({ ok: true, value: { id: "agent-1", passportPubkey } });
    expect(rpc).toHaveBeenCalledWith("attach_agent_passport", {
      p_user_id: "user-1",
      p_agent_id: "agent-1",
      p_passport_pubkey: passportPubkey,
    });
  });
});
