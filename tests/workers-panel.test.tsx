// The agent page's Workers view (Bet D; owner 2026-10-10: "start this"). The owner sees
// the delegations its workers have used and revokes one, or every delegation issued
// before now. Revoking is a safety action, so like suspend and session stop it never
// waits on an MFA step-up; it is rate-limited, audited and alerted like them, and a
// watermark raise records what the public revocation list publishes (P2.4).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// These status/action assertions exercise the view after its clock effect has run.
vi.mock("@/components/dashboard/useHydratedNow", () => ({ useHydratedNow: () => Date.now() }));

const m = vi.hoisted(() => ({
  getUser: vi.fn(),
  rateLimit: vi.fn(),
  revoke: vi.fn(),
  revokeAll: vi.fn(),
  audit: vi.fn(),
  alert: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => ({ auth: { getUser: m.getUser } }) }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({ service: true }) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...a: unknown[]) => m.rateLimit(...a) }));
vi.mock("@/lib/delegation/manage", async (orig) => ({
  ...(await orig<typeof import("@/lib/delegation/manage")>()),
  revokeAgentDelegation: (...a: unknown[]) => m.revoke(...a),
  revokeAllAgentDelegations: (...a: unknown[]) => m.revokeAll(...a),
}));
vi.mock("@/lib/audit", () => ({ recordAdminAction: (...a: unknown[]) => m.audit(...a) }));
vi.mock("@/lib/alert", () => ({ dispatchSecurityAlert: (...a: unknown[]) => m.alert(...a) }));
vi.mock("@/lib/seclog", () => ({ logSecurityEvent: () => {} }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { revokeDelegationAction, revokeAllDelegationsAction } = await import("@/app/dashboard/agents/[id]/delegation-actions");
const { WorkersPanel } = await import("@/components/WorkersPanel");
import type { DelegationListing } from "@/lib/delegation/manage";

const AGENT = "11111111-2222-4333-8444-555555555555";
const JTI = "Zq3k9VbX2mN8pL4tR7sW1y";

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  m.rateLimit.mockResolvedValue({ success: true });
  m.revoke.mockResolvedValue({ ok: true, immediate: true, passports: ["key-now"] });
  m.revokeAll.mockResolvedValue({ ok: true, immediate: true, validAfter: "2026-10-10T00:00:00.000Z", passports: ["key-now"] });
});

describe("revokeDelegationAction", () => {
  it("revokes one of the signed-in owner's delegations, audits and alerts it", async () => {
    expect(await revokeDelegationAction(AGENT, JTI)).toEqual({ ok: true, immediate: true });
    expect(m.revoke).toHaveBeenCalledWith({ service: true }, "user-1", AGENT, JTI);
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", action: "agent.delegation_revoke", targetId: AGENT, metadata: expect.objectContaining({ all: false, jti: JTI, passports: ["key-now"], via: "dashboard" }) })
    );
    expect(m.alert).toHaveBeenCalledWith("agent.delegation_revoke", expect.objectContaining({ agentId: AGENT, jti: JTI }));
  });

  it("refuses without a signed-in user", async () => {
    m.getUser.mockResolvedValue({ data: { user: null } });
    expect(await revokeDelegationAction(AGENT, JTI)).toMatchObject({ ok: false });
    expect(m.revoke).not.toHaveBeenCalled();
  });

  it.each([
    ["a malformed agent id", "nope", JTI],
    ["a malformed jti", AGENT, "x"],
  ])("refuses %s before any write", async (_label, agentId, jti) => {
    expect(await revokeDelegationAction(agentId, jti)).toMatchObject({ ok: false });
    expect(m.revoke).not.toHaveBeenCalled();
  });

  it("is rate-limited per owner", async () => {
    m.rateLimit.mockResolvedValue({ success: false });
    expect(await revokeDelegationAction(AGENT, JTI)).toMatchObject({ ok: false, error: expect.stringMatching(/too many/i) });
    expect(m.rateLimit).toHaveBeenCalledWith(expect.stringContaining("user-1"), expect.any(Number), expect.any(Number));
    expect(m.revoke).not.toHaveBeenCalled();
  });

  it("audits nothing when the revocation was not recorded", async () => {
    m.revoke.mockResolvedValue({ ok: false, status: 404, code: "agent_not_found" });
    expect(await revokeDelegationAction(AGENT, JTI)).toMatchObject({ ok: false });
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("passes on that the gateway could not apply it at once", async () => {
    m.revoke.mockResolvedValue({ ok: true, immediate: false, passports: ["key-now"] });
    expect(await revokeDelegationAction(AGENT, JTI)).toEqual({ ok: true, immediate: false });
  });
});

describe("revokeAllDelegationsAction", () => {
  it("raises the watermark and records what the public list publishes", async () => {
    expect(await revokeAllDelegationsAction(AGENT)).toEqual({ ok: true, immediate: true });
    expect(m.revokeAll).toHaveBeenCalledWith({ service: true }, "user-1", AGENT);
    expect(m.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "agent.delegation_revoke",
        metadata: expect.objectContaining({ all: true, valid_after: "2026-10-10T00:00:00.000Z", passports: ["key-now"], via: "dashboard" }),
      })
    );
  });

  it("refuses a malformed agent id before any write", async () => {
    expect(await revokeAllDelegationsAction("nope")).toMatchObject({ ok: false });
    expect(m.revokeAll).not.toHaveBeenCalled();
  });
});

const link = (over: Partial<DelegationListing> = {}): DelegationListing => ({
  jti: JTI,
  depth: 1,
  parent_jti: null,
  worker_key: "Wk7mYtq0aJ3n5xR2pL8sV4cE1uF6hG9iK0oP3dQ2bZA",
  cap_microcents: 1_000_000,
  scope: [{ provider: "anthropic", models: ["claude-haiku-5-5"] }],
  issued_at: "2026-10-10T12:00:00Z",
  expires_at: "2099-10-10T12:10:00Z",
  first_exchanged_at: "2026-10-10T12:00:05Z",
  revoked: false,
  ...over,
});
const render = (delegations: DelegationListing[] | null) =>
  renderToStaticMarkup(<WorkersPanel agentId={AGENT} delegations={delegations} />);

describe("the Workers view", () => {
  it("says what it can and cannot list: only delegations a worker has used", () => {
    const html = render([]);
    expect(html).toContain('data-state="empty"');
    expect(html).toMatch(/only delegations a worker has used/i);
  });

  it("offers revoke-all even when nothing is listed, because it reaches unseen delegations", () => {
    const html = render([]);
    expect(html).toContain('data-action="revoke-all"');
    expect(html).toMatch(/never used/i);
  });

  it("says so when the delegations could not be read", () => {
    const html = render(null);
    expect(html).toContain('data-state="unavailable"');
    expect(html).toMatch(/0081/);
  });

  it("shows an active link with its scope, cap and worker key, and a revoke button", () => {
    const html = render([link()]);
    expect(html).toContain(`data-delegation="${JTI}"`);
    expect(html).toContain('data-delegation-status="active"');
    expect(html).toContain("claude-haiku-5-5");
    expect(html).toContain("$0.01");
    expect(html).toContain("Wk7mYtq0aJ3n");
    expect(html).toContain('data-action="revoke-one"');
  });

  it("marks revoked and expired links and offers no revoke on them", () => {
    const html = render([link({ revoked: true }), link({ jti: "Aa1Bb2Cc3Dd4Ee5Ff6Gg7H", expires_at: "2020-01-01T00:00:00Z" })]);
    expect(html).toContain('data-delegation-status="revoked"');
    expect(html).toContain('data-delegation-status="expired"');
    expect(html).not.toContain('data-action="revoke-one"');
  });

  it("names a second-level link's parent", () => {
    const html = render([link({ jti: "Aa1Bb2Cc3Dd4Ee5Ff6Gg7H", depth: 2, parent_jti: JTI })]);
    expect(html).toContain(`under ${JTI}`);
  });

  it("says a revocation is permanent", () => {
    expect(render([link()])).toMatch(/permanent/i);
  });
});
