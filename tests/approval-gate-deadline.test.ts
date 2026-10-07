// "Ask me first" waits inside one gateway call, and an edge function must start
// its answer within 25 seconds. The wait itself is 15 s, but the Telegram
// long-poll inside it was cut off only 5 s after ITS OWN timeout, so a Telegram
// that hung ran the gate up to ~4 s past its deadline, then a last zero-second
// poll could add 5 s more. With the checks before it and a 3 s prompt send, that
// reached the 25 s limit. The wait must end at its deadline whatever Telegram does.
import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  poll: vi.fn(),
}));

vi.mock("@/lib/alerts/approvals", () => ({
  sendApprovalPrompt: vi.fn(async () => undefined),
  pollTelegramDecisions: m.poll,
}));
vi.mock("@/lib/state/approvals", () => ({
  checkApproval: vi.fn(async (_r: unknown, opts: { create: boolean }) =>
    opts.create ? { state: "created", id: "a" } : { state: "pending", id: "a" }
  ),
}));

import { awaitApproval } from "@/lib/approvals/gate";

// A Telegram that never answers: the poll ends only when its abort fires, at
// the cap it was given, or at the old (wait + 5) s when it was given none.
m.poll.mockImplementation(async (_user: string, waitSeconds: number, maxMs?: number) => {
  const wait = Math.max(0, Math.floor(waitSeconds));
  const abortAt = Math.min((wait + 5) * 1000, maxMs ?? Infinity);
  await new Promise((resolve) => setTimeout(resolve, abortAt));
  return { state: "error" };
});

const request = { userId: "u", agentId: "g", service: "discord", method: "POST", path: "/x", bodyHash: "h" };

describe("awaitApproval's deadline", () => {
  it("ends at its wait even when Telegram hangs", { timeout: 15_000 }, async () => {
    const started = Date.now();
    const outcome = await awaitApproval({ request: request as never, prompt: {} as never, waitMs: 1_500 });
    const elapsed = Date.now() - started;
    expect(outcome).toEqual({ state: "pending" });
    expect(elapsed).toBeLessThan(1_500 + 400);
  });

  it("hands Telegram a cap no later than the deadline", { timeout: 15_000 }, async () => {
    m.poll.mockClear();
    await awaitApproval({ request: request as never, prompt: {} as never, waitMs: 1_200 });
    for (const call of m.poll.mock.calls) {
      expect(call[2]).toBeTypeOf("number");
      expect(call[2]).toBeLessThanOrEqual(1_200);
    }
  });
});
