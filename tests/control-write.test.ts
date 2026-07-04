import { describe, it, expect, vi, beforeEach } from "vitest";

// Auth + rate limit + the fleet mutations are mocked; here we verify the write
// routes' wiring: write-scope enforcement, body validation, fleet dispatch,
// audit, and status/error mapping. (Fleet logic itself is covered in fleet.test.)
const { authMock, auditMock, createAgent, updateAgent, setAgentSuspended, revokeAgent, setTenantKill } = vi.hoisted(() => ({
  authMock: vi.fn(),
  auditMock: vi.fn(),
  createAgent: vi.fn(),
  updateAgent: vi.fn(),
  setAgentSuspended: vi.fn(),
  revokeAgent: vi.fn(),
  setTenantKill: vi.fn(),
}));
vi.mock("@/lib/control/auth", () => ({ authenticateApiKey: (...a: any[]) => authMock(...a) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({ tag: "db" }) }));
vi.mock("@/lib/audit", () => ({ recordAdminAction: (...a: any[]) => auditMock(...a) }));
vi.mock("@/lib/fleet", () => ({ createAgent, updateAgent, setAgentSuspended, revokeAgent, setTenantKill }));

import { POST as createRoute } from "@/app/api/control/v1/agents/route";
import { DELETE as revokeRoute, PATCH as updateRoute } from "@/app/api/control/v1/agents/[id]/route";
import { POST as suspendRoute } from "@/app/api/control/v1/agents/[id]/suspend/route";
import { PUT as killRoute } from "@/app/api/control/v1/kill-switch/route";

const UUID = "11111111-1111-1111-1111-111111111111";
const post = (url: string, body: unknown) =>
  new Request(url, {
    method: "POST",
    headers: { authorization: "Bearer pc_" + "a".repeat(40), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "write", keyId: "k1" });
});

describe("POST /agents (create)", () => {
  it("requires write scope (read key → 403, no mutation)", async () => {
    authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "read", keyId: "k1" });
    const res = await createRoute(post("https://x/api/control/v1/agents", { name: "b" }));
    expect(res.status).toBe(403);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("creates, audits with via=api, returns 201", async () => {
    createAgent.mockResolvedValue({ ok: true, value: { id: "a1", name: "bot" } });
    const res = await createRoute(post("https://x/api/control/v1/agents", { name: "bot" }));
    expect(res.status).toBe(201);
    expect(createAgent).toHaveBeenCalledWith({ tag: "db" }, "u1", { name: "bot" });
    expect((await res.json()).data).toMatchObject({ id: "a1" });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", action: "agent.create", metadata: expect.objectContaining({ via: "api", key_id: "k1" }) })
    );
  });

  it("maps a fleet validation failure to its status", async () => {
    createAgent.mockResolvedValue({ ok: false, status: 422, code: "invalid_request" });
    const res = await createRoute(post("https://x/api/control/v1/agents", {}));
    expect(res.status).toBe(422);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /agents/{id} (revoke)", () => {
  const del = () =>
    revokeRoute(new Request("https://x", { method: "DELETE", headers: { authorization: "Bearer pc_" + "a".repeat(40) } }), {
      params: Promise.resolve({ id: UUID }),
    });

  it("revokes and audits", async () => {
    revokeAgent.mockResolvedValue({ ok: true, value: { id: UUID } });
    const res = await del();
    expect(res.status).toBe(200);
    expect(revokeAgent).toHaveBeenCalledWith({ tag: "db" }, "u1", UUID);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "agent.revoke" }));
  });

  it("404 when not the caller's agent", async () => {
    revokeAgent.mockResolvedValue({ ok: false, status: 404, code: "not_found" });
    expect((await del()).status).toBe(404);
  });

  it("400 on a malformed id (no mutation)", async () => {
    const res = await revokeRoute(
      new Request("https://x", { method: "DELETE", headers: { authorization: "Bearer pc_" + "a".repeat(40) } }),
      { params: Promise.resolve({ id: "nope" }) }
    );
    expect(res.status).toBe(400);
    expect(revokeAgent).not.toHaveBeenCalled();
  });
});

describe("PATCH /agents/{id} (update)", () => {
  const patch = (body: unknown) =>
    updateRoute(
      new Request("https://x", {
        method: "PATCH",
        headers: { authorization: "Bearer pc_" + "a".repeat(40), "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: UUID }) }
    );

  it("updates and audits agent.update with the changed field names", async () => {
    updateAgent.mockResolvedValue({ ok: true, value: { id: UUID } });
    const res = await patch({ name: "renamed", budget_tokens: 1000 });
    expect(res.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith({ tag: "db" }, "u1", UUID, { name: "renamed", budget_tokens: 1000 });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.update", metadata: expect.objectContaining({ fields: "name,budget_tokens", via: "api" }) })
    );
  });

  it("maps an empty/invalid patch to its status", async () => {
    updateAgent.mockResolvedValue({ ok: false, status: 400, code: "empty_update" });
    expect((await patch({})).status).toBe(400);
  });
});

describe("POST /agents/{id}/suspend", () => {
  it("suspends and audits suspended=true", async () => {
    setAgentSuspended.mockResolvedValue({ ok: true, value: { id: UUID } });
    const res = await suspendRoute(post("https://x", {}), { params: Promise.resolve({ id: UUID }) });
    expect(res.status).toBe(200);
    expect(setAgentSuspended).toHaveBeenCalledWith({ tag: "db" }, "u1", UUID, true);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "agent.suspend", metadata: expect.objectContaining({ suspended: true, via: "api" }) })
    );
  });
});

describe("PUT /kill-switch", () => {
  const put = (body: unknown) =>
    killRoute(
      new Request("https://x/api/control/v1/kill-switch", {
        method: "PUT",
        headers: { authorization: "Bearer pc_" + "a".repeat(40), "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );

  it("arms the tenant kill switch and audits", async () => {
    setTenantKill.mockResolvedValue({ ok: true, value: { affected: 2 } });
    const res = await put({ armed: true });
    expect(res.status).toBe(200);
    expect(setTenantKill).toHaveBeenCalledWith({ tag: "db" }, "u1", true);
    expect((await res.json()).data).toEqual({ armed: true, affected: 2 });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "killswitch.master" }));
  });

  it("422 when 'armed' is not a boolean", async () => {
    const res = await put({ armed: "yes" });
    expect(res.status).toBe(422);
    expect(setTenantKill).not.toHaveBeenCalled();
  });
});
