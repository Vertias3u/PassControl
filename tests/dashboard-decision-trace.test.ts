import { beforeEach, describe, expect, it, vi } from "vitest";

const { userClientMock, needsMfaStepUpMock, rateLimitMock, traceMock } = vi.hoisted(() => ({
  userClientMock: vi.fn(),
  needsMfaStepUpMock: vi.fn(),
  rateLimitMock: vi.fn(),
  traceMock: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ userClient: () => userClientMock() }));
vi.mock("@/lib/mfa", () => ({ needsMfaStepUp: (...args: unknown[]) => needsMfaStepUpMock(...args) }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: (...args: unknown[]) => rateLimitMock(...args) }));
vi.mock("@/app/api/control/v1/agents/[id]/trace/decision-trace", () => ({
  evaluateDecisionTrace: (...args: unknown[]) => traceMock(...args),
}));

import { runDecisionTrace } from "@/app/dashboard/agents/[id]/trace-action";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
const db = {
  auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1" } } })) },
  from: vi.fn(),
};

beforeEach(() => {
  userClientMock.mockReset();
  needsMfaStepUpMock.mockReset();
  rateLimitMock.mockReset();
  traceMock.mockReset();
  db.auth.getUser.mockClear();
  userClientMock.mockResolvedValue(db);
  needsMfaStepUpMock.mockResolvedValue(false);
  rateLimitMock.mockResolvedValue({ success: true, remaining: 29 });
  traceMock.mockResolvedValue({
    ok: true,
    trace: {
      snapshot: true,
      evaluated_at: "2026-07-31T12:00:00.000Z",
      policy_time: "2026-07-28T10:30:00.000Z",
      verdict: "allow",
      steps: [],
    },
  });
});

describe("dashboard decision trace action", () => {
  it("uses the same tenant trace limiter and parses the optional UTC policy time", async () => {
    const form = new FormData();
    form.set("provider", "openai");
    form.set("model", "gpt-4.1");
    form.set("timestamp", "2026-07-28T10:30");

    const result = await runDecisionTrace(AGENT_ID, undefined, form);

    expect(rateLimitMock).toHaveBeenCalledWith("decision-trace:u1", 30, 60);
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        userId: "u1",
        agentId: AGENT_ID,
        provider: "openai",
        model: "gpt-4.1",
        policyAt: new Date("2026-07-28T10:30:00.000Z"),
      })
    );
    expect(result.trace?.snapshot).toBe(true);
  });

  it("rejects an unauthenticated action before rate limiting or state reads", async () => {
    db.auth.getUser.mockResolvedValueOnce({ data: { user: null } } as any);
    const result = await runDecisionTrace(AGENT_ID, undefined, new FormData());
    expect(result).toEqual({ error: "Sign in again to run a decision trace." });
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(traceMock).not.toHaveBeenCalled();
  });
});
