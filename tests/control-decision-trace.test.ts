import { beforeEach, describe, expect, it, vi } from "vitest";

const { authMock, rateLimitMock, traceMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  rateLimitMock: vi.fn(),
  traceMock: vi.fn(),
}));

vi.mock("@/lib/control/auth", () => ({
  authenticateApiKey: (...args: unknown[]) => authMock(...args),
}));
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: (...args: unknown[]) => rateLimitMock(...args),
}));
vi.mock("@/lib/supabase", () => ({ serviceClient: () => ({ tag: "db" }) }));
vi.mock("@/app/api/control/v1/agents/[id]/trace/decision-trace", () => ({
  evaluateDecisionTrace: (...args: unknown[]) => traceMock(...args),
}));

import { POST } from "@/app/api/control/v1/agents/[id]/trace/route";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";

function request(body: unknown) {
  return new Request(`https://gateway.test/api/control/v1/agents/${AGENT_ID}/trace`, {
    method: "POST",
    headers: {
      authorization: `Bearer pc_${"a".repeat(40)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  authMock.mockReset();
  rateLimitMock.mockReset();
  traceMock.mockReset();
  authMock.mockResolvedValue({ ok: true, userId: "u1", scope: "read", keyId: "k1" });
  rateLimitMock.mockResolvedValue({ success: true, remaining: 1 });
  traceMock.mockResolvedValue({
    ok: true,
    trace: {
      snapshot: true,
      evaluated_at: "2026-07-31T12:00:00.000Z",
      policy_time: "2026-07-31T12:00:00.000Z",
      verdict: "allow",
      steps: [],
    },
  });
});

describe("POST /api/control/v1/agents/{id}/trace", () => {
  it("uses an independent tenant-scoped limiter and returns a non-cacheable snapshot", async () => {
    const res = await POST(request({ provider: "openai", model: "gpt-4.1" }), {
      params: Promise.resolve({ id: AGENT_ID }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(rateLimitMock).toHaveBeenCalledWith("decision-trace:u1", 30, 60);
    expect(rateLimitMock.mock.calls.map(([key]) => key)).toEqual([
      "control-ip:unknown",
      "control:k1",
      "decision-trace:u1",
    ]);
    expect(rateLimitMock.mock.calls.flat().join(" ")).not.toMatch(
      /policy-hour|reserved|spent|nonce/
    );
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        db: { tag: "db" },
        userId: "u1",
        agentId: AGENT_ID,
        provider: "openai",
        model: "gpt-4.1",
      })
    );
  });

  it("does not run a trace when its independent limiter is exhausted", async () => {
    rateLimitMock
      .mockResolvedValueOnce({ success: true, remaining: 1 })
      .mockResolvedValueOnce({ success: true, remaining: 1 })
      .mockResolvedValueOnce({ success: false, remaining: 0 });

    const res = await POST(request({ provider: "openai", model: "gpt-4.1" }), {
      params: Promise.resolve({ id: AGENT_ID }),
    });

    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(traceMock).not.toHaveBeenCalled();
  });

  it("accepts an explicit UTC policy timestamp and rejects malformed input", async () => {
    const good = await POST(
      request({
        provider: "openai",
        model: "gpt-4.1",
        timestamp: "2026-07-28T10:30:00.000Z",
      }),
      { params: Promise.resolve({ id: AGENT_ID }) }
    );
    expect(good.status).toBe(200);
    expect(traceMock).toHaveBeenCalledWith(
      expect.objectContaining({ policyAt: new Date("2026-07-28T10:30:00.000Z") })
    );

    traceMock.mockClear();
    const bad = await POST(request({ provider: "unknown", model: "" }), {
      params: Promise.resolve({ id: AGENT_ID }),
    });
    expect(bad.status).toBe(400);
    expect(traceMock).not.toHaveBeenCalled();
  });

  it("preserves tenant-safe not-found instead of returning a trace", async () => {
    traceMock.mockResolvedValueOnce({ ok: false, status: 404, code: "not_found" });
    const res = await POST(request({ provider: "openai", model: "gpt-4.1" }), {
      params: Promise.resolve({ id: AGENT_ID }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });
});
