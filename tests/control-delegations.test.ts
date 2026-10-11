// Bet D slice 8: the control API for an owner's delegations. Body validation, both
// revocation forms, the audit row, and errors passed through without detail.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ list: vi.fn(), revoke: vi.fn(), revokeAll: vi.fn(), audit: vi.fn(), alert: vi.fn() }));
vi.mock("@/lib/control/handler", () => ({
  control: (_scope: string, fn: (ctx: Record<string, unknown>) => Promise<Response>) =>
    async (req: Request, ctx: { params: Promise<Record<string, string>> }) =>
      fn({ req, userId: "user-1", db: {}, params: await ctx.params, keyId: "key-1", requestId: "req-1", scope: "write" }),
}));
vi.mock("@/lib/delegation/manage", async (orig) => ({
  ...(await orig<typeof import("@/lib/delegation/manage")>()),
  listDelegations: (...a: unknown[]) => m.list(...a),
  revokeAgentDelegation: (...a: unknown[]) => m.revoke(...a),
  revokeAllAgentDelegations: (...a: unknown[]) => m.revokeAll(...a),
}));
vi.mock("@/lib/audit", () => ({ recordAdminAction: (...a: unknown[]) => m.audit(...a) }));
vi.mock("@/lib/alert", () => ({ dispatchSecurityAlert: (...a: unknown[]) => m.alert(...a) }));
vi.mock("@/lib/seclog", () => ({ logSecurityEvent: () => {} }));

import { GET } from "@/app/api/control/v1/agents/[id]/delegations/route";
import { POST } from "@/app/api/control/v1/agents/[id]/delegations/revoke/route";

const AGENT = "11111111-1111-4111-8111-111111111111";
const JTI = "jti-0000000000000001";
const params = (id = AGENT) => ({ params: Promise.resolve({ id }) });
const revoke = (body: unknown, id = AGENT) =>
  POST(new Request(`https://gw.example/api/control/v1/agents/${id}/delegations/revoke`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }), params(id));

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.revoke.mockResolvedValue({ ok: true, immediate: true, passports: ["key-now"] });
  m.revokeAll.mockResolvedValue({ ok: true, immediate: true, validAfter: "2026-10-10T00:00:00.000Z", passports: ["key-now"] });
  m.list.mockResolvedValue({ ok: true, delegations: [{ jti: JTI, revoked: false }] });
});

describe("GET .../delegations", () => {
  it("lists the owner's agent's delegations", async () => {
    const res = await GET(new Request("https://gw.example/x"), params());
    expect(await res.json()).toMatchObject({ data: [{ jti: JTI, revoked: false }] });
    expect(m.list).toHaveBeenCalledWith({}, "user-1", AGENT);
  });
  it("refuses a malformed id and passes a 404 through", async () => {
    expect((await GET(new Request("https://gw.example/x"), params("nope"))).status).toBe(400);
    m.list.mockResolvedValue({ ok: false, status: 404, code: "agent_not_found" });
    expect((await GET(new Request("https://gw.example/x"), params())).status).toBe(404);
  });
});

describe("POST .../delegations/revoke", () => {
  it("revokes one delegation, audits it, and says whether the proxy sees it at once", async () => {
    const res = await revoke({ jti: JTI });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { id: AGENT, revoked: JTI, immediate: true } });
    expect(m.revoke).toHaveBeenCalledWith({}, "user-1", AGENT, JTI);
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "agent.delegation_revoke", targetId: AGENT, metadata: expect.objectContaining({ jti: JTI, all: false, passports: ["key-now"] }) }));
    expect(m.alert).toHaveBeenCalledWith("agent.delegation_revoke", expect.objectContaining({ agentId: AGENT }));
  });
  it("revokes everything before now with { all: true }", async () => {
    const res = await revoke({ all: true });
    expect(await res.json()).toMatchObject({ data: { revoked: "all_before_now" } });
    expect(m.revokeAll).toHaveBeenCalledWith({}, "user-1", AGENT);
    expect(m.revoke).not.toHaveBeenCalled();
    // P2.4: what the public revocation list publishes, fixed at the moment of the raise.
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent.delegation_revoke",
        metadata: expect.objectContaining({ all: true, valid_after: "2026-10-10T00:00:00.000Z", passports: ["key-now"] }),
      })
    );
  });
  it.each([[{}], [{ jti: JTI, all: true }], [{ all: "yes" }], ["not json"]])("refuses an ambiguous or malformed body %j", async (body) => {
    expect((await revoke(body)).status).toBe(400);
    expect(m.revoke).not.toHaveBeenCalled();
    expect(m.revokeAll).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });
  it("audits nothing when the revocation was not recorded", async () => {
    m.revoke.mockResolvedValue({ ok: false, status: 500, code: "revoke_failed" });
    const res = await revoke({ jti: JTI });
    expect(res.status).toBe(500);
    expect(m.audit).not.toHaveBeenCalled();
  });
});
