import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ getUser: vi.fn(), revoke: vi.fn(), audit: vi.fn(), db: {} }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: vi.fn(async () => new Headers()) }));
vi.mock("@/lib/supabase/server", () => ({ userClient: async () => ({ auth: { getUser: m.getUser } }) }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => m.db }));
vi.mock("@/lib/fleet", () => ({ revokeAgent: m.revoke }));
vi.mock("@/lib/audit", () => ({ recordAdminAction: m.audit }));
import { revokeAgent } from "@/app/dashboard/actions";
import { revokeAgent as clientRevoke } from "@/app/dashboard/actions-client";
import { revalidatePath } from "next/cache";
import { GENERIC_ACTION_ERROR } from "@/lib/action-result";
const ID = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  vi.clearAllMocks();
  m.getUser.mockResolvedValue({ data: { user: { id: "signed-in-owner" } } });
  m.revoke.mockResolvedValue({ ok: true, value: { id: ID } });
});
it("refuses without a signed-in user", async () => {
  m.getUser.mockResolvedValue({ data: { user: null } });
  expect(await revokeAgent(ID)).toEqual({ ok: false, error: GENERIC_ACTION_ERROR });
  expect(m.revoke).not.toHaveBeenCalled();
});
it("refuses a non-UUID", async () => {
  expect(await revokeAgent("not-an-id")).toMatchObject({ ok: false });
  expect(m.revoke).not.toHaveBeenCalled();
});
it("uses the signed-in owner, audits the dashboard revoke, and revalidates", async () => {
  expect(await clientRevoke(ID)).toEqual({ id: ID });
  expect(m.revoke).toHaveBeenCalledExactlyOnceWith(m.db, "signed-in-owner", ID);
  expect(m.audit).toHaveBeenCalledExactlyOnceWith({ userId: "signed-in-owner", action: "agent.revoke", targetType: "agent", targetId: ID, metadata: { via: "dashboard" } });
  for (const path of ["/", "/dashboard", `/dashboard/agents/${ID}`]) expect(revalidatePath).toHaveBeenCalledWith(path);
});
it.each(["returned", "thrown"])("hides internal detail for a %s failure", async (kind) => {
  if (kind === "returned") m.revoke.mockResolvedValue({ ok: false, status: 500, code: "secret database detail" });
  else m.revoke.mockRejectedValue(new Error("secret database detail"));
  expect(await revokeAgent(ID)).toEqual({ ok: false, error: GENERIC_ACTION_ERROR });
  expect(m.audit).not.toHaveBeenCalled();
});

it("refuses an unavailable or foreign-owned agent without auditing success", async () => {
  m.revoke.mockResolvedValue({ ok: false, status: 404, code: "not_found" });
  expect(await revokeAgent(ID)).toEqual({ ok: false, error: "This agent is unavailable." });
  expect(m.revoke).toHaveBeenCalledWith(m.db, "signed-in-owner", ID);
  expect(m.audit).not.toHaveBeenCalled();
});
