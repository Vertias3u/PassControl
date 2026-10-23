import { beforeEach, describe, expect, it, vi } from "vitest";

// An account limit has two windows that ask for opposite things: the live limit
// wants an agent revoked, the daily one wants a wait. lib/fleet says which in its
// sentence, and `passcontrol login` (the main caller of POST /agents) prints the
// control API's message. The route used to answer only the generic line, so a
// user who had hit the DAILY limit was told to revoke an agent.
const authMock = vi.fn();
const createAgentMock = vi.fn();
vi.mock("@/lib/control/auth", () => ({ authenticateApiKey: (...a: unknown[]) => authMock(...a) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: async () => ({ success: true, remaining: 1 }) }));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({}) }));
vi.mock("@/lib/audit", () => ({ recordAdminAction: async () => {} }));
vi.mock("@/lib/fleet", () => ({ createAgent: (...a: unknown[]) => createAgentMock(...a) }));

import { POST } from "@/app/api/control/v1/agents/route";
import { errorResponse } from "@/lib/control/respond";

const post = () =>
  POST(
    new Request("https://x/api/control/v1/agents", {
      method: "POST",
      headers: { authorization: "Bearer pc_" + "a".repeat(40), "content-type": "application/json" },
      body: JSON.stringify({ name: "scout", passportPubkey: "A".repeat(43) }),
    })
  );

beforeEach(() => {
  authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "write", keyId: "k1" });
  createAgentMock.mockReset();
});

describe("POST /agents names WHICH account limit was hit", () => {
  it("passes the daily-limit sentence through", async () => {
    createAgentMock.mockResolvedValue({
      ok: false,
      status: 409,
      code: "account_limit_reached",
      message: "Too many agents were created in the last 24 hours (the limit is 3). Try again later.",
    });
    const res = await post();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("account_limit_reached");
    expect(body.error.message).toBe("Too many agents were created in the last 24 hours (the limit is 3). Try again later.");
  });

  it("keeps the generic message for any other refusal's detail", async () => {
    createAgentMock.mockResolvedValue({ ok: false, status: 422, code: "invalid_request", message: "scopes[0].provider: internal parser detail" });
    const body = await (await post()).json();
    expect(body.error.message).toBe("The request body is invalid.");
  });
});

describe("errorResponse's detail", () => {
  it("is used only for a code whose detail is safe to show", async () => {
    const shown = await errorResponse(409, "account_limit_reached", "r", {}, "limit sentence").json();
    expect(shown.error.message).toBe("limit sentence");
    const hidden = await errorResponse(500, "query_failed", "r", {}, "relation public.x does not exist").json();
    expect(hidden.error.message).toBe("The request could not be completed. Please try again.");
  });
});
