import { beforeEach, describe, expect, it, vi } from "vitest";

const { insert, rpc, serviceClientMock, captureErrorMock } = vi.hoisted(() => ({
  insert: vi.fn(),
  rpc: vi.fn(),
  serviceClientMock: vi.fn(),
  captureErrorMock: vi.fn(),
}));

vi.mock("../lib/supabase", () => ({ serviceClient: () => serviceClientMock() }));
vi.mock("../lib/observability", () => ({
  captureError: (...args: unknown[]) => captureErrorMock(...args),
}));

import { mirrorSpend, writeLog } from "../lib/log";

beforeEach(() => {
  vi.clearAllMocks();
  serviceClientMock.mockReturnValue({
    from: vi.fn(() => ({ insert })),
    rpc,
  });
  captureErrorMock.mockResolvedValue(undefined);
});

describe("gateway accounting writes", () => {
  it("reports an authoritative agent_logs insert error instead of dropping it", async () => {
    insert.mockResolvedValue({ error: { message: "database unavailable" } });

    await writeLog({
      agentId: "agent-1",
      userId: "user-1",
      passportId: "passport-1",
      jti: "visa-1",
      provider: "openai",
      status: "ok",
    });

    expect(insert).toHaveBeenCalledTimes(2);
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        route: "lib.log.writeLog",
        agentId: "agent-1",
        jti: "visa-1",
        provider: "openai",
        code: "agent_log_insert_failed",
      })
    );
  });

  it("reports a failed spend mirror RPC instead of dropping it", async () => {
    rpc.mockResolvedValue({ error: { message: "database unavailable" } });

    await mirrorSpend("agent-1", 10, 20);

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        route: "lib.log.mirrorSpend",
        agentId: "agent-1",
        code: "spend_mirror_failed",
      })
    );
  });
});
